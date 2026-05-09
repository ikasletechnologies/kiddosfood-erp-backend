import prisma from '../../lib/prisma';

export class SettingsService {
  /**
   * Get all system settings grouped by group name
   */
  static async getAllSettings() {
    return {};
  }

  static async setSetting(key: string, value: string, _group?: string, _description?: string) {
    console.log(`Setting [${key}] to [${value}] (MOCKED - Model deleted)`);
    return { key, value };
  }

  static async getSettingValue(_key: string, defaultValue: string = ''): Promise<string> {
    return defaultValue;
  }

  /**
   * Get core company profile
   */
  static async getCompanyProfile() {
    const raw = await this.getSettingValue('COMPANY_PROFILE', '{}');
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /**
   * Update core company profile
   */
  static async updateCompanyProfile(data: any) {
    const value = JSON.stringify(data);
    return this.setSetting('COMPANY_PROFILE', value, 'GENERAL', 'Enterprise Company Identity Data');
  }
}
