import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { marketsDao } from '../dao/markets.js';

export const createMarketsRouter = (): Router => {
  const router = createRouter();

  router.get('/', async (_req, res, next) => {
    try {
      const markets = await marketsDao.getAll();

      res.json({
        ok: true,
        markets,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:symbol', async (req, res, next) => {
    try {
      const market = await marketsDao.getBySymbol(req.params.symbol);

      if (!market) {
        res.status(404).json({
          ok: false,
          error: 'Market not found',
        });

        return;
      }

      res.json({
        ok: true,
        market,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
