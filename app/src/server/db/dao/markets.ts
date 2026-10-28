// app/src/server/dao/markets.ts


import { q, type Sql } from '../client.js';
import type { SelectParams } from '../../types/db.js';
import type { Market, MarketsByName } from '../../../shared/types/market.js';
import { buildUpsertSet, dbRow } from '../../utilities/db-helpers.js';

export class MarketsDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  private marketsSelect(params?: SelectParams) {
    const q = this.q;

    return q<{ market: Market }[]>`
      select
        json_build_object(
          'name', m.name,
          'stock', m.stock,
          'money', m.money,
          'stockPrec', m.stock_prec,
          'moneyPrec', m.money_prec,
          'feePrec', m.fee_prec,
          'makerFee', m.maker_fee,
          'takerFee', m.taker_fee,
          'minAmount', m.min_amount,
          'minTotal', m.min_total,
          'tradesEnabled', m.trades_enabled,
          'isActive', m.is_active,
          'type', m.type,
          'maxTotal', m.max_total,
          'isCollateral', m.is_collateral,
          'isTradFiFutures', m.is_trad_fi_futures,
          'tickSize', m.tick_size,
          'stepSize', m.step_size,
          'delistedAt', m.delisted_at
        ) as market
      from ${params?.from ?? q`markets`} as m
      ${params?.where ? q`where ${params.where}` : q``}
      ${params?.orderBy ? q`order by ${params.orderBy}` : q``}
      ${params?.limit === undefined ? q`` : q`limit ${params.limit}`}
      ${params?.offset === undefined ? q`` : q`offset ${params.offset}`}
    `;
  }

  public async getAllAlives(): Promise<MarketsByName> {
    const [result] = await this.q<{ marketsByName: MarketsByName }[]>`
      with markets AS (
        ${this.marketsSelect({
          orderBy: this.q`m.name asc`,
          where: this.q`m.trades_enabled and m.is_active`,
        })}
      )
      select
        jsonb_object_agg(
          market->>'name',
          market
        ) as "marketsByName"
        from markets
    `;

    return result.marketsByName ?? {};
  }

  public async getByName(name: string): Promise<Market | null> {
    const [result] = await this.marketsSelect({
      where: this.q`m.name = ${name}`,
      limit: 1,
    });

    return result?.market ?? null;
  }

  public async getAliveByName(
    names: string[],
  ): Promise<Market[]> {
    if (names.length === 0) {
      return [];
    }

    const q = this.q;

    const rows = await this.marketsSelect({
      where: q`m.name = any(${names}) and m.is_active and m.trades_enabled`,
    });

    return rows.map((row) => row.market);
  }

  public async refreshAll(input: Market[]): Promise<void> {
    const q = this.q;

    if (input.length === 0) {
      throw new Error(
        'Markets refresh received empty input. Refusing to deactivate all markets.',
      );
    }

    return q.begin(async (trx) => {
      const insertData = input.map((market) => dbRow({
        ...market,
        isActive: true,
      }));

      const updateColumns = Object.keys(insertData[0]).filter(
        (column) =>
          column !== 'name' &&
          column !== 'is_active' &&
          column !== 'created_at' &&
          column !== 'updated_at',
      );

      const updateSet = buildUpsertSet(trx, updateColumns);

      await trx<{ market: Market }[]>`
        insert into markets ${trx(insertData)}

        on conflict (name)
        do update set
          ${updateSet},
          is_active = true,
          updated_at = now()
      `;

      const names = input.map((market) => market.name);

      await trx`
        update markets
        set
          is_active = false,
          updated_at = now()
        where not (name = any(${names}::text[]))
      `;
    });
  }
}

export const marketsDao = new MarketsDao(q);
