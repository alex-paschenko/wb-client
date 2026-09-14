// app/src/shared/constants/binary-kinds.ts

export const BINARY_KINDS = [
  'snapshot',
  'delta',
] as const;

export type BinaryKind = typeof BINARY_KINDS[number];
