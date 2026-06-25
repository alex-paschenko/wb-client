import cron from 'node-cron';

import { HOUR } from '../../../shared/constants/time.js';
import { syncMarketFees } from '../../services/sync-market-fees.js';
import { runJob } from '../../services/run-job.js';

let isRunning = false;

export const startSyncMarketFeesJob = (): void => {
  cron.schedule('0 * * * *', async () => {
    if (isRunning) {
      console.warn(
        'syncMarketFees skipped: previous run is still active',
      );

      return;
    }

    isRunning = true;

    try {
      const result = await runJob(
        'sync-market-fees',
        syncMarketFees,
      );

      console.log('syncMarketFees completed', {
        ...result,
        intervalMs: HOUR,
      });
    } catch (error) {
      console.error('syncMarketFees failed', error);
    } finally {
      isRunning = false;
    }
  });
};
