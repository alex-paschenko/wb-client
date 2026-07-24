// app/src/client/src/services/StartupService.ts

import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import type {
  MarketIndicatorsRegistry,
} from '../../../shared/types/market-indicators';
import type {
  MarketsByName,
} from '../../../shared/types/market';

import {
  appEvents,
} from '../events/app-events';

export interface SynchronizationContext {
  settings: FrontendSettings;
  markets: MarketsByName;
  indicatorRegistry: MarketIndicatorsRegistry;
}

type PartialSynchronizationContext =
  Partial<SynchronizationContext>;

interface SynchronizationStep<
  TInput = SynchronizationContext,
  TOutput = TInput,
> {
  stepName: string;

  execute(
    context: TInput,
    signal: AbortSignal,
  ): Promise<TOutput>;
}

class SynchronizationCancelledError extends Error {
  public constructor() {
    super('Synchronization cancelled');

    this.name = 'SynchronizationCancelledError';
  }
}

export class SynchronizationService {
  private activeAbortController:
    | AbortController
    | null = null;

  public async run(): Promise<void> {
    this.activeAbortController?.abort();

    const abortController =
      new AbortController();

    this.activeAbortController =
      abortController;

    const {
      signal,
    } = abortController;

    const startupSteps = {
      getPrimaryData: {
        stepName:
          'startup.steps.getPrimaryData',

        execute:
          this.getPrimaryData,
      } satisfies SynchronizationStep<
        PartialSynchronizationContext,
        SynchronizationContext
      >,

      processPrimaryData: {
        stepName:
          'startup.steps.processPrimaryData',

        execute:
          this.processPrimaryData,
      } satisfies SynchronizationStep,
    } as const;

    this.emitStartupState(
      'startup.started',
    );

    try {
      const context =
        await this.executeStep(
          startupSteps.getPrimaryData,
          {},
          signal,
        );

      await this.executeStep(
        startupSteps.processPrimaryData,
        context,
        signal,
      );

      this.throwIfCancelled(
        signal,
      );

      this.emitStartupState(
        'startup.completed',
      );

      appEvents.emit(
        'synchronizationCompleted',
      );
    } catch (error) {
      if (
        error instanceof
          SynchronizationCancelledError
      ) {
        return;
      }

      this.emitStartupState(
        'startup.failed',
      );

      appEvents.emit(
        'synchronizationFailed',
        error,
      );

      throw error;
    } finally {
      if (
        this.activeAbortController ===
        abortController
      ) {
        this.activeAbortController =
          null;
      }
    }
  }

  public cancel(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
  }

  private readonly executeStep = async <
    TInput,
    TOutput,
  >(
    step: SynchronizationStep<
      TInput,
      TOutput
    >,
    context: TInput,
    signal: AbortSignal,
  ): Promise<TOutput> => {
    this.throwIfCancelled(
      signal,
    );

    this.emitStartupState(
      step.stepName,
    );

    const result =
      await step.execute(
        context,
        signal,
      );

    this.throwIfCancelled(
      signal,
    );

    return result;
  };

  private readonly getPrimaryData = (
    context: PartialSynchronizationContext,
    signal: AbortSignal,
  ): Promise<SynchronizationContext> =>
    new Promise<SynchronizationContext>(
      (resolve, reject) => {
        let settings:
          | FrontendSettings
          | undefined;

        let markets:
          | MarketsByName
          | undefined;

        let indicatorRegistry:
          | MarketIndicatorsRegistry
          | undefined;

        let isSettled = false;

        let unsubscribeSettings =
          (): void => undefined;

        let unsubscribeMarkets =
          (): void => undefined;

        let unsubscribeIndicatorRegistry =
          (): void => undefined;

        let unsubscribeConnectionState =
          (): void => undefined;

        const handleAbort = (): void => {
          rejectOnce(
            new SynchronizationCancelledError(),
          );
        };

        const unsubscribe = (): void => {
          unsubscribeSettings();
          unsubscribeMarkets();
          unsubscribeIndicatorRegistry();
          unsubscribeConnectionState();

          signal.removeEventListener(
            'abort',
            handleAbort,
          );
        };

        const resolveOnce = (
          startupContext: SynchronizationContext,
        ): void => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          unsubscribe();

          resolve(
            startupContext,
          );
        };

        const rejectOnce = (
          error: unknown,
        ): void => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          unsubscribe();

          reject(
            error,
          );
        };

        const tryResolve = (): void => {
          if (
            settings === undefined ||
            markets === undefined ||
            indicatorRegistry === undefined
          ) {
            return;
          }

          resolveOnce({
            ...context,
            settings,
            markets,
            indicatorRegistry,
          });
        };

        unsubscribeSettings =
          appEvents.on(
            'startupSettingsReceived',
            (receivedSettings) => {
              settings =
                receivedSettings;

              tryResolve();
            },
          );

        unsubscribeMarkets =
          appEvents.on(
            'marketsUpdated',
            (receivedMarkets) => {
              markets =
                receivedMarkets;

              tryResolve();
            },
          );

        unsubscribeIndicatorRegistry =
          appEvents.on(
            'startupIndicatorRegistryReceived',
            (receivedIndicatorRegistry) => {
              indicatorRegistry = receivedIndicatorRegistry;

              tryResolve();
            },
          );

        unsubscribeConnectionState =
          appEvents.on(
            'frontendWsConnectionStateChanged',
            (isConnected) => {
              if (isConnected) {
                return;
              }

              rejectOnce(
                new SynchronizationCancelledError(),
              );
            },
          );

        signal.addEventListener(
          'abort',
          handleAbort,
          {
            once: true,
          },
        );

        if (signal.aborted) {
          handleAbort();
          return;
        }

        try {
          appEvents.emit(
            'requestSettings',
          );

          appEvents.emit(
            'subscribeMarketInfo',
          );

          appEvents.emit(
            'requestMarketIndicatorsRegistry',
          );
        } catch (error) {
          rejectOnce(
            error,
          );
        }
      },
    );

  private readonly processPrimaryData = async (
    context: SynchronizationContext,
    signal: AbortSignal,
  ): Promise<SynchronizationContext> => {
    this.throwIfCancelled(
      signal,
    );

    const originalSettingsValue =
      context.settings.toValue();

    context.settings.ensureMarkets(
      context.markets,
    );

    context.settings.ensureIndicators(
      context.indicatorRegistry,
    );

    this.throwIfCancelled(
      signal,
    );

    const processedSettingsValue =
      context.settings.toValue();

    appEvents.emit(
      'synchronizationSettingsProcessed',
      context.settings,
    );

    if (
      JSON.stringify(originalSettingsValue) !==
      JSON.stringify(processedSettingsValue)
    ) {
      appEvents.emit(
        'settingsChanged',
        context.settings,
      );
    }

    return context;
  };

  private throwIfCancelled(
    signal: AbortSignal,
  ): void {
    if (signal.aborted) {
      throw new SynchronizationCancelledError();
    }
  }

  private emitStartupState(
    stateKey: string,
  ): void {
    appEvents.emit(
      'synchronizationStateChanged',
      stateKey,
    );
  }
}

export const synchronizationService =
  new SynchronizationService();
