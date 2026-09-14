// app/src/shared/utilities/object.ts

type Decrement = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

type InfiniteReadonly<T> = {
  readonly [P in keyof T]:
    T[P] extends object ? InfiniteReadonly<T[P]> : T[P];
};

type DeepReadonlyWithDepth<T, Depth extends number> =
  [Depth] extends [0]
    ? T
    : {
        readonly [P in keyof T]:
          T[P] extends object
            ? DeepReadonlyWithDepth<T[P], Decrement[Depth]>
            : T[P];
      };

export type DeepReadonly<T, Depth extends number = number> =
  number extends Depth
    ? InfiniteReadonly<T>
    : DeepReadonlyWithDepth<T, Depth>;

function deepFreezeRecursive<T extends object>(
  obj: T,
  deep: number,
  currentDeep: number,
): T {
  for (const name of Reflect.ownKeys(obj)) {
    const value = (obj as Record<PropertyKey, unknown>)[name];

    if (
      value &&
      typeof value === 'object' &&
      !Object.isFrozen(value) &&
      currentDeep < deep
    ) {
      deepFreezeRecursive(value, deep, currentDeep + 1);
    }
  }

  return Object.freeze(obj);
}

export function deepFreeze<T extends object, D extends number = number>(
  obj: T,
  deep: D = Infinity as D,
): DeepReadonly<T, D> {
  return deepFreezeRecursive(obj, deep, 1) as DeepReadonly<T, D>;
}

export function getterBinder(
  classDescriptor: (...args: any) => any,
  instance: unknown,
  getterName: string,
) {
  Object.defineProperty(instance, getterName, {
    get: () => {
      return Object.getOwnPropertyDescriptor(
        classDescriptor.prototype,
        getterName,
      )!.get!.call(instance);
    },
    configurable: true,
    enumerable: true
  });
}
