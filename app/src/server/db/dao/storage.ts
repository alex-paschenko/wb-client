// app/src/server/dao/storage.ts

import { q, type Sql } from '../client.js';
import type {
  ActiveStoragePersistenceSnapshot,
  ArchiveStoragePersistenceSnapshot,
  StoragePersistenceSnapshot,
} from '../../../shared/types/storage.js';
import { ARCHIVE_REPACK_BATCH_SIZE } from '../../constants/persistence.js';

export interface StorageArchiveRow extends StoragePersistenceSnapshot {
  numOfItems: number;
}

export interface ArchiveRepackMarket {
  marketName: string;
  numOfItemsToRepack: number;
}

interface StorageSnapshotInsertRow {
  market_name: string;
  started_at: number;
  ended_at: number;
  data: Uint8Array;
}

interface ArchiveSnapshotInsertRow extends StorageSnapshotInsertRow {
  num_of_items: number;
}

export class StorageDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async upsertAlive(
    snapshots: readonly ActiveStoragePersistenceSnapshot[],
  ): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const rows = snapshots.map(this.toInsertRow);

    await this.q`
      insert into storage_alive ${
        this.q(rows, 'market_name', 'started_at', 'ended_at', 'data')
      }
      on conflict (market_name)
      do update set
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        data = excluded.data,
        updated_at = now()
    `;
  }

  public async getAliveForRestore(
    marketNames: string[],
  ): Promise<StoragePersistenceSnapshot[]> {
    return this.q<StoragePersistenceSnapshot[]>`
      select
        market_name as "marketName",
        started_at as "startedAt",
        ended_at as "endedAt",
        data
      from storage_alive
      where market_name = any(${marketNames}::text[])
    `;
  }

  public async getAliveMarketNames(): Promise<string[]> {
    const rows = await this.q<{ marketName: string }[]>`
      select market_name as "marketName"
      from storage_alive
      order by market_name
    `;

    return rows.map((row) => row.marketName);
  }

  public async getLastArchiveEndedAt(
    marketName: string,
  ): Promise<number> {
    const [row] = await this.q<{ endedAt: number }[]>`
      select coalesce(max(ended_at), 0) as "endedAt"
      from storage_archive
      where market_name = ${marketName}
    `;

    return Number(row?.endedAt ?? 0);
  }

  public async getArchiveMarketNames(): Promise<string[]> {
    const rows = await this.q<{ marketName: string }[]>`
      select distinct market_name as "marketName"
      from storage_archive
      order by market_name
    `;

    return rows.map((row) => row.marketName);
  }

  public async getArchiveByMarketName(
    marketName: string,
    afterEndedAt?: number,
    limit?: number,
  ): Promise<StorageArchiveRow[]> {
    const rows = await this.q<StorageArchiveRow[]>`
      select
        market_name as "marketName",
        started_at as "startedAt",
        ended_at as "endedAt",
        num_of_items as "numOfItems",
        data
      from storage_archive
      where market_name = ${marketName}
        ${afterEndedAt === undefined ? this.q`` :
          this.q`and ended_at > ${afterEndedAt}`}
      order by ended_at
      ${limit === undefined ? this.q`` : this.q`limit ${limit}`}
    `;

    return rows.map(this.toArchiveRow);
  }

  public async getArchiveRepackMarkets(): Promise<ArchiveRepackMarket[]> {
    const rows = await this.q<ArchiveRepackMarket[]>`
      select
        market_name as "marketName",
        sum(num_of_items) as "numOfItemsToRepack"
      from storage_archive
      where num_of_items < ${ARCHIVE_REPACK_BATCH_SIZE}
      group by market_name
      having sum(num_of_items) >= ${ARCHIVE_REPACK_BATCH_SIZE}
      order by "numOfItemsToRepack" desc
    `;

    return rows.map((row) => ({
      marketName: row.marketName,
      numOfItemsToRepack: Number(row.numOfItemsToRepack),
    }));
  }

  public async getShortArchiveByMarketName(
    marketName: string,
    afterEndedAt: number | null,
    limit: number,
  ): Promise<StorageArchiveRow[]> {
    const rows = await this.q<StorageArchiveRow[]>`
      select
        market_name as "marketName",
        started_at as "startedAt",
        ended_at as "endedAt",
        num_of_items as "numOfItems",
        data
      from storage_archive
      where market_name = ${marketName}
        and num_of_items < ${ARCHIVE_REPACK_BATCH_SIZE}
        ${afterEndedAt === null ? this.q`` :
          this.q`and ended_at > ${afterEndedAt}`}
      order by ended_at
      limit ${limit}
    `;

    return rows.map(this.toArchiveRow);
  }

  public async replaceArchiveBatch(
    marketName: string,
    oldEndedAts: readonly number[],
    replacement: ArchiveStoragePersistenceSnapshot | null,
  ): Promise<void> {
    if (oldEndedAts.length === 0) {
      throw new Error('Empty archive replacement batch');
    }

    await this.q.begin(async (tx) => {
      const deleted = await tx<{ endedAt: number }[]>`
        delete from storage_archive
        where market_name = ${marketName}
          and ended_at = any(${[...oldEndedAts]}::bigint[])
        returning ended_at as "endedAt"
      `;

      if (deleted.length !== oldEndedAts.length) {
        throw new Error(`Archive changed during repack: ${marketName}`);
      }

      if (replacement) {
        if (replacement.marketName !== marketName) {
          throw new Error('Archive replacement market mismatch');
        }

        await tx`
          insert into storage_archive ${
            tx(this.toArchiveInsertRow(replacement))
          }
        `;
      }
    });
  }

  public async insertArchive(
    snapshots: readonly ArchiveStoragePersistenceSnapshot[],
  ): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const rows = snapshots.map(this.toArchiveInsertRow);

    await this.q`
      insert into storage_archive ${this.q(rows)}
      on conflict (market_name, ended_at) do nothing
    `;
  }

  private readonly toInsertRow = (
    snapshot: StoragePersistenceSnapshot,
  ): StorageSnapshotInsertRow => ({
    market_name: snapshot.marketName,
    started_at: snapshot.startedAt,
    ended_at: snapshot.endedAt,
    data: snapshot.data,
  });

  private readonly toArchiveInsertRow = (
    snapshot: ArchiveStoragePersistenceSnapshot,
  ): ArchiveSnapshotInsertRow => ({
    ...this.toInsertRow(snapshot),
    num_of_items: snapshot.numOfItems,
  });

  private readonly toArchiveRow = (
    row: StorageArchiveRow,
  ): StorageArchiveRow => ({
    ...row,
    startedAt: Number(row.startedAt),
    endedAt: Number(row.endedAt),
    numOfItems: Number(row.numOfItems),
  });
}

export const storageDao = new StorageDao(q);
