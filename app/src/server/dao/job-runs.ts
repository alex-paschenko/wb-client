import type { Sql } from '../db/client.js';
import { q } from '../db/client.js';

export interface CreateJobRunInput {
  jobName: string;
  status: 'running';
}

export interface FinishJobRunInput {
  id: number;
  status: 'finished' | 'failed';
  result?: object | null;
  errorText?: string | null;
  startedAtMs: number;
}

export class JobRunsDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async create(input: CreateJobRunInput): Promise<number> {
    const q = this.q;

    const rows = await q<{ id: number }[]>`
      insert into job_runs ${q({
        job_name: input.jobName,
        status: input.status,
      })}
      returning id
    `;

    return rows[0]!.id;
  }

  public async finish(input: FinishJobRunInput): Promise<void> {
    const q = this.q;

    await q`
      update job_runs
      set ${q({
        status: input.status,
        result: input.result ? { ...input.result } : null,
        error_text: input.errorText ?? null,
        finished_at: new Date(),
        duration_ms: Date.now() - input.startedAtMs,
      })}
      where id = ${input.id}
    `;
  }
}

export const jobRunsDao = new JobRunsDao(q);
