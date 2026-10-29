// app/src/server/constants/events.ts

export const SERVER_EVENT = {
  marketDataUpdated: 'market data updated',

  marketRemoved: 'market removed',

  marketRollingTickReceived: 'market rolling tick received',
  marketRollingUpdated: 'market rolling updated',

  marketTickReceived: 'market tick received',

  storageSnapshoted: 'storage snapshoted',
  researchPersistenceRequest: 'research persistence request',
  storageDeltaCreated: 'storage delta created',
  storageFullSyncRequest: 'storage full sync request',
  storageFullSyncResults: 'storage full sync results',

  addStorageEntities: 'add storage entities',
  recalculateEntitiesRequest: 'recalculate entities request',
  entitiesRecalculated: 'entities recalculated',

  orderBookDepthSubscription: 'order book depth subscriprion',
  orderBookDepthUpdate: 'order book depth update',

  runStrategiesRequest: 'run strategies request',
  strategiesCompleted: 'strategies completed',

  orderRequestResult: 'order request result',
  createOrderRequestAndSubscribe: 'create order request and subscribe',
  orderUpdated: 'order updated',
  orderCancelRequest: 'order cancel request',

  depthPersistenceRequest: 'depth persistence request',
  orderPersistenceRequest: 'order persistence request',
  strategyStatePersistenceRequest: 'strategy state persistence request',
} as const;
