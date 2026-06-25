import type { StrategyTickContext, TradingStrategy } from '../types/strategy';

export class StrategyEngine {
  private readonly runningStrategies = new Set<string>();

  public constructor(
    private readonly strategies: TradingStrategy[],
  ) {}

  public async onTick(context: StrategyTickContext): Promise<void> {
    const runnableStrategies = this.strategies.filter((strategy) => {
      if (this.runningStrategies.has(strategy.name)) {
        return false;
      }

      this.runningStrategies.add(strategy.name);

      return true;
    });

    if (runnableStrategies.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      runnableStrategies.map(async (strategy) => {
        try {
          await strategy.onTick(context);
        } finally {
          this.runningStrategies.delete(strategy.name);
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Strategy failed', result.reason);
      }
    }
  }
}
