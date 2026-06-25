import { jobRunsDao } from '../dao/job-runs.js';

export const runJob = async <T extends object>(
  jobName: string,
  job: () => Promise<T>,
): Promise<T> => {
  const startedAtMs = Date.now();
  const jobRunId = await jobRunsDao.create({
    jobName,
    status: 'running',
  });

  try {
    const result = await job();

    await jobRunsDao.finish({
      id: jobRunId,
      status: 'finished',
      result,
      startedAtMs,
    });

    return result;
  } catch (error) {
    await jobRunsDao.finish({
      id: jobRunId,
      status: 'failed',
      errorText: error instanceof Error ? error.stack ?? error.message : String(error),
      startedAtMs,
    });

    throw error;
  }
};
