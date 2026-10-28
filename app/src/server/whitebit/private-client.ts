// app/src/server/whitebit/private-client.ts
import crypto from 'node:crypto';

import type { FetchOptions } from '../services/fetch-client.js';
import { whitebitFetchClient } from './fetch-client.js';

export interface WhitebitTradingBalance {
  [asset: string]: {
    available: string;
    freeze: string;
  };
}

export interface WhitebitFeePair {
  maker: string;
  taker: string;
}

export interface WhitebitAllMarketFeesResponse extends WhitebitFeePair {
  error: string | null;
  futures_maker: string;
  futures_taker: string;
  custom_fee: Record<string, WhitebitFeePair>;
  rpi_maker_fee_premium?: string | null;
  futures_rpi_maker_fee_premium?: string | null;
}

export class WhitebitPrivateClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  public async getTradingBalance(): Promise<WhitebitTradingBalance> {
    return this.privateRequest<WhitebitTradingBalance>(
      '/trade-account/balance',
      {},
    );
  }

  public async getAllMarketFees(): Promise<WhitebitAllMarketFeesResponse> {
    return this.privateRequest<WhitebitAllMarketFeesResponse>(
      '/market/fee',
      {},
    );
  }

  private async privateRequest<TResponse>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<TResponse> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('WhiteBIT API key or secret is missing');
    }

    let requestBody: Record<string, unknown>;

    const response = await whitebitFetchClient.fetch(
      `${this.baseUrl}${endpoint}`,
      (): FetchOptions => {
        requestBody = {
          request: `/api/v4${endpoint}`,
          nonce: String(Date.now()),
          ...body,
        };

        const jsonPayload = JSON.stringify(requestBody);
        const payload = Buffer.from(jsonPayload).toString('base64');

        const signature = crypto
          .createHmac('sha512', this.apiSecret)
          .update(payload)
          .digest('hex');

        return {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TXC-APIKEY': this.apiKey,
            'X-TXC-PAYLOAD': payload,
            'X-TXC-SIGNATURE': signature,
          },
          body: jsonPayload,
        };
      },
      () => ({
        service: 'whitebit',
        endpoint,
        method: 'POST',
        requestBody,
      }),
    );

    const responseBody = await response.json();

    if (!response.ok) {
      throw new Error(
        `WhiteBIT private request failed: ` +
        `${response.status} ${JSON.stringify(responseBody)}`,
      );
    }

    return responseBody as TResponse;
  }
}

export const whitebitPrivateClient =
  new WhitebitPrivateClient(
    process.env.WHITEBIT_BASE_URL ?? 'https://whitebit.com/api/v4',
    process.env.WHITEBIT_API_KEY ?? '',
    process.env.WHITEBIT_API_SECRET ?? '',
  );
