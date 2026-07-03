import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { createHealthRouter } from './health.js';
import { createWhitebitRouter } from './whitebit.js';

export const createApiRouter = (): Router => {
  const router = createRouter();

  router.use('/health', createHealthRouter());
  router.use('/whitebit', createWhitebitRouter());

  return router;
};
