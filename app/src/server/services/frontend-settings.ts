import { frontendSettingsDao } from '../dao/frontend-settings.js';
import { AppError } from '../errors/app-error.js';

import { isTheme } from '../../shared/constants/themes.js';
import { isLanguageCode } from '../../shared/i18n/languages.js';
import { FrontendSettings as FrontendSettingsModel } from '../../shared/services/frontend-settings.js';
import {
  isMarketViewState,
  type FrontendSettingsValue,
  type MarketViewStateItem,
} from '../../shared/types/frontend-settings.js';

export class FrontendSettingsService {
  public async getByUserId(
    userId: number,
  ): Promise<FrontendSettingsValue> {
    const savedSettings =
      await frontendSettingsDao.getByUserId(userId);

    if (!savedSettings) {
      return FrontendSettingsModel.createDefault().toValue();
    }

    return FrontendSettingsModel.fromValue({
      ...FrontendSettingsModel.createDefault().toValue(),
      ...savedSettings,
      marketsViewStates: savedSettings.marketsViewStates ?? [],
    }).toValue();
  }

  public async saveByUserId(
    userId: number,
    input: unknown,
  ): Promise<FrontendSettingsValue> {
    const settings = this.validateSettings(input);

    return frontendSettingsDao.saveByUserId(
      userId,
      settings,
    );
  }

  private validateSettings(
    input: unknown,
  ): FrontendSettingsValue {
    if (!input || typeof input !== 'object') {
      throw new AppError('errors.invalidSettingsPayload', 400);
    }

    const body = input as Record<string, unknown>;

    if (!isTheme(body.theme)) {
      throw new AppError('errors.invalidTheme', 400);
    }

    if (!isLanguageCode(body.language)) {
      throw new AppError('errors.invalidLanguage', 400);
    }

    if (!Array.isArray(body.marketsViewStates)) {
      throw new AppError('errors.invalidSettingsPayload', 400);
    }

    const marketsViewStates = body.marketsViewStates
      .map((item): MarketViewStateItem => {
        if (!item || typeof item !== 'object') {
          throw new AppError('errors.invalidSettingsPayload', 400);
        }

        const marketItem = item as Record<string, unknown>;

        if (typeof marketItem.marketName !== 'string') {
          throw new AppError('errors.invalidSettingsPayload', 400);
        }

        if (!isMarketViewState(marketItem.state)) {
          throw new AppError('errors.invalidSettingsPayload', 400);
        }

        return {
          marketName: marketItem.marketName,
          state: marketItem.state,
        };
      });

    return {
      theme: body.theme,
      language: body.language,
      marketsViewStates,
    };
  }
}

export const frontendSettingsService =
  new FrontendSettingsService();
