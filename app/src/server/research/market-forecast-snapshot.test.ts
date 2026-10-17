import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORAGE_CHUNK_CAPACITY } from '../../shared/constants/storage-config.js';
import { globalStateService } from '../../shared/services/global-state.js';
import type { StorageChunkSet } from '../../shared/types/storage.js';
import type { EntityDesriptor } from '../../shared/types/storage-entities.js';
import { decodeCodec, entityBinaryCodec } from '../../shared/utilities/codecs/codecs.js';
import {
  decodeEntireBinary,
  encodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import { MarketForecastIndicator } from '../entities/indicators/market-forecast.js';

test('old five-horizon snapshot restores with a blank three-model forecast', () => {
  const legacy = {
    kind: 'indicators', name: 'market-forecast', codec: 'market forecast v1.0',
    data: [], requiresRemovedValues: false,
    empty: {
      expectedReturn10s: null, expectedReturn30s: null,
      expectedReturn1m: null, expectedReturn2m: null,
      expectedReturn5m: null,
    },
  } as const satisfies EntityDesriptor;
  const oldCodec = entityBinaryCodec(legacy.codec);
  const bytes = new Uint8Array(oldCodec.size * STORAGE_CHUNK_CAPACITY);
  const view = new DataView(bytes.buffer);
  oldCodec.writeByItemIndex(0, view, {
    expectedReturn10s: 0.1, expectedReturn30s: 0.2,
    expectedReturn1m: 0.3, expectedReturn2m: 0.4,
    expectedReturn5m: 0.5,
  });
  const chunks = {
    candles: {}, indicators: {
      'market-forecast': { data: bytes, view },
    },
  } as unknown as StorageChunkSet['chunks'];
  const encoded = encodeEntireBinary({
    codecName: 'snapshot v1.0',
    binaryKind: 'snapshot',
    parameters: { marketName: 'BTC_USDT' },
    data: { chunkSets: [{
      level: 0, start: 0, end: 1, size: 1,
      startedAt: 1000, endedAt: 1000, chunks,
    }] },
  }, { entities: [legacy] });

  const previous = globalStateService.getStorageEntities();
  try {
    globalStateService.setStorageEntities([
      new MarketForecastIndicator().descriptor,
    ]);
    const binary = decodeEntireBinary(encoded);
    const restored = decodeCodec('snapshot v1.0', binary.data) as
      { chunkSets: StorageChunkSet[] };
    const migrated = restored.chunkSets[0].chunks.indicators['market-forecast'];
    assert.deepEqual(entityBinaryCodec('market forecast v2.0')
      .readByItemIndex(0, migrated.view), {
      expectedResidual1m3Ema: null,
      expectedResidual1m4Ema: null,
      expectedResidual1mCombined: null,
    });
  } finally {
    globalStateService.setStorageEntities(previous);
  }
});
