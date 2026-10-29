import { q, type Sql } from '../client.js';
import type { ResearchSnapshot } from '../../../shared/types/research-storage.js';
import {
  RESEARCH_REPACK_BATCH_SIZE,
} from '../../constants/persistence.js';

export interface ResearchStorageRow extends ResearchSnapshot {}

export interface ResearchRepackMarket {
  marketName: string;
  numOfItemsToRepack: number;
}

export class ResearchStorageDao {
  public constructor(private readonly q: Sql) {}

  public async insert(snapshots: readonly ResearchSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    const rows = snapshots.map((s) => this.toInsertRow(s));
    await this.q`
      insert into research_storage ${this.q(rows)}
      on conflict (market_name, ended_at) do nothing
    `;
  }

  public async getRepackMarkets(): Promise<ResearchRepackMarket[]> {
    const rows = await this.q<ResearchRepackMarket[]>`
      select market_name as "marketName",
        sum(num_of_items) as "numOfItemsToRepack"
      from research_storage
      where num_of_items < ${RESEARCH_REPACK_BATCH_SIZE}
      group by market_name
      having sum(num_of_items) >= ${RESEARCH_REPACK_BATCH_SIZE}
      order by "numOfItemsToRepack" desc
    `;
    return rows.map((row) => ({
      marketName: row.marketName,
      numOfItemsToRepack: Number(row.numOfItemsToRepack),
    }));
  }

  public async getShortByMarketName(
    marketName: string,
    afterEndedAt: number | null,
    limit: number,
  ): Promise<ResearchStorageRow[]> {
    const rows = await this.q<ResearchStorageRow[]>`
      select market_name as "marketName", started_at as "startedAt",
        ended_at as "endedAt", num_of_items as "numOfItems", data
      from research_storage
      where market_name = ${marketName}
        and num_of_items < ${RESEARCH_REPACK_BATCH_SIZE}
        ${afterEndedAt === null ? this.q`` : this.q`and ended_at > ${afterEndedAt}`}
      order by ended_at
      limit ${limit}
    `;
    return rows.map((row) => ({
      ...row,
      startedAt: Number(row.startedAt),
      endedAt: Number(row.endedAt),
      numOfItems: Number(row.numOfItems),
    }));
  }

  public async replaceBatch(
    marketName: string,
    oldEndedAts: readonly number[],
    replacement: ResearchSnapshot,
  ): Promise<void> {
    if (oldEndedAts.length === 0 || replacement.marketName !== marketName) {
      throw new Error('Invalid research replacement batch');
    }
    await this.q.begin(async (tx) => {
      const deleted = await tx<{ endedAt: number }[]>`
        delete from research_storage
        where market_name = ${marketName}
          and ended_at = any(${[...oldEndedAts]}::bigint[])
        returning ended_at as "endedAt"
      `;
      if (deleted.length !== oldEndedAts.length) {
        throw new Error(`Research rows changed during repack: ${marketName}`);
      }
      await tx`insert into research_storage ${tx(this.toInsertRow(replacement))}`;
    });
  }

  private readonly toInsertRow = (row: ResearchSnapshot) => ({
    market_name: row.marketName,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    num_of_items: row.numOfItems,
    data: row.data,
  });
}

export const researchStorageDao = new ResearchStorageDao(q);
