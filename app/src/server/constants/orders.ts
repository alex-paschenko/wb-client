// app/src/server/constants/orders.ts

function revert(obj: Record<number, string>): Record<string, number> {
  return Object.entries(obj).reduce<Record<string, number>>(
    (acc, [key, value]) => {
      acc[value] = Number(key);
      return acc;
    },
    {},
  );
}

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
} as const;

export const orderSides = {
  1: 'sell',
  2: 'buy',
} as const;

export const orderTypesRevert = revert(orderTypes);

export const orderSidesRevert = revert(orderSides);
