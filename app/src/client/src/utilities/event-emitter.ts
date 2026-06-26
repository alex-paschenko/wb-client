export type EventMapBase = Record<string, unknown[]>;

type ConditionType = string | symbol;

const zeroCondition = Symbol('Zero Condition');
const wideDeleting = Symbol('Wide deleting');

export class EventEmitter<EventMap extends EventMapBase> {
  private readonly events: {
    [EventName in keyof EventMap]?:
      {
        [condition: (string | symbol)]:
          Set<(...args: EventMap[EventName]) => void>;
      }
  } = {};

  public on<EventName extends keyof EventMap>(
    name: EventName,
    listener: (...args: EventMap[EventName]) => void,
    condition: ConditionType = zeroCondition,
  ): () => void {
    this.events[name] ??= {};
    this.events[name][condition] ??= new Set();

    this.events[name][condition].add(listener);

    return () => {
      this.off(name, listener, condition);
    };
  }

  public off<EventName extends keyof EventMap>(
    name: EventName,
    listener: (...args: EventMap[EventName]) => void,
    condition: ConditionType = wideDeleting,
  ): boolean {
    if (condition === wideDeleting) {
      return Object.values(this.events[name] ?? {}).some(
        (listeners) => listeners.delete(listener)
      );
    }

    return this.events[name]?.[condition]?.delete(listener) ?? false;
  }

  public emit<EventName extends keyof EventMap>(
    event: EventName | { eventName: EventName, condition: string },
    ...args: EventMap[EventName]
  ): void {
    if ('object' === typeof event) {
      for (const listener of this.events[event.eventName]?.[event.condition] ?? []) {
        listener(...args);
      }
    } else {
      for (const listeners of Object.values(this.events[event] ?? {})) {
        for (const listener of listeners) {
          listener(...args);
        }
      }
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
