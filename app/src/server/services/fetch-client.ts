// app/src/server/services/fetch-client.ts

import { apiLogsService } from './api-logs.js';

type FetchParameters = Parameters<typeof fetch>;

export type FetchResource = FetchParameters[0];
export type FetchOptions = FetchParameters[1];

export type FetchOptionsWithGetter =
  | FetchOptions
  | (() => FetchOptions);

export interface FetchLog {
  service: string;
  endpoint: string;
  method: string;
  requestBody?: object;
}

export type FetchLogWithGetter =
  | FetchLog
  | (() => FetchLog);

interface FetchRequest {
  resource: FetchResource;
  options: FetchOptionsWithGetter;
  log: FetchLogWithGetter;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

export class FetchClient {
  private readonly queue: FetchRequest[] = [];

  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStartedAt = 0;

  public constructor(
    private readonly minInterval: number,
  ) {}

  public fetch(
    resource: FetchResource,
    options: FetchOptionsWithGetter,
    log: FetchLogWithGetter,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({
        resource,
        options,
        log,
        resolve,
        reject,
      });

      this.scheduleNext();
    });
  }

  private scheduleNext(): void {
    if (this.timer || this.queue.length === 0) {
      return;
    }

    const delay = Math.max(
      0,
      this.lastStartedAt + this.minInterval - Date.now(),
    );

    if (delay === 0) {
      this.execNext();
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.execNext();
    }, delay);
  }

  private execNext(): void {
    const request = this.queue.shift();

    if (!request) {
      return;
    }

    const startedAtMs = Date.now();
    this.lastStartedAt = startedAtMs;

    try {
      const options =
        typeof request.options === 'function'
          ? request.options()
          : request.options;

      const log =
        typeof request.log === 'function'
          ? request.log()
          : request.log;

      void this.executeRequest(
        request,
        options,
        log,
        startedAtMs,
      );
    } catch (error) {
      request.reject(error);
    }

    this.scheduleNext();
  }

  private async executeRequest(
    request: FetchRequest,
    options: FetchOptions,
    log: FetchLog,
    startedAtMs: number,
  ): Promise<void> {
    try {
      const response = await fetch(
        request.resource,
        options,
      );

      const responseBody = await response.clone().json();

      await apiLogsService.logExternalApiCall({
        ...log,
        startedAtMs,
        statusCode: response.status,
        responseBody,
      });

      request.resolve(response);
    } catch (error) {
      await apiLogsService.logExternalApiCall({
        ...log,
        startedAtMs,
        error,
      });

      request.reject(error);
    }
  }
}
