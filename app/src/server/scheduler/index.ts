import { startSyncMarketDataJob } from './jobs/sync-market-data.job.js';
import { startRepackArchiveJob } from './jobs/repack-archive.job.js';

export const startScheduler = (): void => {
  startSyncMarketDataJob();
  startRepackArchiveJob();
};
