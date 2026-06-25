import crypto from 'node:crypto';

export interface WhitebitTradingBalance {
  [asset: string]: {
    available: string;
    freeze: string;
  };
}

export interface WhitebitAllMarketFeesResponse {
  error: unknown;
  taker: string;
  maker: string;
  futures_taker?: string;
  futures_maker?: string;
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

    const payloadBody = {
      request: `/api/v4${endpoint}`,
      nonce: String(Date.now()),
      ...body,
    };

    const jsonPayload = JSON.stringify(payloadBody);
    const payload = Buffer.from(jsonPayload).toString('base64');

    const signature = crypto
      .createHmac('sha512', this.apiSecret)
      .update(payload)
      .digest('hex');

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TXC-APIKEY': this.apiKey,
        'X-TXC-PAYLOAD': payload,
        'X-TXC-SIGNATURE': signature,
      },
      body: jsonPayload,
    });

    const responseBody = await response.json();

    if (!response.ok) {
      throw new Error(
        `WhiteBIT private request failed: ${response.status} ${JSON.stringify(responseBody)}`,
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
