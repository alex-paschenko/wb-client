// app/src/server/entities/indicators/incremental-indicator.ts

import type { IndicatorValue } from '../../../shared/types/data-types.js';
import type { StorageAccessors } from '../../../shared/types/storage.js';
import type { EntityDesriptor } from '../../../shared/types/storage-entities.js';
import type { EntityAffectedRange } from '../../types/entities.js';
import { StatefulEntity } from '../stateful-entity.js';

export abstract class IncrementalIndicator<TState = never>
extends StatefulEntity<IndicatorValue, TState> {
  protected constructor(
    descriptor: EntityDesriptor<IndicatorValue>,
    dependencies: readonly string[] = [],
  ) {
    super(descriptor, dependencies);
  }

  public calculate(
    accessors: StorageAccessors,
    marketName: string,
  ): void {
    const values = this.getValues(accessors);

    if (values.length === 0) {
      return;
    }

    const changedIntervals = this.getChangedIntervals(accessors);

    if (changedIntervals.length === 0) {
      return;
    }

    if (
      changedIntervals.length === 1 &&
      changedIntervals[0][0] === values.length - 1 &&
      changedIntervals[0][1] === 1
    ) {
      values.set(
        values.length - 1,
        this.singleCalculate(accessors, marketName),
      );

      return;
    }

    const affectedRanges = this.buildFiniteAffectedRanges(
      accessors,
      1,
      changedIntervals,
    );

    this.rangeCalculate(accessors, marketName, affectedRanges);
  }

  protected singleCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): IndicatorValue {
    return this.stateByMarket.has(marketName)
      ? this.incrementalCalculate(accessors, marketName)
      : this.fullCalculate(accessors, marketName);
  }

  protected abstract incrementalCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): IndicatorValue;

  protected abstract fullCalculate(
    accessors: StorageAccessors,
    marketName: string,
  ): IndicatorValue;

  protected abstract rangeCalculate(
    accessors: StorageAccessors,
    marketName: string,
    affectedRanges: EntityAffectedRange[],
  ): void;
}
