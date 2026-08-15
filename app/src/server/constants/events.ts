// app/src/server/constants/events.ts

export const SERVER_EVENT = {
  marketsInfoUpdated: 'markets info updated',

  marketRemoved: 'market removed',

  marketRollingTickReceived: 'market rolling tick received',
  marketRollingUpdated: 'market rolling updated',

  marketTickReceived: 'market tick received',

  marketStatisticsStorageChanged: 'market statistics storage changed',
  marketStatisticsIndicatorsChanged:
    'market statistics indicators changed',

  marketStatisticsRestored: 'market statistics restored',

  marketStatisticsPersistenceChanged:
    'market statistics persistence changed',
  marketStatisticsApproximated: 'market statistics approximated',

  marketIndicatorsRegistryReady: 'market indicators registry ready',
  recalculateIndicatorsRequest: 'recalculate indicators request',
  indicatorsRecalculated: 'recalculate indicators results',

  freezeOnStatisticsStorageNeedsToBeLowered:
    'freeze on the statistics storage needs to be lowered',

  strategySignalCreated: 'strategy signal created',
  strategyFailed: 'strategy failed',
} as const;
