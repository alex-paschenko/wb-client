// app/src/server/index.ts
import 'dotenv/config';
import type { Server } from 'node:http';

import { createApp } from './app.js';
import { startScheduler } from './scheduler/index.js';
import { syncMarketData } from './services/sync-market-data.js';
import { initWsServer } from './frontend/index.js';
import { temporaryUserId } from '../shared/constants/users.js';
import {
  invalidateAndRefreshUserBalance
} from './services/sync-user-balance.js';
import { whitebitWsService } from './services/whitebit-ws.js';
import { storageAggregationService } from './services/storage-aggregation.js';
import {
  marketStatisticsRollingService
} from './services/market-statistics-rolling.js';
import { frontendWsService } from './services/frontend-ws.js';
import { entityManager } from './services/entity-manager.js';
import { serverGlobalStateService } from './services/global-state.js';
import { storagePersistenceService } from './services/storage-persistence.js';
import { depthPersistence } from './services/depth-persistence.js';
import { researchPersistence } from './services/research-persistence.js';
import { orderPersistence } from './services/order-persistence.js';
import {
  strategyStatePersistence,
} from './services/strategy-state-persistence.js';
import { orderBookDepthService } from './services/order-book-depth.js';
import { orderManager } from './services/order-manager.js';
import { strategyManager } from './services/strategy-manager.js';
import { orderEmulator } from './research/order-emulator.js';

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
    await storageAggregationService.stop();
    await orderManager.waitForPendingRequests();
    orderEmulator.stop();
    strategyManager.stop();
    orderManager.stop();
    orderBookDepthService.stop();

    await Promise.all([
      storagePersistenceService.stop(),
      marketStatisticsRollingService.stop(),
      depthPersistence.stop(),
      researchPersistence.stop(),
      orderPersistence.stop(),
      strategyStatePersistence.stop(),
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
  serverGlobalStateService.start();

  await syncMarketData();

  /*
   * start() synchronously registers the registry listener
   * before reaching its first await.
   */
  storagePersistenceService.start();
  depthPersistence.start();
  researchPersistence.start();
  orderPersistence.start();
  strategyStatePersistence.start();

  orderBookDepthService.start();
  orderManager.start();
  orderEmulator.start();
  strategyManager.start();

  const aggregationStart = storageAggregationService.start();

  entityManager.start();

  await aggregationStart;

  await marketStatisticsRollingService.start();

  whitebitWsService.start();

  server = app.listen(port, '0.0.0.0', () => {
    initWsServer(server!);
    frontendWsService.start();
    invalidateAndRefreshUserBalance(temporaryUserId);
    startScheduler();

    console.log(`API listening on http://0.0.0.0:${port}`);
  });
};

void start().catch((error: unknown) => {
  console.error('Server startup failed', error);
  process.exit(1);
});

process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
