import cron from 'node-cron';

import { runJob } from '../../services/run-job.js';
import { marketsService } from '../../services/markets.js';

let isRunning = false;

export const startRefreshMarketJob = () => {
  cron.schedule('0 */10 * * * *', async () => {
    if (isRunning) {
      console.warn('refreshMarkets job skipped: previous run is still active');

      return;
    }

    isRunning = true;

    try {
      const result = await runJob(
        'refresh-markets',
        () => marketsService.refreshMarkets(),
      );

      console.log('refreshMarkets job completed', result);
    } catch (error) {
      console.error('refreshMarkets job failed', error);
    } finally {
      isRunning = false;
    }
  });
};
