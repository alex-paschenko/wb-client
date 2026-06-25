import type {
  FrontendSettings,
} from '../../../shared/services/frontend-settings';
import {
  EventEmitter,
  type EventMapBase,
} from '../utilities/event-emitter';

type AppEventMap = EventMapBase & {
  settingsChanged: [settings: FrontendSettings];
};

export const appEvents = new EventEmitter<AppEventMap>();
