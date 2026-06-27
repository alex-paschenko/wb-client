import { SECONDS } from './time.js';

export const FRONTEND_WS_CLIENT_PING_INTERVAL_MS = 15 * SECONDS;
export const FRONTEND_WS_SERVER_PONG_TIMEOUT_MS = 10 * SECONDS;

export const FRONTEND_WS_SERVER_PING_INTERVAL_MS = 10 * SECONDS;
export const FRONTEND_WS_CLIENT_PONG_TIMEOUT_MS = 30 * SECONDS;

export const FRONTEND_WS_RECONNECT_DELAY_MS = 3 * SECONDS;

export const FRONTEND_WS_BINARY_HEADER_LENGTH_BYTES = 12;

export const FRONTEND_WS_BINARY_HEADER_OFFSETS = {
  messageType: 0,
  serverId: 4,
  clientId: 8,
} as const;

export const FRONTEND_WS_BINARY_MESSAGE_TYPES = {
  fullMarketStatistics: 1,
  marketStatisticsDelta: 2,
} as const;

export const FRONTEND_WS_CONTROL_MESSAGE_TYPES = {
  serverHello: 'serverHello',
  webSocketReady: 'webSocketReady',

  clientPing: 'clientPing',
  serverPong: 'serverPong',

  serverPing: 'serverPing',
  clientPong: 'clientPong',

  requestSettings: 'requestSettings',
  settingsLoaded: 'settingsLoaded',
  settingsChanged: 'settingsChanged',
  settingsAccepted: 'settingsAccepted',

  marketsUpdated: 'marketsUpdated',

  requestMarketStatisticsFullSync: 'requestMarketStatisticsFullSync',

  setSubscription: 'setSubscription',
  changeSubscription: 'changeSubscription',
} as const;

export const FRONTEND_WS_SUBSCRIPTION_ENTITIES = {
  marketInfo: 'marketInfo',
  marketStatistics: 'marketStatistics',
} as const;

export const FRONTEND_WS_SUBSCRIPTION_ACTIONS = {
  add: 'add',
  remove: 'remove',
} as const;
