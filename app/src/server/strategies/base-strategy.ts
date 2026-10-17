import { strategyIdleState } from '../constants/strategies.js';
import type {
  Strategy,
  StrategyStates,
  StrategyRunParams,
} from '../types/strategies.js';

export abstract class BaseStrategy<T extends string>
  implements Strategy<T> {
  private strategyName: string;

  constructor(name: string) {
    this.strategyName = name;
  }

  public run(params: StrategyRunParams<T>): void {
    const receivedAt = params.storage[params.storage.length - 1].receivedAt;

    if (params.stateChanges.length === 0) {
      params.stateChanges.push({
        receivedAt,
        state: strategyIdleState,
      });
    }

    let currentStatus: StrategyStates<T>;

    do {
      const prevState = params.stateChanges.at(-1)?.state;

      currentStatus = this.exec(params);

      if (
        currentStatus.action === 'continue' &&
        currentStatus.state === prevState
      ) {
        throw new Error(
          `${this.name}: continue without a state change (${prevState})`,
        );
      }

      if (prevState !== currentStatus.state) {
        params.stateChanges.push({
          receivedAt,
          state: currentStatus.state,
        });
      }
    } while (currentStatus.action !== 'stop');
  }

  public get name(): string {
    return this.strategyName;
  }

  protected abstract exec(
    params: StrategyRunParams<T>,
  ): StrategyStates<T>;
}
