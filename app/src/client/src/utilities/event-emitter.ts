export type EventMapBase = Record<string, unknown[]>;

type ConditionType = string | symbol;

const zeroCondition = Symbol('Zero Condition');
const wideDeleting = Symbol('Wide deleting');

type EventKey<EventName extends string | number | symbol> =
  | EventName
  | {
      eventName: EventName;
      condition: ConditionType;
    };

export class EventEmitter<EventMap extends EventMapBase> {
  private readonly events = new Map<
    keyof EventMap,
    Map<ConditionType, Set<(...args: EventMap[keyof EventMap]) => void>>
  >();

  public on<EventName extends keyof EventMap>(
    name: EventName,
    listener: (...args: EventMap[EventName]) => void,
    condition: ConditionType = zeroCondition,
  ): () => void {
    let conditions = this.events.get(name);

    if (!conditions) {
      conditions = new Map();
      this.events.set(name, conditions);
    }

    let listeners = conditions.get(condition);

    if (!listeners) {
      listeners = new Set();
      conditions.set(condition, listeners);
    }

    listeners.add(
      listener as (...args: EventMap[keyof EventMap]) => void,
    );

    return () => {
      this.off(name, listener, condition);
    };
  }

  public off<EventName extends keyof EventMap>(
    name: EventName,
    listener: (...args: EventMap[EventName]) => void,
    condition: ConditionType = wideDeleting,
  ): boolean {
    const conditions = this.events.get(name);

    if (!conditions) {
      return false;
    }

    const storedListener =
      listener as (...args: EventMap[keyof EventMap]) => void;

    if (condition !== wideDeleting) {
      return conditions.get(condition)?.delete(storedListener) ?? false;
    }

    let hasDeleted = false;

    for (const listeners of conditions.values()) {
      if (listeners.delete(storedListener)) {
        hasDeleted = true;
      }
    }

    return hasDeleted;
  }

  public emit<EventName extends keyof EventMap>(
    event: EventKey<EventName>,
    ...args: EventMap[EventName]
  ): void {
    if (
      typeof event === 'object' &&
      event !== null &&
      'eventName' in event
    ) {
      const listeners = this.events
        .get(event.eventName)
        ?.get(event.condition);

      for (const listener of listeners ?? []) {
        listener(...args);
      }

      return;
    }

    const conditions = this.events.get(event);

    for (const listeners of conditions?.values() ?? []) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  }

  public clear<EventName extends keyof EventMap>(
    name?: EventName,
  ): void {
    if (name === undefined) {
      this.events.clear();
      return;
    }

    this.events.delete(name);
  }
}
