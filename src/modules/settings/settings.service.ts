import prisma from '../../lib/prisma';

export class SettingsService {
  /**
   * Get all system settings grouped by group name
   */
  static async getAllSettings() {
    const settings = await prisma.systemSetting.findMany({
      orderBy: [{ group: 'asc' }, { key: 'asc' }]
    });

    return settings.reduce((acc: any, setting) => {
      if (!acc[setting.group]) acc[setting.group] = [];
      acc[setting.group].push(setting);
      return acc;
    }, {});
  }

  /**
   * Update or create a setting
   */
  static async setSetting(key: string, value: string, group: string = 'GENERAL', description?: string) {
    return prisma.systemSetting.upsert({
      where: { key },
      update: { value, description },
      create: { key, value, group, description }
    });
  }

  /**
   * Get a specific setting value
   */
  static async getSettingValue(key: string, defaultValue: string = ''): Promise<string> {
    const setting = await prisma.systemSetting.findUnique({
      where: { key }
    });
    return setting ? setting.value : defaultValue;
  }
}
