export function getMiddleTimestamp(
  startedAt: number,
  endedAt: number,
): number {
  return Math.round(startedAt + (endedAt - startedAt) / 2);
}
