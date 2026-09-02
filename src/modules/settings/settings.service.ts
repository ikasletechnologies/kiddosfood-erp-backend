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
    const raw = await this.getSettingValue('COMPANY_PROFILE', '');
    let profile: any = {};
    if (raw && raw.trim() !== '' && raw !== '{}') {
      try {
        profile = JSON.parse(raw);
      } catch {
        profile = {};
      }
    }

    // If profile has a GSTIN but no explicit state, derive state from GSTIN
    if (!profile.state) {
      if (profile.gstNumber || profile.gstin) {
        const { getStateFromGstin } = require('../../utils/gst-tax.util');
        const stateFromGstin = getStateFromGstin(profile.gstNumber || profile.gstin);
        if (stateFromGstin) {
          profile.state = stateFromGstin;
        }
      }
    }

    // Default configuration for Kiddos Foods if setting is unpopulated in DB
    if (!profile.companyName && !profile.state) {
      profile = {
        companyName: 'Kiddos Foods',
        legalName: 'Kiddos Foods Private Limited',
        state: 'Tamil Nadu',
        gstNumber: '33AAAAA0000A1Z5',
        gstin: '33AAAAA0000A1Z5',
        city: 'Chennai',
        pincode: '600001',
        address: 'Central Plaza, Tech Hub, Chennai, Tamil Nadu',
        email: 'contact@kiddosfoods.com',
        phone: '1112223333',
        ...profile
      };
      await this.setSetting('COMPANY_PROFILE', JSON.stringify(profile), 'GENERAL', 'Enterprise Company Identity Data');
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
