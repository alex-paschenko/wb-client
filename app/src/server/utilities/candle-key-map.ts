// server/utilities/candle-key-map.ts

type ValuesByEndedAt<T> =
  Map<number, T>;

type ValuesByStartedAt<T> =
  Map<number, ValuesByEndedAt<T>>;

export class CandleKeyMap<T> {
  private readonly valuesByLevel =
    new Map<number, ValuesByStartedAt<T>>();

  private valuesCount = 0;

  public get size(): number {
    return this.valuesCount;
  }

  public get(
    level: number,
    startedAt: number,
    endedAt: number,
  ): T | undefined {
    return this.valuesByLevel
      .get(level)
      ?.get(startedAt)
      ?.get(endedAt);
  }

  public has(
    level: number,
    startedAt: number,
    endedAt: number,
  ): boolean {
    return this.valuesByLevel
      .get(level)
      ?.get(startedAt)
      ?.has(endedAt) === true;
  }

  public set(
    level: number,
    startedAt: number,
    endedAt: number,
    value: T,
  ): this {
    let valuesByStartedAt =
      this.valuesByLevel.get(level);

    if (!valuesByStartedAt) {
      valuesByStartedAt =
        new Map<number, ValuesByEndedAt<T>>();

      this.valuesByLevel.set(
        level,
        valuesByStartedAt,
      );
    }

    let valuesByEndedAt =
      valuesByStartedAt.get(startedAt);

    if (!valuesByEndedAt) {
      valuesByEndedAt =
        new Map<number, T>();

      valuesByStartedAt.set(
        startedAt,
        valuesByEndedAt,
      );
    }

    if (!valuesByEndedAt.has(endedAt)) {
      this.valuesCount += 1;
    }

    valuesByEndedAt.set(
      endedAt,
      value,
    );

    return this;
  }

  public delete(
    level: number,
    startedAt: number,
    endedAt: number,
  ): boolean {
    const valuesByStartedAt =
      this.valuesByLevel.get(level);

    if (!valuesByStartedAt) {
      return false;
    }

    const valuesByEndedAt =
      valuesByStartedAt.get(startedAt);

    if (!valuesByEndedAt) {
      return false;
    }

    const deleted =
      valuesByEndedAt.delete(endedAt);

    if (!deleted) {
      return false;
    }

    this.valuesCount -= 1;

    if (valuesByEndedAt.size === 0) {
      valuesByStartedAt.delete(startedAt);
    }

    if (valuesByStartedAt.size === 0) {
      this.valuesByLevel.delete(level);
    }

    return true;
  }

  public deleteBefore(
    level: number,
    timeThreshold: number,
  ): number {
    const valuesByStartedAt = this.valuesByLevel.get(level);

    if (!valuesByStartedAt) {
      return 0;
    }

    let deletedCount = 0;

    for (const [startedAt, valuesByEndedAt] of valuesByStartedAt) {
      for (const endedAt of valuesByEndedAt.keys()) {
        if (endedAt >= timeThreshold) {
          continue;
        }

        valuesByEndedAt.delete(endedAt);
        this.valuesCount -= 1;
        deletedCount += 1;
      }

      if (valuesByEndedAt.size === 0) {
        valuesByStartedAt.delete(startedAt);
      }
    }

    if (valuesByStartedAt.size === 0) {
      this.valuesByLevel.delete(level);
    }

    return deletedCount;
  }

  public clear(): void {
    this.valuesByLevel.clear();
    this.valuesCount = 0;
  }

  public *values(): IterableIterator<T> {
    for (
      const valuesByStartedAt
      of this.valuesByLevel.values()
    ) {
      for (
        const valuesByEndedAt
        of valuesByStartedAt.values()
      ) {
        yield* valuesByEndedAt.values();
      }
    }
  }

  public drain(
    limit = Number.POSITIVE_INFINITY,
  ): T[] {
    if (
      limit <= 0 ||
      this.valuesCount === 0
    ) {
      return [];
    }

    const result: T[] = [];

    for (
      const [
        level,
        valuesByStartedAt,
      ]
      of this.valuesByLevel
    ) {
      for (
        const [
          startedAt,
          valuesByEndedAt,
        ]
        of valuesByStartedAt
      ) {
        for (
          const [
            endedAt,
            value,
          ]
          of valuesByEndedAt
        ) {
          result.push(value);

          valuesByEndedAt.delete(
            endedAt,
          );

          this.valuesCount -= 1;

          if (result.length >= limit) {
            if (
              valuesByEndedAt.size === 0
            ) {
              valuesByStartedAt.delete(
                startedAt,
              );
            }

            if (
              valuesByStartedAt.size === 0
            ) {
              this.valuesByLevel.delete(
                level,
              );
            }

            return result;
          }
        }

        valuesByStartedAt.delete(
          startedAt,
        );
      }

      this.valuesByLevel.delete(level);
    }

    return result;
  }
}
