import 'dotenv/config';

import type { Server } from 'node:http';

import { createApp } from './app.js';
import { startScheduler } from './scheduler/index.js';
import { syncMarketFees } from './services/sync-market-fees.js';
import { initWsServer } from './frontend/index.js';
import { temporaryUserId } from '../shared/constants/users.js';
import { invalidateAndRefreshUserBalance } from './services/sync-user-balance.js';
import { marketsService } from './services/markets.js';
import { waitForDatabase } from './db/wait-for-start.js';
import { whitebitWsService } from './services/whitebit-ws.js';
import { marketStatisticsAggregationService } from './services/market-statistics-aggregation.js';
import { marketStatisticsPersistenceBufferService } from './services/market-statistics-persistence-buffer.js';
import { marketStatisticsRollingService } from './services/market-statistics-rolling.js';
import { marketStatisticsRestoreService } from './services/market-statistics-restore.js';
import { frontendWsService } from './services/frontend-ws.js';
import {
  marketStatisticsDbPromotionService,
} from './services/market-statistics-db-promotion.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

let server: Server | null = null;
let isShuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`${signal} received, shutting down...`);

  try {
    whitebitWsService.stop();

    await Promise.all([
      marketStatisticsPersistenceBufferService.stop(),
      marketStatisticsRollingService.stop(),
    ]);

    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    console.log('Shutdown complete');

    process.exit(0);
  } catch (error) {
    console.error('Shutdown failed', error);

    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  await waitForDatabase();

  await marketStatisticsDbPromotionService.run();

  marketStatisticsAggregationService.start();
  marketStatisticsPersistenceBufferService.start();

  await marketStatisticsRestoreService.start();

  await marketStatisticsRollingService.start();

  whitebitWsService.start();

  await marketsService.refreshMarkets();

  server = app.listen(port, '0.0.0.0', () => {
    initWsServer(server!);
    frontendWsService.start();
    invalidateAndRefreshUserBalance(temporaryUserId);
    void syncMarketFees();
    startScheduler();

    console.log(`API listening on http://0.0.0.0:${port}`);
  });
};

void start();

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
