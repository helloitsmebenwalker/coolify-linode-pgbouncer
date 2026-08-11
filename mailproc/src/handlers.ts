import type { PoolClient } from 'pg';
import type { ParsedMail } from 'mailparser';

import type { MailStoredEvent } from './events.js';
import type { MailDocument, StoredAttachment } from './types.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  This is where your logic goes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * By the time `onEmailStored` runs, the pipeline has already:
 *
 *   * pulled the raw .eml out of the bucket and verified its checksum
 *   * parsed it into `parsed` (headers, bodies, decoded attachments)
 *   * written `document` and its attachment rows
 *
 * It runs inside the transaction that commits those rows and acknowledges the
 * queue message, and it is handed that transaction's `client`. Two consequences
 * worth understanding before you write anything here:
 *
 *   * Anything you write through `client` commits atomically with the document
 *     and the ack. If you throw, all of it rolls back and the message becomes
 *     visible again — so a database-only handler is effectively exactly-once.
 *
 *   * Anything you do *outside* the database — calling an API, sending a
 *     message, charging a card — is not covered by that. Delivery is
 *     at-least-once, so external effects must be idempotent or keyed on
 *     `document.resourceId`, which is stable across every redelivery of the
 *     same email.
 *
 * Keep it quick. The transaction is open and the queue lease is ticking; long
 * work belongs on its own queue, enqueued from here.
 */
export async function onEmailStored(
  ctx: {
    event: MailStoredEvent;
    document: MailDocument;
    attachments: StoredAttachment[];
    parsed: ParsedMail;
    /** The raw RFC 5322 bytes, if you need something the parser dropped. */
    mime: Buffer;
  },
  client: PoolClient,
): Promise<void> {
  // Default: do nothing beyond the archive the pipeline already wrote.
  //
  // Examples of what tends to go here:
  //
  //   // Route by sender, and let a downstream service do the slow part
  //   if (ctx.document.fromAddress?.endsWith('@supplier.example')) {
  //     await client.query(
  //       `insert into mq_messages (queue, message) values ($1, $2::jsonb)`,
  //       ['invoice_extraction', JSON.stringify({ resourceId: ctx.document.resourceId })],
  //     );
  //   }
  //
  //   // Pull structured data out of the body
  //   const orderNumber = /Order #(\d+)/.exec(ctx.document.textBody ?? '')?.[1];
  //   if (orderNumber) {
  //     await client.query(
  //       `insert into orders_seen (resource_id, order_number) values ($1, $2)
  //        on conflict (resource_id) do nothing`,
  //       [ctx.document.resourceId, orderNumber],
  //     );
  //   }
  //
  //   // Hand a PDF attachment to something else
  //   const pdf = ctx.attachments.find((a) => a.contentType === 'application/pdf');
  //   if (pdf?.objectKey) { ... }
  void ctx;
  void client;
}
