import type { PoolClient } from 'pg';

import { pool } from './db.js';

/**
 * The intake table is the durability boundary of the whole pipeline.
 *
 * Graph gives roughly three seconds to answer a notification and retries only
 * a handful of times before it starts dropping them. So the webhook does the
 * least work that cannot be redone — one INSERT — and everything expensive
 * (Graph fetch, bucket write, enqueue) happens afterwards, driven from here.
 */

export type IntakeState = 'pending' | 'working' | 'done' | 'failed' | 'gone';

export interface IntakeRow {
  id: string;
  subscription_id: string;
  tenant_id: string | null;
  change_type: string;
  resource: string;
  resource_id: string;
  mailbox: string | null;
  state: IntakeState;
  attempts: number;
  received_at: Date;
}

export interface NotificationInput {
  subscriptionId: string;
  tenantId?: string | null;
  changeType: string;
  resource: string;
  resourceId: string;
  mailbox?: string | null;
  source?: 'webhook' | 'catchup' | 'manual';
}

/**
 * Record a notification. Returns false when we already had it.
 *
 * Graph re-delivers a notification whenever it is unsure we received one, and
 * the catch-up sweep re-offers anything it finds in the folder, so duplicates
 * are the normal case rather than an error.
 */
export async function recordNotification(input: NotificationInput): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into mail_intake
       (subscription_id, tenant_id, change_type, resource, resource_id, mailbox, source)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (resource_id, change_type) do nothing`,
    [
      input.subscriptionId,
      input.tenantId ?? null,
      input.changeType,
      input.resource,
      input.resourceId,
      input.mailbox ?? null,
      input.source ?? 'webhook',
    ],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Take up to `limit` rows and hide them from other workers for `lockSeconds`.
 *
 * SKIP LOCKED means N replicas of this service can run the same query
 * concurrently and simply divide the work; without it they would queue behind
 * each other on the oldest row.
 */
export async function claimBatch(limit: number, lockSeconds: number): Promise<IntakeRow[]> {
  const { rows } = await pool.query<IntakeRow>(
    `with claimed as (
       select id
         from mail_intake
        where state = 'pending'
          and next_attempt_at <= now()
        order by id
        for update skip locked
        limit $1
     )
     update mail_intake m
        set state = 'working',
            attempts = m.attempts + 1,
            locked_until = now() + make_interval(secs => $2),
            updated_at = now()
       from claimed c
      where m.id = c.id
      returning m.id, m.subscription_id, m.tenant_id, m.change_type, m.resource,
                m.resource_id, m.mailbox, m.state, m.attempts, m.received_at`,
    [limit, lockSeconds],
  );
  return rows;
}

/**
 * Return rows whose worker died mid-flight. The lease, not a heartbeat, is what
 * makes a crashed pod's work recoverable.
 */
export async function reapExpiredLeases(): Promise<number> {
  const { rowCount } = await pool.query(
    `update mail_intake
        set state = 'pending',
            locked_until = null,
            updated_at = now()
      where state = 'working'
        and locked_until < now()`,
  );
  return rowCount ?? 0;
}

export async function markDone(id: string, client?: Pick<PoolClient, 'query'>): Promise<void> {
  const executor = client ?? pool;
  await executor.query(
    `update mail_intake
        set state = 'done', locked_until = null, last_error = null, updated_at = now()
      where id = $1`,
    [id],
  );
}

/** The message no longer exists in the mailbox — retrying cannot help. */
export async function markGone(id: string, reason: string): Promise<void> {
  await pool.query(
    `update mail_intake
        set state = 'gone', locked_until = null, last_error = $2, updated_at = now()
      where id = $1`,
    [id, reason.slice(0, 4_000)],
  );
}

/**
 * Schedule a retry, or give up once the attempt budget is spent. Failed rows
 * stay in the table on purpose: they are the dead-letter queue, and
 * `update mail_intake set state='pending'` is how you replay them.
 */
export async function markRetry(
  id: string,
  attempts: number,
  error: string,
  options: { maxAttempts: number; backoffSeconds: number },
): Promise<'retry' | 'failed'> {
  if (attempts >= options.maxAttempts) {
    await pool.query(
      `update mail_intake
          set state = 'failed', locked_until = null, last_error = $2, updated_at = now()
        where id = $1`,
      [id, error.slice(0, 4_000)],
    );
    return 'failed';
  }

  const delaySeconds = Math.min(3_600, options.backoffSeconds * 2 ** (attempts - 1));
  await pool.query(
    `update mail_intake
        set state = 'pending',
            locked_until = null,
            next_attempt_at = now() + make_interval(secs => $3),
            last_error = $2,
            updated_at = now()
      where id = $1`,
    [id, error.slice(0, 4_000), delaySeconds],
  );
  return 'retry';
}

export interface IntakeStats {
  pending: number;
  working: number;
  done: number;
  failed: number;
  gone: number;
  oldestPendingSeconds: number | null;
}

export async function stats(): Promise<IntakeStats> {
  const { rows } = await pool.query<{
    state: IntakeState;
    count: string;
    oldest_seconds: string | null;
  }>(
    `select state,
            count(*)::text as count,
            extract(epoch from now() - min(received_at))::bigint::text as oldest_seconds
       from mail_intake
      group by state`,
  );

  const result: IntakeStats = {
    pending: 0,
    working: 0,
    done: 0,
    failed: 0,
    gone: 0,
    oldestPendingSeconds: null,
  };

  for (const row of rows) {
    result[row.state] = Number(row.count);
    if (row.state === 'pending' && row.oldest_seconds !== null) {
      result.oldestPendingSeconds = Number(row.oldest_seconds);
    }
  }
  return result;
}

// --- cursor for the catch-up sweep ---------------------------------------

export async function getState(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    'select value from mailhook_state where key = $1',
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await pool.query(
    `insert into mailhook_state (key, value)
     values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}
