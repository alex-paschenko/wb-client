// app/src/server/utilities/freezing.ts
export class Freezing {
  private freezingByKey: Map<string, number> = new Map();

  constructor(
    private readonly unfreeze: (key: string) => void,
  ) {}

  cool(key: string): void {
    this.freezingByKey.set(
      key,
      (this.freezingByKey.get(key) ?? 0) - 1,
    );
  }

  warm(key: string): void {
    const currentValue = this.freezingByKey.get(key);

    if (!this.isValue(currentValue)) {
      throw new Error(`Can\t warm "${key}": the key not found.`);
    }

    if (currentValue >= 0) {
      throw new Error(`Too hot "${key}".`);
    }

    this.freezingByKey.set(key, currentValue + 1);

    if (!this.isFrozen(key)) {
      this.unfreeze(key);
    }
  }

  isFrozen(key: string): boolean {
    return (this.freezingByKey.get(key) ?? 0) < 0;
  }

  private isValue(value: unknown): value is number {
    return typeof value === 'number';
  }
}
