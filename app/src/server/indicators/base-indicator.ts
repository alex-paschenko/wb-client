// app/src/server/indicators/base-indicator.ts

import {
  INDICATOR_NAME_MAX_LENGTH,
  INDICATOR_CODECS,
} from '../../shared/constants/market-indicators.js';
import type {
  IndicatorValue,
  IndicatorValueCodecName,
  MarketIndicatorStorageConfig,
} from '../../shared/types/market-indicators.js';
import type {
  AggregatedItemDescriptor,
  MarketDataArray,
} from '../../shared/types/market-statistics-storage.js';
import type {
  MarketIndicator,
  MarketIndicatorCalculationParams,
} from '../types/market-indicators.js';

interface IndicatorDefinition {
  codec: IndicatorValueCodecName;
  group: string;
  requiresRemovedValues: boolean;
}

export interface IndicatorAffectedRange {
  startIndexAsc: number;
  endIndexAsc: number;
  aggregatedCandles: AggregatedItemDescriptor[];
}

export abstract class BaseIndicator<TState = never>
  implements MarketIndicator {
  public abstract readonly name: string;

  protected abstract readonly definition: IndicatorDefinition;
  protected abstract readonly infiniteRange: boolean;

  public readonly dependencies: readonly string[] = [];

  protected readonly stateByMarket = new Map<string, TState>();

  protected constructor(
    protected readonly affectedValuesCount: number,
  ) {}

  public getStorageConfig(): MarketIndicatorStorageConfig {
    this.validateName();

    const codecIndex = INDICATOR_CODECS.findIndex(
      (codec) => codec.name === this.definition.codec,
    );

    if (codecIndex < 0) {
      throw new Error(
        `Unknown indicator codec "${this.definition.codec}" ` +
        `for indicator "${this.name}"`,
      );
    }

    return {
      name: this.name,
      codecIndex,
      group: this.definition.group,
      requiresRemovedValues: this.definition.requiresRemovedValues,
    };
  }

  public calculate(params: MarketIndicatorCalculationParams): void {
    const values = this.getAscendingValues(params);

    if (values.length === 0) {
      return;
    }

    const rangesBuilder = this.infiniteRange
      ? this.buildAffectedInfiniteRange.bind(this)
      : this.buildAffectedFiniteRanges.bind(this);

    const affectedRanges =
      params.aggregatedItemDescriptors.length === 0
        ? []
        : rangesBuilder(
            params.aggregatedItemDescriptors,
            params.ascending.candles.length,
          );

    values[values.length - 1] = this.singleCalculate(params);

    if (affectedRanges.length > 0) {
      this.rangeCalculate(params, affectedRanges);
    }
  }

  public abstract singleCalculate(
    params: MarketIndicatorCalculationParams,
  ): IndicatorValue;

  public abstract rangeCalculate(
    params: MarketIndicatorCalculationParams,
    affectedRanges: IndicatorAffectedRange[],
  ): void;

  public removeMarket(marketName: string): void {
    this.stateByMarket.delete(marketName);
  }

  protected getAscendingValues(
    params: MarketIndicatorCalculationParams,
  ): MarketDataArray<IndicatorValue> {
    const values = params.ascending.indicators[this.name];

    if (!values) {
      throw new Error(
        `Ascending projection for indicator "${this.name}" not found`,
      );
    }

    return values;
  }

  protected getDescendingValues(
    params: MarketIndicatorCalculationParams,
  ): MarketDataArray<IndicatorValue> {
    const values = params.descending.indicators[this.name];

    if (!values) {
      throw new Error(
        `Descending projection for indicator "${this.name}" not found`,
      );
    }

    return values;
  }

  protected buildAffectedFiniteRanges(
    descriptors: readonly AggregatedItemDescriptor[],
    length: number,
  ): IndicatorAffectedRange[] {
    if (
      descriptors.length === 0 ||
      this.affectedValuesCount <= 0 ||
      length <= 0
    ) {
      return [];
    }

    const ranges: IndicatorAffectedRange[] = [];

    for (const descriptor of descriptors) {
      const startIndexAsc = descriptor.indexAsc;
      const endIndexAsc = Math.min(
        length - 1,
        startIndexAsc + this.affectedValuesCount - 1,
      );

      const lastRange = ranges.at(-1);

      if (!lastRange || startIndexAsc > lastRange.endIndexAsc) {
        ranges.push({
          startIndexAsc,
          endIndexAsc,
          aggregatedCandles: [descriptor],
        });

        continue;
      }

      lastRange.endIndexAsc = Math.max(
        lastRange.endIndexAsc,
        endIndexAsc,
      );

      lastRange.aggregatedCandles.push(descriptor);
    }

    return ranges;
  }

  protected buildAffectedInfiniteRange(
    descriptors: readonly AggregatedItemDescriptor[],
    length: number,
  ): IndicatorAffectedRange[] {
    if (descriptors.length === 0 || length <= 0) {
      return [];
    }

    return [{
      startIndexAsc: descriptors[0].indexAsc,
      endIndexAsc: length - 1,
      aggregatedCandles: [...descriptors],
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
