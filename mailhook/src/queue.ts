import type { PoolClient } from 'pg';

import { pool } from './db.js';

/**
 * A small Postgres-managed message queue.
 *
 * The API mirrors pgmq (send / read / delete / archive with a visibility
 * timeout) but runs on plain tables, because the managed cluster this deploys
 * against does not offer the pgmq extension.
 *
 * Delivery is at-least-once. `read` makes a message invisible for `vtSeconds`
 * instead of removing it, so a consumer that crashes mid-work leaves the
 * message to reappear rather than vanishing. Consumers must therefore be
 * idempotent — every event carries a stable `resourceId` to dedupe on.
 *
 * Everything below is one statement per call, which is what makes it safe
 * through PgBouncer in transaction pooling mode. There is no LISTEN/NOTIFY
 * anywhere: transaction pooling multiplexes backends between clients, so a
 * LISTEN registered on one checkout is simply gone on the next.
 */

export interface QueueMessage<T = unknown> {
  msgId: string;
  readCt: number;
  enqueuedAt: Date;
  vt: Date;
  message: T;
}

interface QueueRow {
  msg_id: string;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: unknown;
}

function toMessage<T>(row: QueueRow): QueueMessage<T> {
  return {
    msgId: row.msg_id,
    readCt: row.read_ct,
    enqueuedAt: row.enqueued_at,
    vt: row.vt,
    message: row.message as T,
  };
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Enqueue a message. Accepts an optional client so the enqueue can share a
 * transaction with whatever produced it — that is how the worker guarantees a
 * message is only ever queued together with the state change that justified
 * it, never before and never without.
 */
export async function send<T>(
  queue: string,
  message: T,
  options: { client?: Queryable; delaySeconds?: number } = {},
): Promise<string> {
  const executor: Queryable = options.client ?? pool;
  const { rows } = await executor.query<{ msg_id: string }>(
    `insert into mq_messages (queue, message, vt)
     values ($1, $2::jsonb, now() + make_interval(secs => $3))
     returning msg_id`,
    [queue, JSON.stringify(message), options.delaySeconds ?? 0],
  );
  return rows[0].msg_id;
}

/**
 * Claim up to `qty` visible messages and hide them for `vtSeconds`.
 *
 * SKIP LOCKED is what lets several consumers poll the same queue without
 * serialising on the oldest row: a consumer takes the oldest rows *it* can
 * lock and leaves contended ones to whoever holds them.
 */
export async function read<T>(
  queue: string,
  qty = 1,
  vtSeconds = 60,
  client?: Queryable,
): Promise<QueueMessage<T>[]> {
  const executor: Queryable = client ?? pool;
  const { rows } = await executor.query<QueueRow>(
    `with claimed as (
       select msg_id
         from mq_messages
        where queue = $1
          and vt <= now()
        order by msg_id
        for update skip locked
        limit $2
     )
     update mq_messages m
        set vt = now() + make_interval(secs => $3),
            read_ct = m.read_ct + 1
       from claimed c
      where m.msg_id = c.msg_id
      returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message`,
    [queue, qty, vtSeconds],
  );
  return rows.map((row) => toMessage<T>(row));
}

/** Acknowledge and drop a message. */
export async function deleteMessage(msgId: string, client?: Queryable): Promise<boolean> {
  const executor: Queryable = client ?? pool;
  const { rowCount } = await executor.query('delete from mq_messages where msg_id = $1', [msgId]);
  return (rowCount ?? 0) > 0;
}

/** Acknowledge, but keep the payload for audit/replay. */
export async function archive(msgId: string, client?: Queryable): Promise<boolean> {
  const executor: Queryable = client ?? pool;
  const { rowCount } = await executor.query(
    `with moved as (
       delete from mq_messages where msg_id = $1
       returning msg_id, queue, message, read_ct, enqueued_at
     )
     insert into mq_archive (msg_id, queue, message, read_ct, enqueued_at)
     select msg_id, queue, message, read_ct, enqueued_at from moved
     on conflict (msg_id) do nothing`,
    [msgId],
  );
  return (rowCount ?? 0) > 0;
}

/** Push a message back into view early (or extend its lease). */
export async function setVisibilityTimeout(
  msgId: string,
  vtSeconds: number,
  client?: Queryable,
): Promise<void> {
  const executor: Queryable = client ?? pool;
  await executor.query(
    `update mq_messages set vt = now() + make_interval(secs => $2) where msg_id = $1`,
    [msgId, vtSeconds],
  );
}

export interface QueueMetrics {
  queue: string;
  length: number;
  visible: number;
  oldestSeconds: number | null;
  maxReadCt: number;
  archived: number;
}

export async function metrics(queue: string): Promise<QueueMetrics> {
  const { rows } = await pool.query<{
    length: string;
    visible: string;
    oldest_seconds: string | null;
    max_read_ct: string | null;
    archived: string;
  }>(
    `select
       (select count(*) from mq_messages where queue = $1)::text                            as length,
       (select count(*) from mq_messages where queue = $1 and vt <= now())::text            as visible,
       (select extract(epoch from now() - min(enqueued_at))::bigint
          from mq_messages where queue = $1)::text                                          as oldest_seconds,
       (select max(read_ct) from mq_messages where queue = $1)::text                        as max_read_ct,
       (select count(*) from mq_archive where queue = $1)::text                             as archived`,
    [queue],
  );

  const row = rows[0];
  return {
    queue,
    length: Number(row.length),
    visible: Number(row.visible),
    oldestSeconds: row.oldest_seconds === null ? null : Number(row.oldest_seconds),
    maxReadCt: Number(row.max_read_ct ?? 0),
    archived: Number(row.archived),
  };
}
