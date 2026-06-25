import type {
  ServerEventMap,
} from '../types/events.js';

type EventHandler<TPayload> = (
  payload: TPayload,
) => void | Promise<void>;

export class EventBusService {
  private readonly handlers = new Map<
    keyof ServerEventMap,
    Set<EventHandler<ServerEventMap[keyof ServerEventMap]>>
  >();

  public on<TEventName extends keyof ServerEventMap>(
    eventName: TEventName,
    handler: EventHandler<ServerEventMap[TEventName]>,
  ): () => void {
    const handlers = this.getOrCreateHandlers(eventName);

    handlers.add(
      handler as EventHandler<ServerEventMap[keyof ServerEventMap]>,
    );

    return () => {
      handlers.delete(
        handler as EventHandler<ServerEventMap[keyof ServerEventMap]>,
      );
    };
  }

  public emit<TEventName extends keyof ServerEventMap>(
    eventName: TEventName,
    payload: ServerEventMap[TEventName],
  ): void {
    const handlers = this.handlers.get(eventName);

    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      void Promise.resolve(handler(payload)).catch((error: unknown) => {
        console.error('Event handler failed', {
          eventName,
          error,
        });
      });
    }
  }

  private getOrCreateHandlers<TEventName extends keyof ServerEventMap>(
    eventName: TEventName,
  ): Set<EventHandler<ServerEventMap[keyof ServerEventMap]>> {
    let handlers = this.handlers.get(eventName);

    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventName, handlers);
    }

    return handlers;
  }
}

export const eventBus = new EventBusService();
