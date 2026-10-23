// app/src/server/scripts/wait-for-db.ts

import 'dotenv/config';

import { q } from '../db/client.js';

const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1000;

const main = async (): Promise<void> => {
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await q`select 1`;
        console.log('PostgreSQL is ready');
        return;
      } catch (error) {
        console.warn(`PostgreSQL is not ready (${attempt}/${MAX_ATTEMPTS})`);
        if (attempt === MAX_ATTEMPTS) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RETRY_DELAY_MS);
        });
      }
    }
  } finally {
    await q.end();
  }
};

main().catch((error: unknown) => {
  console.error('Failed to wait for PostgreSQL', error);
  process.exitCode = 1;
});
