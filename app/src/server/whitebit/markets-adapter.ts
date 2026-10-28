import type { Market } from '../../shared/types/market.js';
import type { WhitebitMarket } from '../../shared/types/whitebit-api.js';
import { whitebitClient } from './public-client.js';

function numeric(
  value: string,
  market: string,
  field: string,
): number {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid WhiteBIT ${market}.${field}: ${String(value)}`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid WhiteBIT ${market}.${field}: "${value}"`);
  }

  return number;
}

function precision(
  value: string,
  market: string,
  field: string,
): number {
  const number = numeric(value, market, field);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Invalid WhiteBIT precision ${market}.${field}`);
  }
  return number;
}

function optionalStep(
  value: string,
  market: string,
  field: string,

): number | null {
  if (value === '') return null;
  const number = numeric(value, market, field);
  if (number <= 0) {
    throw new Error(`Invalid WhiteBIT step ${market}.${field}: ${value}`);
  }
  return number;
}

export function normalizeMarket(raw: WhitebitMarket): Market {
  if (
    !raw ||
    typeof raw.name !== 'string' ||
    !raw.name ||
    typeof raw.stock !== 'string' ||
    !raw.stock ||
    typeof raw.money !== 'string' ||
    !raw.money ||
    typeof raw.tradesEnabled !== 'boolean' ||
    typeof raw.isCollateral !== 'boolean' ||
    typeof raw.isTradFiFutures !== 'boolean' ||
    !['spot', 'futures', 'tradfiFutures'].includes(raw.type) ||
    raw.isTradFiFutures !== (raw.type === 'tradfiFutures') ||
    (raw.delistedAt !== null &&
      (!Number.isSafeInteger(raw.delistedAt) || raw.delistedAt < 0))
  ) {
    throw new Error(`Invalid WhiteBIT market: ${String(raw?.name)}`);
  }

  return {
    name: raw.name,
    stock: raw.stock,
    money: raw.money,
    stockPrec: precision(raw.stockPrec, raw.name, 'stockPrec'),
    moneyPrec: precision(raw.moneyPrec, raw.name, 'moneyPrec'),
    feePrec: precision(raw.feePrec, raw.name, 'feePrec'),
    makerFee: numeric(raw.makerFee, raw.name, 'makerFee') / 100,
    takerFee: numeric(raw.takerFee, raw.name, 'takerFee') / 100,
    minAmount: numeric(raw.minAmount, raw.name, 'minAmount'),
    minTotal: numeric(raw.minTotal, raw.name, 'minTotal'),
    maxTotal: numeric(raw.maxTotal, raw.name, 'maxTotal'),
    tradesEnabled: raw.tradesEnabled,
    isActive: true,
    isCollateral: raw.isCollateral,
    isTradFiFutures: raw.isTradFiFutures,
    type: raw.type,
    delistedAt: raw.delistedAt,
    tickSize: optionalStep(raw.tickSize, raw.name, 'tickSize'),
    stepSize: optionalStep(raw.stepSize, raw.name, 'stepSize'),
  };
}

export async function getMarkets(): Promise<Market[]> {
  const raw = await whitebitClient.getMarkets();
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Empty or invalid WhiteBIT markets response');
  }
  const markets = raw.map(normalizeMarket);
  const names = new Set(markets.map((market) => market.name));
  if (names.size !== markets.length) {
    throw new Error('Duplicate WhiteBIT market names');
  }
  return markets;
}
