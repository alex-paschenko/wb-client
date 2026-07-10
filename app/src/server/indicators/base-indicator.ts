// app/src/server/indicators/base-indicator.ts
import {
  INDICATOR_NAME_MAX_LENGTH,
  INDICATOR_CODECS,
} from '../../shared/constants/market-indicators.js';
import type {
  IndicatorResults,
  IndicatorValueCodecName,
  MarketIndicatorRecalculatedItem,
  MarketIndicatorStorageConfig,
} from '../../shared/types/market-indicators.js';
import type {
  MarketIndicator,
  MarketIndicatorCalculationParams,
} from '../types/market-indicators.js';

interface IndicatorStorageSettings {
  codec: IndicatorValueCodecName;
}

export interface IndicatorAffectedRange {
  startIndexAsc: number;
  endIndexAsc: number;
}

export abstract class BaseIndicator<TState = never> implements MarketIndicator {
  public abstract readonly name: string;

  protected abstract readonly storage: IndicatorStorageSettings;

  public readonly dependencies: readonly string[] = [];

  protected readonly stateByMarket = new Map<string, TState>();

  protected constructor(
    protected readonly period: number,
  ) {}

  public getStorageConfig(): MarketIndicatorStorageConfig {
    this.validateName();

    const codecIndex = INDICATOR_CODECS.findIndex(
      (codec) => codec.name === this.storage.codec,
    );

    if (codecIndex < 0) {
      throw new Error(
        `Unknown indicator codec "${this.storage.codec}" for indicator "${this.name}"`,
      );
    }

    return {
      name: this.name,
      codecIndex,
    };
  }

  public calculate(
    params: MarketIndicatorCalculationParams,
  ): IndicatorResults {
    return {
      lastResult: this.singleCalculate(params),
      recalculatedValues: params.centralIndexesAsc.length > 0
        ? this.rangeCalculate(
            params,
            this.buildAffectedRanges(
              params.centralIndexesAsc,
              params.ascending.candles.length,
            ),
          )
        : [],
      indicatorName: this.name,
    };
  }

  public abstract singleCalculate(
    params: MarketIndicatorCalculationParams
  ): number | null;

  public abstract rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): MarketIndicatorRecalculatedItem[];

  public removeMarket(marketName: string): void {
    this.stateByMarket.delete(marketName);
  }

  private validateName(): void {
    if (new TextEncoder().encode(this.name).length > INDICATOR_NAME_MAX_LENGTH) {
      throw new Error(
        `Indicator name "${this.name}" is too long. Max length is ${INDICATOR_NAME_MAX_LENGTH} bytes.`,
      );
    }
  }

  protected buildAffectedRanges(
    centralIndexesAsc: readonly number[],
    length: number,
  ): IndicatorAffectedRange[] {
    if (this.period <= 0 || length <= 0) {
      return [];
    }

    const ranges: IndicatorAffectedRange[] = [];

    for (const centralIndex of centralIndexesAsc) {
      const startIndexAsc = Math.max(0, centralIndex - this.period + 1);
      const endIndexAsc = Math.min(length - 1, centralIndex + this.period - 1);

      const lastRange = ranges.at(-1);

      if (!lastRange || startIndexAsc > lastRange.endIndexAsc) {
        ranges.push({
          startIndexAsc,
          endIndexAsc,
        });
        continue;
      }

      lastRange.endIndexAsc = Math.max(
        lastRange.endIndexAsc,
        endIndexAsc,
      );
    }

    return ranges;
  }
}
