import type { PoolClient } from 'pg';

import { pool } from './db.js';

/**
 * Consumer half of the Postgres-managed queue that mailhook writes to.
 *
 * Only the read side is here — this service never enqueues to `mail_events`.
 * The tables are owned and migrated by mailhook; this is deliberately a reader
 * of someone else's queue rather than a second definition of it.
 *
 * `read` hides a message for `vtSeconds` rather than deleting it, so a consumer
 * that dies mid-work leaves the message to reappear. That makes delivery
 * at-least-once, which is why `handler.ts` keys everything on `resourceId`.
 *
 * Polling, not LISTEN/NOTIFY: DATABASE_URL points at PgBouncer in transaction
 * mode, which multiplexes backends between clients and loses a LISTEN
 * registered on a previous checkout.
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

type Queryable = Pick<PoolClient, 'query'>;

/** Claim up to `qty` visible messages and hide them for `vtSeconds`. */
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

  return rows.map((row) => ({
    msgId: row.msg_id,
    readCt: row.read_ct,
    enqueuedAt: row.enqueued_at,
    vt: row.vt,
    message: row.message as T,
  }));
}

/**
 * Acknowledge a message, keeping the payload in `mq_archive`.
 *
 * Archive rather than delete: the archive is what lets you answer "did we ever
 * receive an event for this message, and what did it say" without going back to
 * Microsoft. Accepts a client so the ack can share the transaction that wrote
 * the results — the message is then only acknowledged if the work committed.
 */
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

/** Make a message visible again early, instead of waiting out its lease. */
export async function release(msgId: string, delaySeconds = 0): Promise<void> {
  await pool.query(
    `update mq_messages set vt = now() + make_interval(secs => $2) where msg_id = $1`,
    [msgId, delaySeconds],
  );
}

export interface QueueMetrics {
  queue: string;
  length: number;
  visible: number;
  oldestSeconds: number | null;
  maxReadCt: number;
}

export async function metrics(queue: string): Promise<QueueMetrics> {
  const { rows } = await pool.query<{
    length: string;
    visible: string;
    oldest_seconds: string | null;
    max_read_ct: string | null;
  }>(
    `select
       count(*)::text                                                        as length,
       count(*) filter (where vt <= now())::text                             as visible,
       extract(epoch from now() - min(enqueued_at))::bigint::text            as oldest_seconds,
       max(read_ct)::text                                                    as max_read_ct
     from mq_messages
     where queue = $1`,
    [queue],
  );

  const row = rows[0];
  return {
    queue,
    length: Number(row.length),
    visible: Number(row.visible),
    oldestSeconds: row.oldest_seconds === null ? null : Number(row.oldest_seconds),
    maxReadCt: Number(row.max_read_ct ?? 0),
  };
}
