import express from 'express';

import { AppError } from './errors/app-error.js';
import { serverI18n } from './i18n/i18n.js';
import { createApiRouter } from './routes/index.js';

export const createApp = () => {
  const app = express();

  app.use(express.json());

  app.use('/api', createApiRouter());

  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        ok: false,
        code: error.code,
        error: serverI18n.t(error.code),
        meta: error.meta,
      });

      return;
    }

    res.status(500).json({
      ok: false,
      code: 'errors.internalServerError',
      error: serverI18n.t('errors.internalServerError'),
    });
  });

  return app;
};
