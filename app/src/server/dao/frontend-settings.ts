import type { Sql } from '../db/client.js';
import { q } from '../db/client.js';

import type {
  FrontendSettingsValue,
} from '../../shared/types/frontend-settings.js';

export class FrontendSettingsDao {
  public constructor(
    private readonly q: Sql,
  ) {}

  public async getByUserId(
    userId: number,
  ): Promise<Partial<FrontendSettingsValue> | null> {
    const rows = await this.q<{ settings: Partial<FrontendSettingsValue> }[]>`
      select settings
      from frontend_settings
      where user_id = ${userId}
      limit 1
    `;

    return rows[0]?.settings ?? null;
  }

  public async saveByUserId(
    userId: number,
    settings: FrontendSettingsValue,
  ): Promise<FrontendSettingsValue> {
    const rows = await this.q<{ settings: FrontendSettingsValue }[]>`
      insert into frontend_settings ${
        this.q({
          user_id: userId,
          settings: { ...settings },
        })
      }
      on conflict (user_id)
      do update set
        settings = excluded.settings,
        updated_at = now()
      returning settings
    `;

    return rows[0]!.settings;
  }
}

export const frontendSettingsDao =
  new FrontendSettingsDao(q);
