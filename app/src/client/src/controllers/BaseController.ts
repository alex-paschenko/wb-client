// app/src/client/src/controllers/BaseController.ts
export type ControllerStateListener<TState> = (
  state: TState,
) => void;

export type ControllerUnsubscribe = () => void;

export type ControllerUnusedCallback = () => void;

type StateUpdater<TState> = (
  state: TState,
) => TState;

export class BaseController<TState> {
  private readonly listeners =
    new Set<ControllerStateListener<TState>>();

  private subscribers = 0;

  public constructor(
    private state: TState,
    private readonly onUnused?: ControllerUnusedCallback,
  ) {}

  public getState(): TState {
    return this.state;
  }

  public hasSubscribers(): boolean {
    return this.subscribers > 0;
  }

  public subscribe(
    listener: ControllerStateListener<TState>,
  ): ControllerUnsubscribe {
    this.listeners.add(listener);
    this.subscribers += 1;

    if (this.subscribers === 1) {
      this.onFirstSubscriber();
    }

    listener(this.state);

    let isSubscribed = true;

    return () => {
      if (!isSubscribed) {
        return;
      }

      isSubscribed = false;

      this.listeners.delete(listener);
      this.subscribers -= 1;

      if (this.subscribers !== 0) {
        return;
      }

      this.onLastSubscriber();
      this.onUnused?.();
    };
  }

  protected onFirstSubscriber(): void {}

  protected onLastSubscriber(): void {}

  protected setState(
    nextState: TState | StateUpdater<TState>,
  ): void {
    this.state =
      typeof nextState === 'function'
        ? (nextState as StateUpdater<TState>)(this.state)
        : nextState;

    this.notify();
  }

  protected patchState(
    patch: Partial<TState>,
  ): void {
    this.setState({
      ...this.state,
      ...patch,
    });
  }

  protected notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
