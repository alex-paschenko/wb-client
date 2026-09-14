// app/src/shared/utilities/bitmap.ts

export class Bitmap {
  private data: Uint32Array;

  private itemsCount: number;

  public constructor(size: number) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`Invalid Bitmap size: ${size}`);
    }

    this.itemsCount = size;
    this.data = new Uint32Array(Math.ceil(size / 32));
  }

  public get length(): number {
    return this.itemsCount;
  }

  public set(index: number, value: boolean): void {
    this.validateIndex(index);
    this.setUnchecked(index, value);
  }

  public get(index: number): boolean {
    this.validateIndex(index);
    return this.getUnchecked(index);
  }

  public addAfter(index: number, value = true): void {
    if (
      !Number.isSafeInteger(index) ||
      index < -1 ||
      index >= this.itemsCount
    ) {
      throw new RangeError(
        `Index ${index} is out of range for Bitmap insertion ` +
        `(-1..${this.itemsCount - 1})`,
      );
    }

    const insertIndex = index + 1;
    const oldLength = this.itemsCount;

    this.ensureCapacity(oldLength + 1);

    for (let current = oldLength; current > insertIndex; current--) {
      this.setUnchecked(current, this.getUnchecked(current - 1));
    }

    this.setUnchecked(insertIndex, value);
    this.itemsCount += 1;
  }

  public deleteItems(index: number, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Invalid Bitmap delete count: ${count}`);
    }

    if (count === 0) {
      return;
    }

    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index + count > this.itemsCount
    ) {
      throw new RangeError(
        `Cannot delete ${count} Bitmap items from index ${index} ` +
        `(length: ${this.itemsCount})`,
      );
    }

    const oldLength = this.itemsCount;
    const newLength = oldLength - count;

    for (let current = index; current < newLength; current++) {
      this.setUnchecked(current, this.getUnchecked(current + count));
    }

    for (let current = newLength; current < oldLength; current++) {
      this.setUnchecked(current, false);
    }

    this.itemsCount = newLength;
  }

  public clearAll(): void {
    this.data.fill(0);
  }

  private ensureCapacity(size: number): void {
    const requiredWords = Math.ceil(size / 32);

    if (requiredWords <= this.data.length) {
      return;
    }

    const nextWords = Math.max(requiredWords, this.data.length * 2, 1);
    const data = new Uint32Array(nextWords);

    data.set(this.data);
    this.data = data;
  }

  private getUnchecked(index: number): boolean {
    const arrayIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    const mask = (1 << bitIndex) >>> 0;

    return (this.data[arrayIndex] & mask) !== 0;
  }

  private setUnchecked(index: number, value: boolean): void {
    const arrayIndex = Math.floor(index / 32);
    const bitIndex = index % 32;
    const mask = (1 << bitIndex) >>> 0;

    if (value) {
      this.data[arrayIndex] |= mask;
    } else {
      this.data[arrayIndex] &= ~mask;
    }
  }

  private validateIndex(index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.itemsCount
    ) {
      throw new RangeError(
        `Index ${index} is out of range of Bitmap ` +
        `(0..${this.itemsCount - 1})`,
      );
    }
  }
}
