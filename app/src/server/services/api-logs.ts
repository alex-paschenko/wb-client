import { apiLogsDao } from '../dao/api-logs.js';

export class ApiLogsService {
  public async logExternalApiCall(input: {
    service: string;

    endpoint: string;

    method: string;

    startedAtMs: number;

    statusCode?: number;

    requestBody?: object;

    responseBody?: object;

    error?: unknown;
  }): Promise<void> {
    try {
      await apiLogsDao.create({
        service: input.service,

        endpoint: input.endpoint,

        method: input.method,

        statusCode: input.statusCode,

        requestBody: input.requestBody,

        responseBody: input.responseBody,

        errorText:
          input.error instanceof Error
            ? input.error.stack ?? input.error.message
            : input.error
              ? String(input.error)
              : undefined,

        durationMs:
          Date.now() - input.startedAtMs,
      });
    } catch (e: unknown) {
      console.error('Failed to log API call.', e);
    }
  }
}

export const apiLogsService = new ApiLogsService();
