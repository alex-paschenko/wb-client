// app/src/shared/utilities/bitmap.ts

export class Bitmap {
  private readonly data: Uint32Array;

  public readonly length: number;

  constructor(size: number) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`Invalid Bitmap size: ${size}`);
    }

    this.length = size;
    this.data = new Uint32Array(Math.ceil(size / 32));
  }

  public set(index: number, value: boolean): void {
    this.validateIndex(index);

    const arrayIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    const mask = (1 << bitIndex) >>> 0;

    if (value) {
      this.data[arrayIndex] |= mask;
    } else {
      this.data[arrayIndex] &= ~mask;
    }
  }

  public get(index: number): boolean {
    this.validateIndex(index);

    const arrayIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    const mask = (1 << bitIndex) >>> 0;

    return (this.data[arrayIndex] & mask) !== 0;
  }

  public clearAll(): void {
    this.data.fill(0);
  }

  private validateIndex(index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.length
    ) {
      throw new RangeError(
        `Index ${index} is out of range of Bitmap ` +
        `(0..${this.length - 1})`,
      );
    }
  }
}
