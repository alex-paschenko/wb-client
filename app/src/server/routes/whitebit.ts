import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { marketsService } from '../services/markets.js';

export const createWhitebitRouter = (): Router => {
  const router = createRouter();


  router.post('/sync-markets', async (_req, res, next) => {
    try {
      await marketsService.refreshMarkets();

      res.json({
        ok: true,
        count: Object.keys(marketsService.markets).length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
