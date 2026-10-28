import type {
  Market,
  MarketFee,
  MarketFeesByName,
} from '../../shared/types/market.js';
import type {
  WhitebitAllMarketFeesResponse,
  WhitebitFeePair,
} from './private-client.js';

function ratio(value: unknown, field: string): number {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid WhiteBIT fee ${field}: ${String(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid WhiteBIT fee ${field}: ${value}`);
  }
  return parsed / 100;
}

function optionalRatio(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return ratio(value, field);
}

function pair(value: WhitebitFeePair, name: string,
  rpiMakerFeePremiumRatio: number | null): MarketFee {
  return {
    makerFeeRatio: ratio(value.maker, `${name}.maker`),
    takerFeeRatio: ratio(value.taker, `${name}.taker`),
    rpiMakerFeePremiumRatio,
  };
}

export function buildMarketFeesByName(
  markets: readonly Market[],
  response: WhitebitAllMarketFeesResponse,
): MarketFeesByName {
  if (!response || response.error != null ||
    !response.custom_fee || typeof response.custom_fee !== 'object' ||
    Array.isArray(response.custom_fee)) {
    throw new Error('Invalid WhiteBIT market fees response');
  }

  const spotRpi = optionalRatio(
    response.rpi_maker_fee_premium, 'rpi_maker_fee_premium');
  const futuresRpi = optionalRatio(
    response.futures_rpi_maker_fee_premium,
    'futures_rpi_maker_fee_premium');
  const spot = pair(response, 'spot', spotRpi);
  const futures = pair({
    maker: response.futures_maker,
    taker: response.futures_taker,
  }, 'futures', futuresRpi);

  const result: MarketFeesByName = Object.create(null);
  for (const market of markets) {
    const override = Object.hasOwn(response.custom_fee, market.name)
      ? response.custom_fee[market.name] : undefined;
    // WhiteBIT exposes spot and futures defaults, with no separate
    // TradFi futures fee category in this response.
    const isFutures = market.type !== 'spot';
    const standard = isFutures ? futures : spot;
    if (override === null) {
      throw new Error(`Invalid WhiteBIT custom fee for ${market.name}`);
    }
    result[market.name] = override
      ? pair(override, market.name, standard.rpiMakerFeePremiumRatio)
      : { ...standard };
  }
  return result;
}
