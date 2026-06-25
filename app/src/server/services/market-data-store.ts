import { MINUTES } from '../../shared/constants/time.js';
import type { RuntimeTick } from '../types/market-event.js';

interface TickWindow {
  ticks: RuntimeTick[];
}

export interface PriceDelta {
  symbol: string;
  intervalMs: number;
  fromPrice: number;
  toPrice: number;
  absolute: number;
  percent: number;
}

export interface HighLow {
  symbol: string;
  intervalMs: number;
  high: number;
  low: number;
}

export class MarketDataStore {
  private readonly windows =
    new Map<string, TickWindow>();

  public constructor(
    private readonly maxAgeMs = 5 * MINUTES,
  ) {}

  public push(tick: RuntimeTick): void {
    let window = this.windows.get(tick.symbol);

    if (!window) {
      window = {
        ticks: [],
      };

      this.windows.set(
        tick.symbol,
        window,
      );
    }

    window.ticks.push(tick);

    this.prune(window, tick.exchangeTimestampMs);
  }

  public getLatest(
    symbol: string,
  ): RuntimeTick | null {
    const window =
      this.windows.get(symbol);

    if (!window || window.ticks.length === 0) {
      return null;
    }

    return window.ticks.at(-1) ?? null;
  }

  public getTicks(
    symbol: string,
  ): RuntimeTick[] {
    return (
      this.windows.get(symbol)?.ticks ??
      []
    );
  }

  public getTicksSince(
    symbol: string,
    sinceMs: number,
  ): RuntimeTick[] {
    const ticks = this.getTicks(symbol);

    return ticks.filter(
      (tick) => tick.exchangeTimestampMs >= sinceMs,
    );
  }

  public getPriceDelta(
    symbol: string,
    intervalMs: number,
    priceSelector: (tick: RuntimeTick) => number,
  ): PriceDelta | null {
    const latest = this.getLatest(symbol);

    if (!latest) {
      return null;
    }

    const sinceMs = latest.exchangeTimestampMs - intervalMs;
    const ticks = this.getTicksSince(symbol, sinceMs);

    if (ticks.length < 2) {
      return null;
    }

    const first = ticks[0]!;
    const last = ticks.at(-1)!;

    const fromPrice = priceSelector(first);
    const toPrice = priceSelector(last);

    return {
      symbol,
      intervalMs,
      fromPrice,
      toPrice,
      absolute: toPrice - fromPrice,
      percent: ((toPrice - fromPrice) / fromPrice) * 100,
    };
  }

  public getHighLow(
    symbol: string,
    intervalMs: number,
    priceSelector: (tick: RuntimeTick) => number,
  ): HighLow | null {
    const latest = this.getLatest(symbol);

    if (!latest) {
      return null;
    }

    const sinceMs = latest.exchangeTimestampMs - intervalMs;
    const ticks = this.getTicksSince(symbol, sinceMs);

    if (ticks.length === 0) {
      return null;
    }

    let high = priceSelector(ticks[0]!);
    let low = priceSelector(ticks[0]!);

    for (const tick of ticks) {
      const price = priceSelector(tick);

      high = Math.max(high, price);
      low = Math.min(low, price);
    }

    return {
      symbol,
      intervalMs,
      high,
      low,
    };
  }

  private prune(
    window: TickWindow,
    nowMs: number,
  ): void {
    const minTs =
      nowMs - this.maxAgeMs;

    while (
      window.ticks.length > 0 &&
      window.ticks[0]!.exchangeTimestampMs < minTs
    ) {
      window.ticks.shift();
    }
  }
}

export const marketDataStore =
  new MarketDataStore();
