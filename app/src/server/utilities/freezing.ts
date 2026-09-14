// app/src/server/utilities/freezing.ts

interface FreezingStatus {
  temperature: number;
  isFrozen: boolean;
};

export class Freezing {
  private freezingByKey: Map<string, FreezingStatus> = new Map();

  constructor(
    private readonly onUnfreeze: (key: string) => void,
  ) {}

  cool(key: string): void {
    const { temperature, isFrozen } = this.freezingByKey.get(key) ??
      { temperature: 0, isFrozen: false };

    this.freezingByKey.set(
      key,
      { temperature: temperature - 1, isFrozen }
    );
  }

  coolAndIce(key: string): void {
    const { temperature } = this.freezingByKey.get(key) ??
      { temperature: 0 };

    this.freezingByKey.set(
      key,
      { temperature: temperature - 1, isFrozen: true }
    );
  }

  warm(key: string): void {
    const currentStatus = this.freezingByKey.get(key);

    this.validateWarming(key, currentStatus);

    const { temperature, isFrozen } = currentStatus;

    this.freezingByKey.set(
      key,
      {
        temperature: temperature + 1,
        isFrozen: isFrozen
      }
    );

    if (!this.isCold(key)) {
      if (isFrozen) {
        throw new Error(
          `We can't heat ${key} to zero or above without melting the ice.`,
        );
      }

      this.onUnfreeze(key);
    }
  }

  warmAndMeltIce(key: string): void {
    const currentStatus = this.freezingByKey.get(key);

    this.validateWarming(key, currentStatus);

    this.freezingByKey.set(
      key,
      { temperature: currentStatus.temperature + 1, isFrozen: false }
    );

    if (!this.isCold(key)) {
      this.onUnfreeze(key);
    }
  }

  isCold(key: string): boolean | null {
    const temperature = this.freezingByKey.get(key)?.temperature;
    return typeof temperature === 'undefined' ? null : temperature < 0;
  }

  isIcy(key: string): boolean | null {
    return this.freezingByKey.get(key)?.isFrozen ?? null;
  }

  private validateWarming(
    key: string,
    statusBeforeWarming: FreezingStatus | undefined,
  ): asserts statusBeforeWarming is FreezingStatus {
    if (typeof statusBeforeWarming !== 'object') {
      throw new Error(`Can\t warm "${key}": the key not found.`);
    }

    const { temperature } = statusBeforeWarming;

    if (temperature >= 0) {
      throw new Error(`Too hot "${key}".`);
    }
  }
}
