import type { Router } from 'express';
import { Router as createRouter } from 'express';

import { frontendSettingsService } from '../services/frontend-settings.js';

const temporaryUserId = 1;

export const createSettingsRouter = (): Router => {
  const router = createRouter();

  router.get('/', async (_req, res, next) => {
    try {
      const settings =
        await frontendSettingsService.getByUserId(
          temporaryUserId,
        );

      res.json({
        ok: true,
        settings,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const settings =
        await frontendSettingsService.saveByUserId(
          temporaryUserId,
          req.body,
        );

      res.json({
        ok: true,
        settings,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
