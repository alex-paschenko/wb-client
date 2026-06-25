export interface AssetBalance {
  available: string;
  freeze: string;
}

export type UserBalance = Record<string, AssetBalance>;
