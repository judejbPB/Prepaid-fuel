export const GRADES = ['diesel', 'gasoline'] as const;
export type Grade = (typeof GRADES)[number];

/** Gallons (decimal) -> milligallons (integer). */
export const toMgal = (gal: number) => Math.round(gal * 1000);
/** Milligallons -> gallons. */
export const toGal = (mgal: number) => mgal / 1000;

/** Money value of a gallon quantity at a per-gallon price, rounded to minor units. */
export const valueOf = (mgal: number, priceMinor: number) => Math.round((mgal * priceMinor) / 1000);

export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Currency amount (decimal) -> minor units (integer). */
export const toMinor = (amount: number) => Math.round(amount * 100);
/** Gallons a money amount buys at a per-gallon price, in milligallons (reference only). */
export const gallonsFor = (minor: number, priceMinor: number) => Math.floor((minor * 1000) / priceMinor);
