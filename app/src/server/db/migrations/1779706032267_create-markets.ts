import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pg: MigrationBuilder): Promise<void> {
    pg.createTable('markets', {
        name: {
            type: 'text',
            primaryKey: true,
            notNull: true,
        },

        stock: {
            type: 'text',
            notNull: true,
        },

        money: {
            type: 'text',
            notNull: true,
        },

        stock_prec: {
            type: 'integer',
            notNull: true,
        },

        money_prec: {
            type: 'integer',
            notNull: true,
        },

        fee_prec: {
            type: 'integer',
            notNull: true,
        },

        maker_fee: {
            type: 'numeric',
            notNull: true,
        },

        taker_fee: {
            type: 'numeric',
            notNull: true,
        },

        min_amount: {
            type: 'numeric',
            notNull: true,
        },

        min_total: {
            type: 'numeric',
            notNull: true,
        },

        trades_enabled: {
            type: 'boolean',
            notNull: true,
        },

        is_active: {
            type: 'boolean',
            notNull: true,
            default: true,
        },

        type: {
            type: 'text',
            notNull: true,
        },

        max_total: {
            type: 'numeric',
        },

        is_collateral: {
            type: 'boolean',
        },

        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pg.func('now()'),
        },

        updated_at: {
            type: 'timestamptz',
            notNull: true,
            default: pg.func('now()'),
        },
    });

    pg.addConstraint('markets', 'markets_type_check', {
        check: "type IN ('spot', 'futures')",
    });

    pg.addConstraint('markets', 'markets_fees_check', {
        check: 'maker_fee >= 0 AND taker_fee >= 0',
    });

    pg.addConstraint('markets', 'markets_min_values_check', {
        check: 'min_amount >= 0 AND min_total >= 0',
    });

    pg.addConstraint('markets', 'markets_max_total_check', {
        check: 'max_total IS NULL OR max_total >= 0',
    });

    pg.createIndex('markets', ['stock']);
    pg.createIndex('markets', ['money']);
    pg.createIndex('markets', ['type']);
    pg.createIndex('markets', ['trades_enabled']);
    pg.createIndex('markets', ['is_active']);
  }

export async function down(pg: MigrationBuilder): Promise<void> {
    pg.dropTable('markets');
}
