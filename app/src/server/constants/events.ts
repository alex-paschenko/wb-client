// app/src/server/constants/events.ts

export const SERVER_EVENT = {
  marketsInfoUpdated: 'markets info updated',

  marketRemoved: 'market removed',

  marketRollingTickReceived: 'market rolling tick received',
  marketRollingUpdated: 'market rolling updated',

  marketTickReceived: 'market tick received',

  storageSnapshoted: 'storage snapshoted',
  storageDeltaCreated: 'storage delta created',
  storageFullSyncRequest: 'storage full sync request',
  storageFullSyncResults: 'storage full sync results',

  addStorageEntities: 'add storage entities',
  recalculateEntitiesRequest: 'recalculate entities request',
  entitiesRecalculated: 'entities recalculated',
} as const;
