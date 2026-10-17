// app/src/server/dao/strategy-state.ts

import { q, type Sql } from '../db/client.js';
import type { StrategyStateChangePersistence } from '../types/persistence.js';

export interface StrategyStateRow extends StrategyStateChangePersistence {
  stateSequence: number;
}

export class StrategyStateDao {
  public constructor(private readonly q: Sql) {}

  public async insert(
    changes: readonly StrategyStateRow[],
  ): Promise<void> {
    if (changes.length === 0) return;
    await this.q`
      INSERT INTO strategy_state_history ${this.q(
        changes.map((change) => ({
          market_name: change.marketName,
          strategy_name: change.strategyName,
          received_at: change.receivedAt,
          state_sequence: change.stateSequence,
          state: change.state,
        })),
        'market_name', 'strategy_name', 'received_at',
        'state_sequence', 'state',
      )}
      ON CONFLICT (received_at, state_sequence) DO NOTHING
    `;
  }
}

export const strategyStateDao = new StrategyStateDao(q);
