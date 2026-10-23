// app/src/shared/constants/orders.ts

import { revert } from '../utilities/object';

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

export const orderStpNames = ['no', 'co', 'cn', 'cb'] as const;

export const orderStatusNames = [
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'CANCELED_STP',
  'CANCELED_TAKER_BAND',
  'CANCELED_RPI',
  'AUTO_CANCELED_REDUCE_ONLY',
  'AUTO_CANCELED_LIQUIDATION',
  'DELISTING',
] as const;

export const orderPositionSideNames = ['LONG', 'SHORT', 'BOTH'] as const;

// Semantic subsets, checked against the canonical lists above.
export const orderFinalStatuses = [
  'FILLED',
  'CANCELED',
  'CANCELED_STP',
  'CANCELED_TAKER_BAND',
  'CANCELED_RPI',
  'AUTO_CANCELED_REDUCE_ONLY',
  'AUTO_CANCELED_LIQUIDATION',
  'DELISTING',
] as const satisfies readonly (typeof orderStatusNames)[number][];

export const orderImmediateTypes = [
  'Market',
  'Market stock',
  'Stop market',
  'Stop market stock',
  'Margin market',
  'Margin stop market',
] as const satisfies readonly (typeof orderTypeNames)[number][];
