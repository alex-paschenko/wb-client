// app/src/client/src/utilities/event-emitter.ts

export type EventMapBase = Record<string, unknown[]>;

export type EventResultMapBase<EventMap extends EventMapBase> =
  Partial<Record<keyof EventMap, unknown>>;

type ConditionType = string | symbol;

const zeroCondition = Symbol('Zero Condition');
const wideDeleting = Symbol('Wide deleting');

type EventKey<EventName extends string | number | symbol> =
  | EventName
  | {
      eventName: EventName;
      condition: ConditionType;
    };

type EventResult<
  EventMap extends EventMapBase,
  ResultMap extends EventResultMapBase<EventMap>,
  EventName extends keyof EventMap,
> =
  EventName extends keyof ResultMap
    ? ResultMap[EventName]
    : void;

export class EventEmitter<
  EventMap extends EventMapBase,
  ResultMap extends EventResultMapBase<EventMap> = {},
> {
  private readonly events = new Map<
    keyof EventMap,
    Map<ConditionType, Set<(...args: any[]) => unknown>>
  >();

  public on<EventName extends keyof EventMap>(
    name: EventName,
    listener: (
      ...args: EventMap[EventName]
    ) => EventResult<EventMap, ResultMap, EventName>,
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

    listeners.add(listener);

    return () => {
      this.off(name, listener, condition);
    };
  }

  public off<EventName extends keyof EventMap>(
    name: EventName,
    listener: (
      ...args: EventMap[EventName]
    ) => EventResult<EventMap, ResultMap, EventName>,
    condition: ConditionType = wideDeleting,
  ): boolean {
    const conditions = this.events.get(name);

    if (!conditions) {
      return false;
    }

    if (condition !== wideDeleting) {
      return conditions.get(condition)?.delete(listener) ?? false;
    }

    let hasDeleted = false;

    for (const listeners of conditions.values()) {
      if (listeners.delete(listener)) {
        hasDeleted = true;
      }
    }

    return hasDeleted;
  }

  public emit<EventName extends keyof EventMap>(
    event: EventKey<EventName>,
    ...args: EventMap[EventName]
  ): EventResult<EventMap, ResultMap, EventName>[] {
    const results:
      EventResult<EventMap, ResultMap, EventName>[] = [];

    if (
      typeof event === 'object' &&
      event !== null &&
      'eventName' in event
    ) {
      const listeners = this.events
        .get(event.eventName)
        ?.get(event.condition);

      for (const listener of listeners ?? []) {
        results.push(
          listener(...args) as
            EventResult<EventMap, ResultMap, EventName>,
        );
      }

      return results;
    }

    const conditions = this.events.get(event);

    for (const listeners of conditions?.values() ?? []) {
      for (const listener of listeners) {
        results.push(
          listener(...args) as
            EventResult<EventMap, ResultMap, EventName>,
        );
      }
    }

    return results;
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
