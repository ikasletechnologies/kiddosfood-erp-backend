// NIC e-way bill master codes. Kept in one place so validation, the NIC JSON
// export and the frontend dropdowns all agree on the same values.

export const SUB_SUPPLY_TYPES: Record<string, string> = {
  '1': 'Supply',
  '2': 'Import',
  '3': 'Export',
  '4': 'Job Work',
  '5': 'For Own Use',
  '6': 'Job Work Returns',
  '7': 'Sales Return',
  '8': 'Others',
  '9': 'SKD/CKD/Lots',
  '10': 'Line Sales',
  '11': 'Recipient Not Known',
  '12': 'Exhibition or Fairs',
};

// Allowed supplyType → subSupplyType → docType combinations (portal rejects
// anything outside this matrix).
export const SUPPLY_DOC_MATRIX: Record<string, Record<string, string[]>> = {
  O: {
    '1': ['INV', 'BIL'],
    '3': ['INV', 'BIL'],
    '4': ['CHL'],
    '5': ['CHL'],
    '8': ['CHL', 'OTH'],
    '9': ['INV', 'BIL', 'CHL'],
    '10': ['CHL'],
    '11': ['CHL', 'OTH'],
    '12': ['CHL'],
  },
  I: {
    '1': ['INV', 'BIL'],
    '2': ['BOE'],
    '5': ['CHL'],
    '6': ['CHL'],
    '7': ['CHL'],
    '8': ['CHL', 'OTH'],
    '9': ['BOE', 'INV', 'BIL'],
    '12': ['CHL'],
  },
};

export const DOC_TYPES: Record<string, string> = {
  INV: 'Tax Invoice',
  BIL: 'Bill of Supply',
  BOE: 'Bill of Entry',
  CHL: 'Delivery Challan',
  OTH: 'Others',
};

export const TRANS_MODES: Record<string, string> = { '1': 'Road', '2': 'Rail', '3': 'Air', '4': 'Ship' };

export const CANCEL_REASONS: Record<string, string> = {
  '1': 'Duplicate',
  '2': 'Order Cancelled',
  '3': 'Data Entry Mistake',
  '4': 'Others',
};

export const VEHICLE_UPDATE_REASONS: Record<string, string> = {
  '1': 'Due to Break Down',
  '2': 'Due to Transhipment',
  '3': 'Others',
  '4': 'First Time',
};

export const EXTENSION_REASONS: Record<string, string> = {
  '1': 'Natural Calamity',
  '2': 'Law and Order Situation',
  '4': 'Transhipment',
  '5': 'Accident',
  '99': 'Others',
};

// Consignment value above which an e-way bill is mandatory (Rule 138(1)).
export const EWB_THRESHOLD = 50000;

// Standard GST unit quantity codes accepted by the portal.
const UQC_CODES = new Set([
  'BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS', 'CTN', 'DOZ', 'DRM', 'GGK',
  'GMS', 'GRS', 'GYD', 'KGS', 'KLR', 'KME', 'LTR', 'MLT', 'MTR', 'MTS', 'NOS', 'OTH', 'PAC', 'PCS', 'PRS', 'QTL',
  'ROL', 'SET', 'SQF', 'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS',
]);

const UQC_ALIASES: Record<string, string> = {
  KG: 'KGS', KGS: 'KGS', KILOGRAM: 'KGS', KILOGRAMS: 'KGS',
  G: 'GMS', GM: 'GMS', GMS: 'GMS', GRM: 'GMS', GRAM: 'GMS', GRAMS: 'GMS',
  L: 'LTR', LT: 'LTR', LTR: 'LTR', LITRE: 'LTR', LITER: 'LTR', LITRES: 'LTR', LITERS: 'LTR',
  ML: 'MLT', MLT: 'MLT',
  PKT: 'PAC', PACK: 'PAC', PACKET: 'PAC', PACKS: 'PAC',
  PC: 'PCS', PCS: 'PCS', PIECE: 'PCS', PIECES: 'PCS',
  NO: 'NOS', NOS: 'NOS', NUMBER: 'NOS', NUMBERS: 'NOS', NONE: 'NOS',
  ROLL: 'ROL', ROLLS: 'ROL',
  TNE: 'TON', TON: 'TON', TONNE: 'TON', TONNES: 'TON',
  DOZEN: 'DOZ', CARTON: 'CTN', BOTTLE: 'BTL', BOTTLES: 'BTL', BAGS: 'BAG', UNIT: 'UNT', UNITS: 'UNT',
};

export function toUqc(unit?: string | null): string {
  const u = String(unit || '').trim().toUpperCase();
  if (!u) return 'NOS';
  if (UQC_ALIASES[u]) return UQC_ALIASES[u];
  if (UQC_CODES.has(u)) return u;
  return 'OTH';
}

export function isValidUqc(unit: string): boolean {
  return UQC_CODES.has(unit);
}
