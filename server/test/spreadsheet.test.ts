import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/services/spreadsheet.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe('Excel statements', () => {
  it('reads the first sheet: text, numbers, dates and blank cells', () => {
    const rows = readXlsx(fixture('releve-banque.xlsx'));
    expect(rows[0]).toEqual(['Relevé de compte — Entreprise B']);
    expect(rows[2]).toEqual(['Date valeur', 'N° transaction', 'Libellé', 'Débit', 'Crédit', 'Devise']);
    expect(rows[3]).toEqual(['2026-10-12', 'UNI-X1', 'Virement Entreprise B TR-REF1 & co', '', '10000', 'HTG']);
    expect(rows[4]).toEqual(['2026-10-13', 'UNI-X2', 'Frais bancaires', '150', '', 'HTG']);
    expect(rows[5][4]).toBe('5 000,50');
  });

  it('asks for .xlsx or CSV when given an old .xls file', () => {
    expect(() => readXlsx(fixture('releve-banque.xls'))).toThrow(/Old Excel format/);
    expect(() => readXlsx(Buffer.from('Date,Reference,Amount\n'))).toThrow(/not an .xlsx/);
  });
});
