// app/src/server/constants/persistence.ts

export const isCpuProfiling = process.execArgv.some(
  (arg) => arg.startsWith('--cpu-prof'),
);

export const SNAPSHOT_BATCH_SIZE = 5;

export const ARCHIVE_REPACK_BATCH_SIZE = 100_000;
export const ARCHIVE_REPACK_PAGE_SIZE = 250;

export const RESEARCH_BUFFER_SIZE = 10_000;
export const RESEARCH_REPACK_BATCH_SIZE = 20_000;
export const RESEARCH_REPACK_PAGE_SIZE = 250;
