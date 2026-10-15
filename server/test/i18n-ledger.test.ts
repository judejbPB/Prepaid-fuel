import { describe, expect, it } from 'vitest';
import { localizeAccountLabel, localizeLedgerPayload, localizeMemo } from '../src/i18n-ledger.js';

describe('ledger text in French', () => {
  it('translates generated memos, with French numbers', () => {
    expect(localizeMemo('Station 1 pump 3 · 20.00 gal diesel @ 665.00', 'fr')).toBe('Station 1, pompe 3 · 20,00 gal de diesel à 665,00 HTG/gal');
    expect(localizeMemo('Station 1 pump 2 · gasoline ≈ 8.77 gal', 'fr')).toBe('Station 1, pompe 2 · gazoline ≈ 8,77 gal');
    expect(localizeMemo('TR-4822 activated as LOT-4822', 'fr')).toBe('Dépôt TR-4822 activé : lot LOT-4822');
    expect(localizeMemo('Refund #3: 1330.00 HTG of LOT-4821', 'fr')).toBe('Remboursement n° 3 : 1330,00 HTG du lot LOT-4821');
    expect(localizeMemo('Cancelled request ST2-AB12', 'fr')).toBe('Demande ST2-AB12 annulée');
  });

  it('leaves typed text and English requests alone', () => {
    expect(localizeMemo('Monthly fuel benefit', 'fr')).toBe('Monthly fuel benefit');
    expect(localizeMemo('Station 1 pump 3 · 20.00 gal diesel @ 665.00', 'en')).toBe('Station 1 pump 3 · 20.00 gal diesel @ 665.00');
  });

  it('translates account labels and walks payloads', () => {
    expect(localizeAccountLabel('Paul D. · available', 'fr')).toBe('Paul D. · disponible');
    expect(localizeAccountLabel('Distributor · refunds payable', 'fr')).toBe('Distributeur · remboursements à payer');
    expect(localizeLedgerPayload({ entries: [{ memo: 'Exception #4', lines: [{ account_label: 'Station 1 · fuel sales' }] }] }, 'fr'))
      .toEqual({ entries: [{ memo: 'Exception n° 4', lines: [{ account_label: 'Station 1 · ventes de carburant' }] }] });
  });
});
