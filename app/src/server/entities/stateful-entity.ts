// app/src/server/entities/stateful-entity.ts

import { BaseEntity } from './base-entity.js';

export abstract class StatefulEntity<T, TState> extends BaseEntity<T> {
  protected readonly stateByMarket = new Map<string, TState>();

  public override removeMarket(marketName: string): void {
    this.stateByMarket.delete(marketName);
  }
}
