// app/src/server/whitebit/public-client.ts
import type { WhitebitMarket } from '../../shared/types/whitebit-api.js';
import { whitebitFetchClient } from './fetch-client.js';

export class WhitebitClient {
  public constructor(
    private readonly baseUrl: string,
  ) {}

  public async getMarkets(): Promise<WhitebitMarket[]> {
    const endpoint = '/public/markets';

    const response = await whitebitFetchClient.fetch(
      `${this.baseUrl}${endpoint}`,
      undefined,
      {
        service: 'whitebit',
        endpoint,
        method: 'GET',
      },
    );

    const responseBody = await response.json();

    if (!response.ok) {
      throw new Error(
        `WhiteBIT request failed: ${response.status}`,
      );
    }

    return responseBody as WhitebitMarket[];
  }

  public async getMarketActivity(): Promise<unknown> {
    const endpoint = '/public/ticker';

    const response = await whitebitFetchClient.fetch(
      `${this.baseUrl}${endpoint}`,
      undefined,
      {
        service: 'whitebit',
        endpoint,
        method: 'GET',
      },
    );

    const responseBody = await response.json();

    if (!response.ok) {
      throw new Error(
        `WhiteBIT request failed: ` +
        `${response.status} ${response.statusText}`,
      );
    }

    return responseBody;
  }
}

export const whitebitClient = new WhitebitClient(
  process.env.WHITEBIT_BASE_URL ?? 'https://whitebit.com/api/v4',
);
