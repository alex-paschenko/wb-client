// app/src/shared/utilities/awaiters.ts

export class Awaiters<Key, Result> {
  private readonly resolvers = new Map<
    Key,
    (result: Result) => void
  >();

  public wait(key: Key): Promise<Result> {
    if (this.resolvers.has(key)) {
      throw new Error(`Awaiter already exists for key: ${String(key)}`);
    }

    return new Promise<Result>((resolve) => {
      this.resolvers.set(key, resolve);
    });
  }

  public resolve(key: Key, result: Result): void {
    const resolve = this.resolvers.get(key);

    if (!resolve) {
      throw new Error(`Awaiter does not exist for key: ${String(key)}`);
    }

    this.resolvers.delete(key);
    resolve(result);
  }
}
