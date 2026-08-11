import { createHash } from 'node:crypto';

import { HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { config, assertStorageConfigured } from './config.js';

/**
 * Linode Object Storage is S3-compatible, so the AWS SDK talks to it directly —
 * the only differences are a custom endpoint and a region that is really a
 * cluster id (`us-ord-1`). Virtual-hosted addressing works
 * (`<bucket>.us-ord-1.linodeobjects.com`); S3_FORCE_PATH_STYLE is there for
 * MinIO or an s3proxy in local testing.
 */
let client: S3Client | null = null;

function s3(): S3Client {
  if (client) return client;

  assertStorageConfigured();
  client = new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });
  return client;
}

/** Anything that could confuse a path or an S3 listing prefix. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 64) || 'unknown';
}

/**
 * Object key for a message.
 *
 * Date-partitioned so a listing can be bounded by day, and named by a hash of
 * the Graph message id rather than the id itself: those ids are base64-ish,
 * several hundred characters long, and contain characters that make for
 * miserable object keys. The mapping is recorded in mail_objects, so the key
 * is always reachable from the database rather than needing to be re-derived.
 */
export function objectKeyFor(input: {
  mailbox: string;
  resourceId: string;
  receivedAt?: Date;
}): string {
  const when = input.receivedAt ?? new Date();
  const yyyy = String(when.getUTCFullYear());
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(when.getUTCDate()).padStart(2, '0');
  const digest = createHash('sha256').update(input.resourceId).digest('hex').slice(0, 32);

  const parts = [config.storage.keyPrefix, slug(input.mailbox), yyyy, mm, dd, `${digest}.eml`];
  return parts.filter(Boolean).join('/');
}

export interface StoredObject {
  bucket: string;
  key: string;
  size: number;
  sha256: string;
  etag?: string;
}

/** ASCII-only, since S3 user metadata is carried in HTTP headers. */
function headerSafe(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').slice(0, 256).trim();
  return cleaned || undefined;
}

/**
 * Write the MIME message to the bucket.
 *
 * Idempotent by construction: the same message always produces the same key
 * and the same bytes, so a retried notification overwrites the object with
 * identical content rather than creating a duplicate.
 */
export async function putMessage(input: {
  key: string;
  body: Buffer;
  internetMessageId?: string;
  resourceId: string;
  mailbox: string;
}): Promise<StoredObject> {
  const sha256 = createHash('sha256').update(input.body).digest('hex');

  const metadata: Record<string, string> = { 'graph-sha256': sha256 };
  const internetMessageId = headerSafe(input.internetMessageId);
  if (internetMessageId) metadata['internet-message-id'] = internetMessageId;
  const mailbox = headerSafe(input.mailbox);
  if (mailbox) metadata['mailbox'] = mailbox;

  const result = await s3().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: 'message/rfc822',
      // Checked server-side: a truncated upload is rejected rather than stored.
      ChecksumSHA256: createHash('sha256').update(input.body).digest('base64'),
      Metadata: metadata,
    }),
  );

  return {
    bucket: config.storage.bucket,
    key: input.key,
    size: input.body.byteLength,
    sha256,
    etag: result.ETag?.replace(/"/g, ''),
  };
}

/** Used by /healthz to prove the credentials and bucket actually work. */
export async function checkBucket(): Promise<void> {
  await s3().send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
}

export function objectUrl(key: string): string {
  const base = config.storage.forcePathStyle
    ? `${config.storage.endpoint}/${config.storage.bucket}`
    : config.storage.endpoint.replace('://', `://${config.storage.bucket}.`);
  return `${base}/${key}`;
}
