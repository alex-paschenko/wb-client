import { apiLogsService } from '../services/api-logs.js';
import { WhitebitMarket } from '../../shared/types/whitebit-api.js';

export class WhitebitClient {
  public constructor(
    private readonly baseUrl: string,
  ) {}

  public async getMarkets(): Promise<WhitebitMarket[]> {
    const endpoint = '/public/markets';

    const startedAtMs = Date.now();

    try {
      const response = await fetch(
        `${this.baseUrl}${endpoint}`,
      );

      const responseBody =
        await response.json();

      await apiLogsService.logExternalApiCall({
        service: 'whitebit',
        endpoint,
        method: 'GET',
        startedAtMs,
        statusCode: response.status,
        responseBody,
      });

      if (!response.ok) {
        throw new Error(
          `WhiteBIT request failed: ${response.status}`,
        );
      }

      return responseBody;
    } catch (error) {
      await apiLogsService.logExternalApiCall({
        service: 'whitebit',
        endpoint,
        method: 'GET',
        startedAtMs,
        error,
      });

      throw error;
    }
  }

public async getMarketActivity(): Promise<unknown> {
  const endpoint = '/public/ticker';

  const startedAtMs = Date.now();

  try {
    const response = await fetch(
      `${this.baseUrl}${endpoint}`,
    );

    const responseBody =
      await response.json();

    await apiLogsService.logExternalApiCall({
      service: 'whitebit',
      endpoint,
      method: 'GET',
      startedAtMs,
      statusCode: response.status,
      responseBody,
    });

    if (!response.ok) {
      throw new Error(
        `WhiteBIT request failed: ${response.status} ${response.statusText}`,
      );
    }

    return responseBody;
  } catch (error) {
    await apiLogsService.logExternalApiCall({
      service: 'whitebit',
      endpoint,
      method: 'GET',
      startedAtMs,
      error,
    });

    throw error;
  }
}
}

export const whitebitClient = new WhitebitClient(
  process.env.WHITEBIT_BASE_URL ?? 'https://whitebit.com/api/v4',
);
