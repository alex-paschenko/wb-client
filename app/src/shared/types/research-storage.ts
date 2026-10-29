// Values are recorded once per tick while an order book subscription is active.
export interface ResearchTick {
  receivedAt: number;
  price: number;
  emaPrice7: number | null;
  emaLog7: number | null;
  emaLog15: number | null;
  emaLog30: number | null;
  emaLog60: number | null;
  forecast3: number | null;
  forecast4: number | null;
  forecastCombined: number | null;
}

export interface ResearchSnapshot {
  marketName: string;
  startedAt: number;
  endedAt: number;
  numOfItems: number;
  data: Uint8Array;
}
