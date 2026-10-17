// app/src/shared/constants/orders.ts

type Reverted<T extends Record<number, string>> = {
  [K in keyof T & number as T[K]]: K;
};

function revert<const T extends Record<number, string>>(
  obj: T,
): Reverted<T> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [value, Number(key)]),
  ) as Reverted<T>;
}

export const orderTypeNames = [
  'Limit',
  'Market',
  'Market stock',
  'Stop limit',
  'Stop market',
  'Stop market stock',
  'Margin limit',
  'Margin market',
  'Margin stop limit',
  'Margin stop market',
  'Margin normalization',
] as const;

export const orderTypes = {
  1: 'Limit',
  2: 'Market',
  202: 'Market stock',
  3: 'Stop limit',
  4: 'Stop market',
  203: 'Stop market stock',
  7: 'Margin limit',
  8: 'Margin market',
  9: 'Margin stop limit',
  10: 'Margin stop market',
  14: 'Margin normalization',
} as const satisfies Record<number, (typeof orderTypeNames)[number]>;

export const orderSideNames = ['sell', 'buy'] as const;

export const orderSides = {
  1: 'sell',
  2: 'buy',
} as const satisfies Record<number, (typeof orderSideNames)[number]>;

export const orderTypesRevert = revert(orderTypes);

export const orderSidesRevert = revert(orderSides);
