// src/server/services/markets.ts
import { marketsDao } from '../dao/markets.js';
import { whitebitClient } from '../whitebit/public-client.js';
import { filterKeys } from '../utilities/objects.js';
import { SERVER_EVENT } from '../constants/events.js';
import { eventBus } from './event-bus.js';

import type {
  Market,
  MarketsByName,
} from '../../shared/types/market.js';

import {
  whitebitMarketKeys,
  type WhitebitMarket,
} from '../../shared/types/whitebit-api.js';

export class MarketsService {
  private marketsByName: MarketsByName = {};

  public get markets(): MarketsByName {
    return this.marketsByName;
  }

  public getByName(name: string): Market | undefined {
    return this.marketsByName[name];
  }

  public getActiveMarketNames(): string[] {
    return Object.keys(this.marketsByName);
  }

  public getActiveMarkets(): MarketsByName {
    return structuredClone(this.marketsByName);
  }

  public async refreshMarkets(): Promise<{}> {
    try {
      const rawMarkets = await whitebitClient.getMarkets();

      const markets = rawMarkets.map(
        (market) => filterKeys(market, whitebitMarketKeys),
      );

      this.assertValidMarketsResponse(markets);

      this.marketsByName = this.toMarketsByName(markets);

      await marketsDao.refreshAll(markets);
    } catch (error) {
      console.error(
        'Failed to refresh markets from WhiteBIT. Falling back to DB.',
        error,
      );

      this.marketsByName = await marketsDao.getAllAlives();
    }

    this.emitMarketsInfoUpdated();
    return {};
  }

  private emitMarketsInfoUpdated(): void {
    eventBus.emit(SERVER_EVENT.marketsInfoUpdated, {
      marketNames: this.getActiveMarketNames(),
    });
  }

  private assertValidMarketsResponse(
    markets: WhitebitMarket[],
  ): void {
    if (!Array.isArray(markets)) {
      throw new Error('WhiteBIT markets response is not an array.');
    }

    if (markets.length === 0) {
      throw new Error('WhiteBIT markets response is empty.');
    }
  }

  private toMarketsByName(markets: WhitebitMarket[]): MarketsByName {
    return Object.fromEntries(
      markets
        .filter((market) => market.tradesEnabled)
        .map((market) => [
          market.name,
          {
            ...market,
            isActive: true,
          },
        ]),
    );
  }
}

export const marketsService = new MarketsService();
