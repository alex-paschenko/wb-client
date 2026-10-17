// app/src/server/dao/sequences.ts

import { q, type Sql } from '../db/client.js';

class SequencesDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async getNextOrderId(): Promise<number> {
    const [{ id: rawId }] = await this.q<{ id: string }[]>`
      SELECT nextval('public.order_id_seq') AS id
    `;

    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) {
      throw new RangeError('Order ID exceeds safe integer range');
    }

    return id;
  }
}

export const sequencesDao = new SequencesDao(q);
