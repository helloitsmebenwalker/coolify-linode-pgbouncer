/**
 * The contract with mailhook.
 *
 * This is a copy of the producer's type, on purpose. The two services are
 * deployed independently, so the schema on the wire is the interface between
 * them — sharing a TypeScript type across the boundary would create a build
 * coupling that says nothing about what is actually in the queue at runtime.
 * `parseMailStoredEvent` is the real contract: it is what runs against a
 * payload written by a version of mailhook this service was not compiled with.
 */

export const MAIL_STORED = 'mail.stored';

export interface MailStoredEvent {
  type: typeof MAIL_STORED;
  version: 1;
  occurredAt: string;
  mailbox: string;
  message: {
    resourceId: string;
    internetMessageId: string | null;
    subject: string | null;
    from: string | null;
    to: string[];
    receivedAt: string | null;
    hasAttachments: boolean;
    conversationId: string | null;
  };
  object: {
    bucket: string;
    key: string;
    region: string;
    endpoint: string;
    url: string;
    sizeBytes: number;
    sha256: string;
    contentType: string;
  };
  source: {
    intakeId: string;
    subscriptionId: string;
    changeType: string;
    resource: string;
  };
}

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate a payload off the queue.
 *
 * Anything that fails here is dead-lettered rather than retried: a malformed
 * event will be exactly as malformed in five minutes, and retrying it just
 * blocks the queue behind a message that can never succeed.
 */
export function parseMailStoredEvent(payload: unknown): MailStoredEvent {
  if (!isRecord(payload)) throw new InvalidEventError('event is not an object');

  if (payload.type !== MAIL_STORED) {
    throw new InvalidEventError(`unsupported event type: ${String(payload.type)}`);
  }

  // Forward compatibility: a future producer bumping the version is a signal to
  // stop and be upgraded, not to guess at the new shape.
  if (payload.version !== 1) {
    throw new InvalidEventError(`unsupported event version: ${String(payload.version)}`);
  }

  const message = payload.message;
  const object = payload.object;

  if (!isRecord(message) || typeof message.resourceId !== 'string' || !message.resourceId) {
    throw new InvalidEventError('event has no message.resourceId');
  }

  if (
    !isRecord(object) ||
    typeof object.bucket !== 'string' ||
    typeof object.key !== 'string' ||
    !object.bucket ||
    !object.key
  ) {
    throw new InvalidEventError('event has no object.bucket/object.key');
  }

  return payload as unknown as MailStoredEvent;
}
