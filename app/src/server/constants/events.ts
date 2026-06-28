export const SERVER_EVENT = {
  marketsInfoUpdated: 'markets info updated',

  marketRollingTickReceived: 'market rolling tick received',
  marketRollingUpdated: 'market rolling updated',
  marketStatisticsViewUpdated: 'market statistics view updated',
  marketStatisticsRestored: 'market statistics restored',
  marketTickReceived: 'market tick received',
  marketStatisticsStorageChanged: 'market statistics storage changed',
  marketStatisticsPersistenceChanged: 'market statistics persistence changed',
  marketStatisticsApproximated: 'market statistics approximated',

  freezeOnStatisticsStorageNeedsToBeLowered: 'freeze on the statistics storage needs to be lowered',

  strategySignalCreated: 'strategy signal created',
  strategyFailed: 'strategy failed',
} as const;
