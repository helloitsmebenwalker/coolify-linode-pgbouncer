import { pool, waitForDatabase } from './db.js';

const statements = [
  `create table if not exists visits (
     id         bigserial primary key,
     path       text        not null,
     user_agent text,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists visits_created_at_idx on visits (created_at desc)`,
];

export async function migrate(): Promise<void> {
  await waitForDatabase();
  for (const statement of statements) {
    await pool.query(statement);
  }
  console.log(`migrations applied (${statements.length} statements)`);
}

// Allow running standalone: `npm run migrate`
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
