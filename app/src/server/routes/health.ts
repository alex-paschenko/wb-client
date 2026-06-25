import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { healthDao } from '../dao/health';

export const createHealthRouter = (): Router => {
  const router = createRouter();

  router.get('/', async (_req, res, next) => {
    try {
      const now = await healthDao.getNow();

      res.json({
        ok: true,
        dbTime: now,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
