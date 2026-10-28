// app/src/server/dao/strategy-state.ts

import { q, type Sql } from '../client.js';
import { revertStrategyChangeType } from '../../constants/strategies.js';
import type { StrategyStateChangePersistence } from '../../types/persistence.js';

export type StrategyStateRow = StrategyStateChangePersistence & {
  stateSequence: number;
};

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
          kind: revertStrategyChangeType[change.kind],
          error_code: change.kind === 'error' ? change.errorCode : null,
          stock: change.kind === 'rests' ? change.stock : null,
          money: change.kind === 'rests' ? change.money : null,
        })),
        'market_name',
        'strategy_name',
        'received_at',
        'state_sequence',
        'state',
        'kind',
        'error_code',
        'stock',
        'money',
      )}
      ON CONFLICT (received_at, state_sequence) DO NOTHING
    `;
  }
}

export const strategyStateDao = new StrategyStateDao(q);
