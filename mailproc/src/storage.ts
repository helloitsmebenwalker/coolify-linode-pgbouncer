import { createHash } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { config, assertStorageConfigured } from './config.js';

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

export class ObjectMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectMismatchError';
  }
}

/**
 * A queue event is a claim, not a capability. Anything able to insert into
 * `mq_messages` could otherwise name a bucket of its choosing and have this
 * service read it with our credentials, so the bucket is checked against an
 * allow-list before the request is made.
 */
function assertBucketAllowed(bucket: string): void {
  const allowed = config.storage.allowedBuckets;
  if (allowed.length === 0) return;
  if (!allowed.includes(bucket)) {
    throw new ObjectMismatchError(`bucket ${bucket} is not in S3_ALLOWED_BUCKETS`);
  }
}

/**
 * Fetch the archived message.
 *
 * The event carries the sha256 mailhook computed before uploading, so a
 * truncated or substituted object is caught here rather than turning into a
 * half-parsed row downstream.
 */
export async function getMessage(input: {
  bucket: string;
  key: string;
  expectedSha256?: string;
}): Promise<Buffer> {
  assertBucketAllowed(input.bucket);

  const result = await s3().send(
    new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
  );

  if (!result.Body) throw new ObjectMismatchError(`empty body for ${input.bucket}/${input.key}`);

  const body = Buffer.from(await result.Body.transformToByteArray());

  if (config.processing.verifyChecksum && input.expectedSha256) {
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== input.expectedSha256) {
      throw new ObjectMismatchError(
        `checksum mismatch for ${input.bucket}/${input.key}: expected ${input.expectedSha256}, got ${actual}`,
      );
    }
  }

  return body;
}

/** Object key for an extracted attachment, grouped under its message. */
export function attachmentKey(resourceId: string, index: number, filename: string): string {
  const digest = createHash('sha256').update(resourceId).digest('hex').slice(0, 32);
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'attachment';
  return [config.storage.attachmentPrefix, digest, `${String(index).padStart(3, '0')}-${safe}`]
    .filter(Boolean)
    .join('/');
}

export async function putAttachment(input: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType?: string;
}): Promise<{ etag?: string }> {
  assertBucketAllowed(input.bucket);

  const result = await s3().send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType || 'application/octet-stream',
      ChecksumSHA256: createHash('sha256').update(input.body).digest('base64'),
    }),
  );
  return { etag: result.ETag?.replace(/"/g, '') };
}
