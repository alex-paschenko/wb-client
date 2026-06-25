export type EventMapBase = Record<string, unknown[]>;

export class EventEmitter<EventMap extends EventMapBase> {
  private readonly events: {
    [EventName in keyof EventMap]?: Set<(
      ...args: EventMap[EventName]
    ) => void>;
  } = {};

  public on<EventName extends keyof EventMap>(
    name: EventName,
    listener: (...args: EventMap[EventName]) => void,
  ): () => void {
    this.events[name] ??= new Set();

    this.events[name].add(listener);

    return () => {
      this.off(name, listener);
    };
  }

  public off<EventName extends keyof EventMap>(
    name: EventName,
    listener: (...args: EventMap[EventName]) => void,
  ): void {
    this.events[name]?.delete(listener);
  }

  public emit<EventName extends keyof EventMap>(
    name: EventName,
    ...args: EventMap[EventName]
  ): void {
    for (const listener of this.events[name] ?? []) {
      listener(...args);
    }
  }

  public clear<EventName extends keyof EventMap>(
    name?: EventName,
  ): void {
    if (name === undefined) {
      for (const eventName of Object.keys(this.events) as EventName[]) {
        delete this.events[eventName];
      }

      return;
    }

    delete this.events[name];
  }
}
