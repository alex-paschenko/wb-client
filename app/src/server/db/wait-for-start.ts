import { q } from './client';

export async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await q`select 1`;
      return;
    } catch (error) {
      console.error(`Database is not ready, attempt ${attempt}/30`, error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error('Database is not ready after 30 attempts.');
}
