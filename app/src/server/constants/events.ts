export const SERVER_EVENT = {
  marketsInfoUpdated: 'markets info updated',

  marketRemoved: 'market removed',

  marketRollingTickReceived: 'market rolling tick received',
  marketRollingUpdated: 'market rolling updated',

  marketTickReceived: 'market tick received',

  marketStatisticsStorageChanged: 'market statistics storage changed',
  marketStatisticsStorageUpdated: 'market statistics storage updated',

  marketStatisticsViewUpdated: 'market statistics view updated',
  marketStatisticsRestored: 'market statistics restored',
  marketStatisticsPersistenceChanged: 'market statistics persistence changed',
  marketStatisticsApproximated: 'market statistics approximated',

  marketIndicatorsUpdated: 'market indicators updated',

  freezeOnStatisticsStorageNeedsToBeLowered:
    'freeze on the statistics storage needs to be lowered',

  strategySignalCreated: 'strategy signal created',
  strategyFailed: 'strategy failed',
} as const;
