// app/src/server/routes/whitebit.ts
import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { syncMarketData } from '../services/sync-market-data.js';

export const createWhitebitRouter = (): Router => {
  const router = createRouter();


  router.post('/sync-markets', async (_req, res, next) => {
    try {
      const result = await syncMarketData();
      res.json({ ok: true, count: result.markets });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
