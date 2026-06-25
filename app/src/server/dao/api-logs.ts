import { q } from '../db/client.js';
import {
  nullifyUndefined,
  toJsonObject
} from '../utilities/db-helpers.js';
import type { Sql } from '../db/client.js';

export interface CreateApiLogInput {
  service: string;
  endpoint: string;
  method: string;
  statusCode?: number;
  requestBody?: object;
  responseBody?: object;
  errorText?: string;
  durationMs?: number;
}

export class ApiLogsDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async create(
    input: CreateApiLogInput,
  ): Promise<void> {
    const q = this.q;

    const logEntry = {
          service: input.service,
          endpoint: input.endpoint,
          method: input.method,
          status_code: nullifyUndefined(input.statusCode),
          request_body: toJsonObject(input.requestBody),
          response_body: toJsonObject(input.responseBody),
          error_text: nullifyUndefined(input.errorText),
          duration_ms: nullifyUndefined(input.durationMs),
    };

    await q`
      insert into api_logs ${
        q(logEntry)
      }
    `;
  }
}

export const apiLogsDao = new ApiLogsDao(q);
