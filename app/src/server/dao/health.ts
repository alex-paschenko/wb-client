import { q } from '../db/client.js';
import type { Sql } from '../db/client.js';

export class HealthDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async getNow(): Promise<Date | null> {
    const [result] = await q<{ now: Date }[]>`
      select now() as now
    `;

    return result?.now;
  }
}

export const healthDao = new HealthDao(q);
