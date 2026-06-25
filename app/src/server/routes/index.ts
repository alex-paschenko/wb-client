import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { createHealthRouter } from './health.js';
import { createMarketsRouter } from './markets.js';
import { createWhitebitRouter } from './whitebit.js';

export const createApiRouter = (): Router => {
  const router = createRouter();

  router.use('/health', createHealthRouter());
  router.use('/markets', createMarketsRouter());
  router.use('/whitebit', createWhitebitRouter());

  return router;
};
