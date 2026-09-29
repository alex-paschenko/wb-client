import { CANDLE_NAME } from '../../shared/constants/storage-entities.js';
import { Storage } from '../../shared/services/storage.js';
import type { MarketCandle } from '../../shared/types/data-types.js';
import type { MarketTick } from '../../shared/types/ticks.js';
import { decodeCodec } from '../../shared/utilities/codecs/codecs.js';
import {
  decodeEntireBinary,
} from '../../shared/utilities/codecs/entire-binary-codec.js';
import type { LazyArray } from '../../shared/utilities/lazy-array.js';

export const readArchiveTicks = (
  binary: Uint8Array,
  marketName: string,
): MarketTick[] => {
  const entire = decodeEntireBinary(binary);

  if (entire.binaryKind !== 'snapshot' ||
      entire.parameters?.marketName !== marketName) {
    throw new Error(`Invalid archive binary kind: ${marketName}`);
  }

  if (entire.codecName === 'ticks v1.0') {
    return decodeCodec('ticks v1.0', entire.data);
  }

  if (entire.codecName !== 'snapshot v1.0') {
    throw new Error(`Unknown archive codec: ${entire.codecName}`);
  }

  const storage = new Storage(marketName);
  storage.applySnapshot({ codecName: entire.codecName, data: entire.data });
  const candles = storage.getAccessors().candles[CANDLE_NAME] as
    LazyArray<MarketCandle>;
  const ticks: MarketTick[] = [];

  for (let index = storage.levelBoundaries[0];
    index < storage.size; index++) {
    const { receivedAt, price } = candles.get(index);
    ticks.push({ receivedAt, price });
  }

  return ticks;
};
