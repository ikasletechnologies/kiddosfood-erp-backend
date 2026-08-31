import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';

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
    let profile: any;
    try {
      profile = JSON.parse(raw);
    } catch {
      profile = {};
    }

    // The seller's GST registration state (needed to classify CGST+SGST vs
    // IGST on every document — Sales Order, Proforma, Tax Invoice) has no
    // dedicated field; it lives on this profile's `state`. When nobody has
    // configured that yet, fall back to the real HQ franchise's location —
    // the one place a seller state already exists in this system (and the
    // same field GST reports already key off, see
    // FinanceService/splitTaxBySupplyState) — rather than leaving `state`
    // undefined, which callers have historically covered with their own
    // hardcoded guesses that disagree with each other and with this value.
    if (!profile.state) {
      const hq = await FranchiseService.getHqFranchiseOrNull();
      if (hq?.location) profile = { ...profile, state: hq.location };
    }

    return profile;
  }

  /**
   * Update core company profile
   */
  static async updateCompanyProfile(data: any) {
    const value = JSON.stringify(data);
    const setting = await this.setSetting('COMPANY_PROFILE', value, 'GENERAL', 'Enterprise Company Identity Data');
    try {
      return JSON.parse(setting.value);
    } catch {
      return data;
    }
  }
}
