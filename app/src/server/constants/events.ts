// app/src/server/constants/events.ts

export const SERVER_EVENT = {
  marketsInfoUpdated: 'markets info updated',

  marketRemoved: 'market removed',

  marketRollingTickReceived: 'market rolling tick received',
  marketRollingUpdated: 'market rolling updated',

  marketTickReceived: 'market tick received',

  marketStatisticsStorageChanged: 'market statistics storage changed',
  marketStatisticsIndicatorsChanged: 'market statistics indicators changed',

  marketStatisticsRestored: 'market statistics restored',

  storageSnapshoted: 'storage snapshoted',
  storageDeltaCreated: 'storage delta created',
  storageFullSyncRequest: 'storage full sync request',
  storageFullSyncResults: 'storage full sync results',

  marketStatisticsApproximated: 'market statistics approximated',

  addStorageEntities: 'add storage entities',
  recalculateEntitiesRequest: 'recalculate entities request',
  entitiesRecalculated: 'entities recalculated',

  freezeOnStorageNeedsToBeLowered: 'freeze on storage needs to be lowered',

  strategySignalCreated: 'strategy signal created',
  strategyFailed: 'strategy failed',
} as const;
