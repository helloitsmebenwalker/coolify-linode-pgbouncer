import { createHash } from 'node:crypto';

import { simpleParser, type Attachment, type AddressObject, type ParsedMail } from 'mailparser';

import { config } from './config.js';
import { withTransaction } from './db.js';
import type { MailStoredEvent } from './events.js';
import { onEmailStored } from './handlers.js';
import { archive } from './queue.js';
import { attachmentKey, getMessage, putAttachment } from './storage.js';
import type { MailDocument, StoredAttachment } from './types.js';

/**
 * One email, end to end: bucket → parse → rows → your handler → ack.
 *
 * The commit boundary is the whole point. The document rows, the attachment
 * rows, whatever `onEmailStored` writes, and the acknowledgement of the queue
 * message all land in a single transaction. Either the email is fully
 * processed and the message is gone from the queue, or nothing happened and it
 * comes back when the lease expires. There is no state in between for a crash
 * to strand.
 */

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const groups = Array.isArray(value) ? value : [value];
  return groups
    .flatMap((group) => group.value)
    .map((address) => address.address)
    .filter((address): address is string => Boolean(address));
}

function truncate(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > config.processing.maxBodyChars
    ? value.slice(0, config.processing.maxBodyChars)
    : value;
}

/**
 * Attachments are written to the bucket before the transaction opens, never
 * inside it: an S3 round-trip inside an open transaction holds a backend
 * connection for the duration, which is exactly what the PgBouncer pool exists
 * to prevent. A crash between the upload and the commit re-uploads identical
 * bytes to the identical key on retry.
 */
async function extractAttachments(
  event: MailStoredEvent,
  attachments: Attachment[],
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const content = attachment.content as Buffer;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const filename = attachment.filename ?? null;

    const record: StoredAttachment = {
      position: index,
      filename,
      contentType: attachment.contentType ?? null,
      sizeBytes: content.byteLength,
      sha256,
      contentId: attachment.cid ?? null,
      isInline: attachment.contentDisposition === 'inline',
      bucket: null,
      objectKey: null,
    };

    const tooBig = content.byteLength > config.processing.maxAttachmentBytes;
    if (config.processing.extractAttachments && !tooBig) {
      const key = attachmentKey(event.message.resourceId, index, filename ?? 'attachment');
      await putAttachment({
        bucket: event.object.bucket,
        key,
        body: content,
        contentType: attachment.contentType,
      });
      record.bucket = event.object.bucket;
      record.objectKey = key;
    }

    stored.push(record);
  }

  return stored;
}

function toDocument(event: MailStoredEvent, parsed: ParsedMail, mime: Buffer): MailDocument {
  const from = parsed.from?.value?.[0];

  return {
    resourceId: event.message.resourceId,
    mailbox: event.mailbox,
    // Prefer what the message itself says; fall back to Graph's view of it.
    internetMessageId: parsed.messageId ?? event.message.internetMessageId ?? null,
    subject: parsed.subject ?? event.message.subject ?? null,
    fromAddress: from?.address ?? event.message.from ?? null,
    fromName: from?.name || null,
    toAddresses: addressList(parsed.to) .length ? addressList(parsed.to) : event.message.to,
    ccAddresses: addressList(parsed.cc),
    sentAt: parsed.date ?? null,
    receivedAt: event.message.receivedAt ? new Date(event.message.receivedAt) : null,
    textBody: truncate(parsed.text),
    htmlBody: config.processing.storeHtml
      ? truncate(typeof parsed.html === 'string' ? parsed.html : null)
      : null,
    // headerLines is already flat strings, so it survives a jsonb round-trip
    // intact. `parsed.headers` is a Map of decoded objects and does not.
    headers: parsed.headerLines.map((header) => ({ key: header.key, line: header.line })),
    attachmentCount: parsed.attachments.length,
    sizeBytes: mime.byteLength,
    sha256: event.object.sha256,
    bucket: event.object.bucket,
    objectKey: event.object.key,
  };
}

export interface ProcessResult {
  resourceId: string;
  attachments: number;
  bytes: number;
}

export async function processEvent(event: MailStoredEvent, msgId: string): Promise<ProcessResult> {
  const mime = await getMessage({
    bucket: event.object.bucket,
    key: event.object.key,
    expectedSha256: event.object.sha256,
  });

  const parsed = await simpleParser(mime);
  const document = toDocument(event, parsed, mime);
  const attachments = await extractAttachments(event, parsed.attachments);

  await withTransaction(async (client) => {
    await client.query(
      `insert into mail_documents
         (resource_id, mailbox, internet_message_id, subject, from_address, from_name,
          to_addresses, cc_addresses, sent_at, received_at, text_body, html_body, headers,
          attachment_count, size_bytes, sha256, bucket, object_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)
       on conflict (resource_id) do update set
         mailbox = excluded.mailbox,
         internet_message_id = excluded.internet_message_id,
         subject = excluded.subject,
         from_address = excluded.from_address,
         from_name = excluded.from_name,
         to_addresses = excluded.to_addresses,
         cc_addresses = excluded.cc_addresses,
         sent_at = excluded.sent_at,
         received_at = excluded.received_at,
         text_body = excluded.text_body,
         html_body = excluded.html_body,
         headers = excluded.headers,
         attachment_count = excluded.attachment_count,
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256,
         bucket = excluded.bucket,
         object_key = excluded.object_key,
         processed_at = now()`,
      [
        document.resourceId,
        document.mailbox,
        document.internetMessageId,
        document.subject,
        document.fromAddress,
        document.fromName,
        document.toAddresses,
        document.ccAddresses,
        document.sentAt,
        document.receivedAt,
        document.textBody,
        document.htmlBody,
        JSON.stringify(document.headers),
        document.attachmentCount,
        document.sizeBytes,
        document.sha256,
        document.bucket,
        document.objectKey,
      ],
    );

    for (const attachment of attachments) {
      await client.query(
        `insert into mail_attachments
           (resource_id, position, filename, content_type, size_bytes, sha256,
            content_id, is_inline, bucket, object_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (resource_id, position) do update set
           filename = excluded.filename,
           content_type = excluded.content_type,
           size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256,
           content_id = excluded.content_id,
           is_inline = excluded.is_inline,
           bucket = excluded.bucket,
           object_key = excluded.object_key`,
        [
          document.resourceId,
          attachment.position,
          attachment.filename,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.sha256,
          attachment.contentId,
          attachment.isInline,
          attachment.bucket,
          attachment.objectKey,
        ],
      );
    }

    await onEmailStored({ event, document, attachments, parsed, mime }, client);

    // Last: the ack only commits if everything above did.
    await archive(msgId, client);
  });

  return {
    resourceId: document.resourceId,
    attachments: attachments.length,
    bytes: mime.byteLength,
  };
}
