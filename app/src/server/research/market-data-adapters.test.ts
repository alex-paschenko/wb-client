import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WhitebitMarket } from '../../shared/types/whitebit-api.js';
import { GlobalStateService } from '../../shared/services/global-state.js';
import { normalizeMarket } from '../whitebit/markets-adapter.js';
import { buildMarketFeesByName } from '../whitebit/market-fees-adapter.js';

const raw: WhitebitMarket = {
  name: 'BTC_USDT',
  stock: 'BTC',
  money: 'USDT',
  stockPrec: '8',
  moneyPrec: '2',
  feePrec: '4',
  makerFee: '0.1',
  takerFee: '0.075',
  minAmount: '0.0001',
  minTotal: '5',
  maxTotal: '0',
  tradesEnabled: true,
  isCollateral: true,
  isTradFiFutures: false,
  type: 'spot',
  delistedAt: null,
  tickSize: '0.01',
  stepSize: '',
};

const response = {
  error: null,
  maker: '0.1',
  taker: '0.2',
  futures_maker: '0.03',
  futures_taker: '0.05',
  custom_fee: {
    BTC_USDT: { maker: '0.09', taker: '0.08' },
  },
  rpi_maker_fee_premium: '0.015',
  futures_rpi_maker_fee_premium: null,
};

test('market metadata converts numeric strings and percentages', () => {
  const market = normalizeMarket(raw);
  assert.equal(market.makerFee, 0.001);
  assert.equal(market.takerFee, 0.00075);
  assert.equal(market.stockPrec, 8);
  assert.equal(market.maxTotal, 0);
  assert.equal(market.stepSize, null);
  assert.equal(market.tickSize, 0.01);
  assert.throws(() => normalizeMarket({ ...raw, tickSize: 'NaN' }));
  assert.throws(() => normalizeMarket({ ...raw, minTotal: '' }));
});

test('complete personal fees map uses overrides and defaults', () => {
  const market = normalizeMarket(raw);
  const other = { ...market, name: 'ETH_USDT' };
  const futures = {
    ...market,
    name: 'BTC_PERP',
    type: 'futures' as const,
  };
  const fees = buildMarketFeesByName(
    [market, other, futures], response,
  );

  assert.deepEqual(Object.keys(fees).sort(), [
    'BTC_PERP', 'BTC_USDT', 'ETH_USDT',
  ]);
  assert.equal(fees.BTC_USDT.makerFeeRatio, 0.0009);
  assert.equal(fees.BTC_USDT.takerFeeRatio, 0.0008);
  assert.equal(fees.ETH_USDT.takerFeeRatio, 0.002);
  assert.equal(fees.BTC_PERP.takerFeeRatio, 0.0005);
  assert.equal(fees.BTC_USDT.rpiMakerFeePremiumRatio, 0.00015);
  assert.throws(() => buildMarketFeesByName([market], {
    ...response, custom_fee: null as never,
  }));
});

test('global market state becomes ready with markets and fees together', async () => {
  const state = new GlobalStateService();
  const market = normalizeMarket(raw);
  const fees = buildMarketFeesByName([market], response);
  const updates: number[] = [];

  const unsubscribe = state.subscribeMarkets((markets, _names, rates) => {
    if (markets && rates) updates.push(rates.BTC_USDT.takerFeeRatio);
  });
  state.setMarketData({ BTC_USDT: market }, fees);
  assert.equal((await state.waitForMarkets()).BTC_USDT.stockPrec, 8);
  assert.equal(state.getMarketFees().BTC_USDT.takerFeeRatio, 0.0008);
  assert.deepEqual(updates, [0.0008]);

  state.clearMarkets();
  assert.equal(state.getMarketFeesOrNull(), null);
  unsubscribe();
});
