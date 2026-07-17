// app/src/client/src/services/controller-registry.ts
import {
  MarketStatisticsController,
} from '../controllers/MarketStatisticsController';

export class ControllerRegistry {
  private readonly marketStatistics =
    new Map<string, MarketStatisticsController>();

  public getMarketStatisticsController(
    marketName: string,
  ): MarketStatisticsController {
    const existing =
      this.marketStatistics.get(marketName);

    if (existing) {
      return existing;
    }

    const created =
      this.createMarketStatisticsController(
        marketName,
      );

    this.marketStatistics.set(
      marketName,
      created,
    );

    return created;
  }

  public removeMarketStatisticsController(
    marketName: string,
  ): boolean {
    const controller =
      this.marketStatistics.get(marketName);

    if (
      !controller ||
      controller.hasSubscribers()
    ) {
      return false;
    }

    return this.marketStatistics.delete(
      marketName,
    );
  }

  public clear(): void {
    for (
      const [marketName, controller]
      of this.marketStatistics
    ) {
      if (!controller.hasSubscribers()) {
        this.marketStatistics.delete(
          marketName,
        );
      }
    }
  }

  private createMarketStatisticsController(
    marketName: string,
  ): MarketStatisticsController {
    let controller:
      MarketStatisticsController;

    controller =
      new MarketStatisticsController(
        marketName,
        {
          onUnused: () => {
            this.scheduleMarketStatisticsControllerRemoval(
              marketName,
              controller,
            );
          },
        },
      );

    return controller;
  }

  private scheduleMarketStatisticsControllerRemoval(
    marketName: string,
    controller: MarketStatisticsController,
  ): void {
    queueMicrotask(() => {
      if (controller.hasSubscribers()) {
        return;
      }

      if (
        this.marketStatistics.get(marketName) !==
        controller
      ) {
        return;
      }

      this.marketStatistics.delete(
        marketName,
      );
    });
  }
}

export const controllerRegistry =
  new ControllerRegistry();
