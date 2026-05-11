import prisma from '../../lib/prisma';

export class SettingsService {
  /**
   * Get all system settings grouped by group name
   */
  static async getAllSettings() {
    return prisma.systemSetting.findMany();
  }

  static async setSetting(key: string, value: string, group: string = 'GENERAL', description?: string) {
    return prisma.systemSetting.upsert({
      where: { key },
      update: { value, group, description },
      create: { key, value, group, description },
    });
  }

  static async getSettingValue(key: string, defaultValue: string = ''): Promise<string> {
    const setting = await prisma.systemSetting.findUnique({ where: { key } });
    return setting?.value ?? defaultValue;
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
