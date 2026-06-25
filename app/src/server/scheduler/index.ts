import { startSyncMarketFeesJob } from './jobs/sync-market-fees.job.js';
import { startRefreshMarketJob } from './jobs/refresh-market.job.js';

export const startScheduler = (): void => {
  startRefreshMarketJob();
  startSyncMarketFeesJob();
};
