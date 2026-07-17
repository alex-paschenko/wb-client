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

export abstract class BaseIndicator<TState = never>
  implements MarketIndicator {
  public abstract readonly name: string;

  protected abstract readonly storage: IndicatorStorageSettings;

  protected abstract readonly infiniteRange: boolean;

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
        `Unknown indicator codec "${this.storage.codec}" ` +
        `for indicator "${this.name}"`,
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
    const rangesBuilder = this.infiniteRange
      ? this.buildAffectedInfiniteRange.bind(this)
      : this.buildAffectedFiniteRanges.bind(this);

    const affectedRanges =
      params.centralIndexesAsc.length === 0
        ? []
        : rangesBuilder(
            params.centralIndexesAsc,
            params.ascending.candles.length,
          );

    return {
      indicatorName: this.name,
      lastResult: this.singleCalculate(params),
      recalculatedValues:
        affectedRanges.length > 0
          ? this.rangeCalculate(
              params,
              affectedRanges,
            )
          : [],
    };
  }

  public abstract singleCalculate(
    params: MarketIndicatorCalculationParams,
  ): number | null;

  public abstract rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): MarketIndicatorRecalculatedItem[];

  public removeMarket(
    marketName: string,
  ): void {
    this.stateByMarket.delete(marketName);
  }

  protected buildAffectedFiniteRanges(
    indexesAsc: readonly number[],
    length: number,
  ): IndicatorAffectedRange[] {
    if (
      indexesAsc.length === 0 ||
      this.period <= 0 ||
      length <= 0
    ) {
      return [];
    }

    const ranges: IndicatorAffectedRange[] = [];

    for (const indexAsc of indexesAsc) {
      const startIndexAsc = indexAsc;
      const endIndexAsc = Math.min(
        length - 1,
        indexAsc + this.period - 1,
      );

      const lastRange = ranges.at(-1);

      if (
        !lastRange ||
        startIndexAsc > lastRange.endIndexAsc
      ) {
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

  protected buildAffectedInfiniteRange(
    indexesAsc: readonly number[],
    length: number,
  ): IndicatorAffectedRange[] {
    if (
      indexesAsc.length === 0 ||
      length <= 0
    ) {
      return [];
    }

    return [{
      startIndexAsc: indexesAsc[0],
      endIndexAsc: length - 1,
    }];
  }

  private validateName(): void {
    if (
      new TextEncoder().encode(this.name).length >
      INDICATOR_NAME_MAX_LENGTH
    ) {
      throw new Error(
        `Indicator name "${this.name}" is too long. ` +
        `Max length is ${INDICATOR_NAME_MAX_LENGTH} bytes.`,
      );
    }
  }
}
