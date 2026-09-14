// app/src/server/services/storage-chunk-set-id.ts

import { storageDao } from '../dao/storage.js';

const CHUNK_SET_ID_STEP = 256;

const serverId = Number(process.env.SERVER_ID ?? 0);

if (
  !Number.isSafeInteger(serverId) ||
  serverId < 0 ||
  serverId >= CHUNK_SET_ID_STEP
) {
  throw new TypeError(`Invalid SERVER_ID (${serverId})`);
}

class StorageChunkSetIdService {
  private chunkSetId: number | null = null;

  public async start(): Promise<void> {
    if (this.chunkSetId !== null) {
      throw new Error('StorageChunkSetIdService is already started');
    }

    const lastChunkSetId =
      await storageDao.getCurrentChunkSetId(serverId);
    this.chunkSetId = lastChunkSetId ?? serverId - CHUNK_SET_ID_STEP;
  }

  public getNextChunkSetId(): number {
    if (this.chunkSetId === null) {
      throw new Error('StorageChunkSetIdService is not started');
    }

    const chunkSetId = this.chunkSetId + CHUNK_SET_ID_STEP;

    if (!Number.isSafeInteger(chunkSetId)) {
      throw new RangeError(
        `Chunk set ID exceeds safe integer range: ${chunkSetId}`,
      );
    }

    this.chunkSetId = chunkSetId;

    return chunkSetId;
  }
}

const storageChunkSetIdService = new StorageChunkSetIdService();

export const startStorageChunkSetIdService = () =>
  storageChunkSetIdService.start();

export const getNextChunkSetId = () =>
  storageChunkSetIdService.getNextChunkSetId();