// app/src/shared/services/market-statistics-delta.ts

import {
  MARKET_STATISTICS_DELTA_OPERATION_TYPE,
} from '../constants/market-statistics-storage.js';
import type { MarketCandle } from '../types/market-statistics-storage.js';
import {
  decodeMarketStatisticsDelta,
  encodeMarketStatisticsDelta,
  type MarketStatisticsDeltaOperation,
} from '../utilities/market-statistics-delta-codec.js';

export class MarketStatisticsDeltaService {
  private operations: MarketStatisticsDeltaOperation[] = [];

  public recordAddItem(level: number, item: MarketCandle): void {
    this.operations.push({
      type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.addItem,
      level,
      item,
    });
  }

  public recordRemoveItems(level: number, count: number): void {
    let remaining = count;

    while (remaining > 0) {
      const operationCount = Math.min(remaining, 0xff);

      this.operations.push({
        type: MARKET_STATISTICS_DELTA_OPERATION_TYPE.removeItems,
        level,
        count: operationCount,
      });

      remaining -= operationCount;
    }
  }

  public decode(delta: Uint8Array): MarketStatisticsDeltaOperation[] {
    return decodeMarketStatisticsDelta(delta);
  }

  public commit(): ArrayBuffer | null {
    if (this.operations.length === 0) {
      return null;
    }

    const delta = encodeMarketStatisticsDelta(this.operations);

    this.operations = [];

    return delta;
  }

  public clear(): void {
    this.operations = [];
  }
}
