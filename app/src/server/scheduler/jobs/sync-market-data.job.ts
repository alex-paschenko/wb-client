import cron from 'node-cron';
import { syncMarketData } from '../../services/sync-market-data.js';
import { runJob } from '../../services/run-job.js';

let running = false;

export const startSyncMarketDataJob = (): void => {
  cron.schedule('0 */10 * * * *', async () => {
    if (running) {
      console.warn('syncMarketData skipped: previous run still active');
      return;
    }
    running = true;
    try {
      const result = await runJob('sync-market-data', syncMarketData);
      console.log('syncMarketData completed', result);
    } catch (error) {
      console.error('syncMarketData failed', error);
    } finally {
      running = false;
    }
  });
};
