// app/src/server/dao/storage.ts

import { q, type Sql } from '../db/client.js';
import type {
  StoragePersistenceSnapshot,
} from '../../shared/types/storage.js';

export interface StorageArchiveRow extends StoragePersistenceSnapshot {}

interface StorageSnapshotInsertRow {
  market_name: string;
  started_at: number;
  ended_at: number;
  data: Uint8Array;
}

export class StorageDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async upsertAlive(
    snapshots: readonly StoragePersistenceSnapshot[],
  ): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const rows = snapshots.map(this.toInsertRow);

    await this.q`
      insert into storage_alive ${
        this.q(
          rows,
          'market_name',
          'started_at',
          'ended_at',
          'data',
        )
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
    const rows = await this.q<{
      marketName: string;
    }[]>`
      select
        market_name as "marketName"
      from storage_alive
      order by market_name
    `;

    return rows.map((row) => row.marketName);
  }

  public async deleteAlives(
    marketName: string,
  ): Promise<void> {
    await this.q`
      delete from storage_alive
      where market_name = ${marketName}
    `;
  }

  public async getLastArchiveEndedAt(
    marketName: string,
  ): Promise<number> {
    const [row] = await this.q<{ endedAt: number }[]>`
      select coalesce(max(ended_at), 0) as "endedAt"
      from storage_archive
      where market_name = ${marketName}
    `;

    return row?.endedAt ?? 0;
  }

  public async getArchiveMarketNames(): Promise<string[]> {
    const rows = await this.q<{ marketName: string }[]>`
      select distinct
        market_name as "marketName"
      from storage_archive
      order by market_name
    `;

    return rows.map((row) => row.marketName);
  }

  public async getArchiveByMarketName(
    marketName: string,
  ): Promise<StorageArchiveRow[]> {
    return this.q<StorageArchiveRow[]>`
      select
        market_name as "marketName",
        started_at as "startedAt",
        ended_at as "endedAt",
        data
      from storage_archive
      where market_name = ${marketName}
      order by ended_at
    `;
  }

  public async insertArchive(
    snapshots: readonly StoragePersistenceSnapshot[],
  ): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const rows = snapshots.map(this.toInsertRow);

    await this.q`
      insert into storage_archive ${
        this.q(
          rows,
          'market_name',
          'started_at',
          'ended_at',
          'data',
        )
      }
      on conflict (market_name, ended_at)
      do nothing
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
}

export const storageDao = new StorageDao(q);
