// app/src/server/index.ts
import 'dotenv/config';
import type { Server } from 'node:http';

import { createApp } from './app.js';
import { startScheduler } from './scheduler/index.js';
import { syncMarketFees } from './services/sync-market-fees.js';
import { initWsServer } from './frontend/index.js';
import { temporaryUserId } from '../shared/constants/users.js';
import {
  invalidateAndRefreshUserBalance
} from './services/sync-user-balance.js';
import { marketsService } from './services/markets.js';
import { waitForDatabase } from './db/wait-for-start.js';
import { whitebitWsService } from './services/whitebit-ws.js';
import { storageAggregationService } from './services/storage-aggregation.js';
import {
  marketStatisticsRollingService
} from './services/market-statistics-rolling.js';
import { frontendWsService } from './services/frontend-ws.js';
import { entityManager } from './services/entity-manager.js';
import { serverGlobalStateService } from './services/global-state.js';
import { storagePersistenceService } from './services/storage-persistence.js';

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
      storagePersistenceService.stop(),
      marketStatisticsRollingService.stop(),
    ]);

    serverGlobalStateService.stop();

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

  serverGlobalStateService.start();

  await marketsService.refreshMarkets();

  /*
   * start() synchronously registers the registry listener
   * before reaching its first await.
   */
  storagePersistenceService.start();

  const aggregationStart = storageAggregationService.start();

  entityManager.start();

  await aggregationStart;

  await marketStatisticsRollingService.start();

  whitebitWsService.start();

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

process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
