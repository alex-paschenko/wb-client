export type ControllerStateListener<TState> = (
  state: TState,
) => void;

export type ControllerUnsubscribe = () => void;

type StateUpdater<TState> = (
  state: TState,
) => TState;

export class BaseController<TState> {
  private listeners = new Set<ControllerStateListener<TState>>();

  public constructor(
    private state: TState,
  ) {}

  public start(): void {}

  public stop(): void {}

  public getState(): TState {
    return this.state;
  }

  public subscribe(
    listener: ControllerStateListener<TState>,
  ): ControllerUnsubscribe {
    this.listeners.add(listener);
    listener(this.state);

    return () => {
      this.listeners.delete(listener);
    };
  }

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
