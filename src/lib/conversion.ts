export const UNITS = {
  MASS: {
    KG: 'kg',
    G: 'g',
  },
  VOLUME: {
    L: 'l',
    ML: 'ml',
  },
  COUNT: {
    PCS: 'pcs',
    NOS: 'nos',
  }
};

export const convertToStorage = (quantity: number, fromUnit: string, storageUnit: string): number => {
  const from = fromUnit.toLowerCase();
  const to = storageUnit.toLowerCase();

  // Mass conversion (g -> kg)
  if (from === 'g' && to === 'kg') return quantity / 1000;
  if (from === 'kg' && to === 'g') return quantity * 1000;

  // Volume conversion (ml -> l)
  if (from === 'ml' && to === 'l') return quantity / 1000;
  if (from === 'l' && to === 'ml') return quantity * 1000;

  // No conversion needed
  return quantity;
};

export const formatQuantity = (quantity: number, unit: string): string => {
  const u = unit.toLowerCase();
  
  if (u === 'kg' && quantity < 1) {
    return `${(quantity * 1000).toFixed(0)}g`;
  }
  
  if (u === 'l' && quantity < 1) {
    return `${(quantity * 1000).toFixed(0)}ml`;
  }
  
  return `${quantity.toFixed(2)}${unit}`;
};
