// app/src/shared/types/order-book-depth.ts

export type OrderBookDepthBet = [price: number, amount: number];

export interface OrderBookDepth {
  timestamp: number;
  event_time: number;
  asks: OrderBookDepthBet[];
  bids: OrderBookDepthBet[];
}
