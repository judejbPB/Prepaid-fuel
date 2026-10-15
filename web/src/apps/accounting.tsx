import { useEffect, useState } from 'react';
import { api, money, when } from '../api';
import { Empty, PageHead, useAction, useLoad, useMe } from '../ui';
import { t } from '../i18n';

const d = api('distributor');

const today = () => new Date().toLocaleDateString('en-CA');
const monthStart = () => today().slice(0, 8) + '01';

/** Saves a file the server sent as base64. */
function saveFile(name: string, base64: string, type: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const saveExport = (f: { filename: string; contentBase64: string }) =>
  saveFile(f.filename, f.contentBase64, f.filename.endsWith('.csv') ? 'text/csv' : 'text/plain');

const sageDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function SageExport() {
  const { busy, run } = useAction();
  const history = useLoad(() => d.get('/api/accounting/sage/exports'), []);
  const [opts, setOpts] = useState({ from: monthStart(), to: today(), mode: 'summary', format: 'sage100', onlyNew: true });
  const [preview, setPreview] = useState<any>(null);
  const set = (k: string, v: unknown) => { setOpts({ ...opts, [k]: v }); setPreview(null); };

  const doPreview = async () => {
    const out = await run(() => d.post('/api/accounting/sage/preview', opts));
    if (out) setPreview(out);
  };
  const doExport = async () => {
    const out = await run(() => d.post('/api/accounting/sage/export', opts), t('Export saved'));
    if (out) { saveExport(out); setPreview(null); history.reload(); }
  };
  const again = async (id: number) => {
    const out = await run(() => d.post(`/api/accounting/sage/exports/${id}/download`));
    if (out) saveExport(out);
  };

  return (
    <>
      <PageHead eyebrow={t('Finance')} title={t('Accounting export (Sage)')} />
      <div className="card white">
        <h2>{t('Export journal entries')}</h2>
        <p className="small muted">{t('Deposits, fuel sales, refunds and expired balances become journal entries on your Sage accounts. Moves between a company and its employees stay inside the customer prepayment account and are left out. Each ledger entry is exported only once.')}</p>
        <div className="grid g4 mt">
          <label>{t('From')}<input type="date" value={opts.from} onChange={(e) => set('from', e.target.value)} /></label>
          <label>{t('To')}<input type="date" value={opts.to} onChange={(e) => set('to', e.target.value)} /></label>
          <label>{t('Detail')}
            <select value={opts.mode} onChange={(e) => set('mode', e.target.value)}>
              <option value="summary">{t('Daily summary by type')}</option>
              <option value="detail">{t('Each transaction')}</option>
            </select>
          </label>
          <label>{t('File')}
            <select value={opts.format} onChange={(e) => set('format', e.target.value)}>
              <option value="sage100">{t('Sage 100 import (.txt)')}</option>
              <option value="csv">{t('Excel / Sage 50 (.csv)')}</option>
            </select>
          </label>
        </div>
        <label className="row mt" style={{ flexDirection: 'row' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={opts.onlyNew} onChange={(e) => set('onlyNew', e.target.checked)} />
          {t('Only entries not exported yet')}
        </label>
        <div className="row mt">
          <button className="ghost" disabled={busy} onClick={doPreview}>{t('Preview')}</button>
          <button disabled={busy} onClick={doExport}>{t('Export and download')}</button>
        </div>
        {preview && <Preview data={preview} />}
      </div>

      <div className="card white table-wrap mt">
        <h2>{t('Past exports')}</h2>
        <table>
          <thead><tr><th>{t('No.')}</th><th>{t('Period')}</th><th>{t('File')}</th><th className="r">{t('Entries')}</th><th className="r">{t('Total debit')}</th><th>{t('By')}</th><th></th></tr></thead>
          <tbody>
            {history.data?.map((x: any) => (
              <tr key={x.id}>
                <td className="mono">{x.id}</td>
                <td className="small">{sageDate(x.date_from)} – {sageDate(x.date_to)}<div className="muted">{x.mode === 'detail' ? t('Each transaction') : t('Daily summary by type')}</div></td>
                <td className="small mono">{x.filename}</td>
                <td className="r num">{x.entries}</td>
                <td className="r num">{money(x.debit_minor)}</td>
                <td className="small">{x.created_by_name}<div className="muted">{when(x.created_at)}</div></td>
                <td className="r"><button className="sm ghost" disabled={busy} onClick={() => again(x.id)}>{t('Download')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!history.data?.length && <Empty>{t('No exports yet.')}</Empty>}
      </div>

      <SageSettings />
    </>
  );
}

function Preview({ data }: { data: any }) {
  if (!data.entries.length) return <div className="banner mt"><span className="grow">{t('Nothing to export for this period')}</span></div>;
  return (
    <div className="table-wrap mt">
      <p className="small muted">{t('{n} entries · {l} lines · journal {j} · debit {d} = credit {c}', {
        n: data.entries.length, l: data.totals.lines, j: data.journal, d: money(data.totals.debit), c: money(data.totals.credit),
      })}</p>
      <table>
        <thead><tr><th>{t('Date')}</th><th>{t('Entry no.')}</th><th>{t('Account')}</th><th>{t('Customer code')}</th><th>{t('Section')}</th><th>{t('Description')}</th><th className="r">{t('Debit')}</th><th className="r">{t('Credit')}</th></tr></thead>
        <tbody>
          {data.entries.slice(0, 200).flatMap((e: any) => e.lines.map((l: any, i: number) => (
            <tr key={`${e.piece}-${i}`} style={i === 0 ? { borderTop: '2px solid var(--line)' } : undefined}>
              <td className="small">{i === 0 ? sageDate(e.date) : ''}</td>
              <td className="mono small">{i === 0 ? e.piece : ''}</td>
              <td className="mono">{l.account}</td><td className="mono small">{l.tiers}</td><td className="mono small">{l.section}</td>
              <td className="small">{l.label}</td>
              <td className="r num">{l.debit ? money(l.debit) : ''}</td><td className="r num">{l.credit ? money(l.credit) : ''}</td>
            </tr>
          )))}
        </tbody>
      </table>
      {data.entries.length > 200 && <p className="small muted">{t('Showing the first 200 entries; the file has them all.')}</p>}
    </div>
  );
}

const accountLabels = (): [string, string][] => [
  ['bank', t('Bank (verified deposits, refunds paid)')],
  ['customer', t('Customer prepayments (fuel credit held for client companies)')],
  ['sales', t('Fuel sales')],
  ['breakage', t('Expired balances (income)')],
  ['refunds', t('Refunds payable')],
];

function SageSettings() {
  const me = useMe();
  const canEdit = me.role === 'dist_admin';
  const { busy, run } = useAction();
  const { data, reload } = useLoad(() => d.get('/api/accounting/sage/settings'), []);
  const [form, setForm] = useState<any>(null);
  useEffect(() => { if (data) setForm(structuredClone(data)); }, [data]);
  if (!form) return null;

  const save = async () => {
    const out = await run(() => d.post('/api/accounting/sage/settings', {
      journal: form.journal, accounts: form.accounts,
      companies: form.companies.map((c: any) => ({ id: c.id, tiers: c.tiers })),
      stations: form.stations.map((s: any) => ({ id: s.id, section: s.section })),
    }), t('Sage codes saved'));
    if (out) reload();
  };
  const edit = (fn: (f: any) => void) => { const next = structuredClone(form); fn(next); setForm(next); };

  return (
    <div className="card white mt">
      <h2>{t('Sage codes')}</h2>
      <p className="small muted">{t('Use the account numbers from your Sage chart of accounts. The defaults follow the French chart of accounts; your accountant should confirm them before the first import.')}</p>
      <div className="grid g3 mt">
        <label>{t('Journal code')}<input value={form.journal} disabled={!canEdit} onChange={(e) => edit((f) => { f.journal = e.target.value; })} /></label>
        {accountLabels().map(([k, label]) => (
          <label key={k}>{label}<input className="mono" value={form.accounts[k]} disabled={!canEdit} onChange={(e) => edit((f) => { f.accounts[k] = e.target.value; })} /></label>
        ))}
      </div>
      <div className="grid g2 mt">
        <div>
          <h3>{t('Customer codes (compte tiers)')}</h3>
          <div className="stack mt">
            {form.companies.map((c: any, i: number) => (
              <label key={c.id}>{c.name}<input className="mono" value={c.tiers} disabled={!canEdit} onChange={(e) => edit((f) => { f.companies[i].tiers = e.target.value; })} /></label>
            ))}
          </div>
        </div>
        <div>
          <h3>{t('Analytic sections by station (optional)')}</h3>
          <div className="stack mt">
            {form.stations.map((s: any, i: number) => (
              <label key={s.id}>{s.name}<input className="mono" value={s.section} disabled={!canEdit} placeholder={t('None')} onChange={(e) => edit((f) => { f.stations[i].section = e.target.value; })} /></label>
            ))}
          </div>
        </div>
      </div>
      {canEdit ? <button className="mt" disabled={busy} onClick={save}>{t('Save codes')}</button>
        : <p className="small muted mt">{t('Only the distributor admin can change these codes.')}</p>}
      <details className="mt small">
        <summary>{t('Setting up the import in Sage 100')}</summary>
        <p className="muted">{t('In Sage 100, create a parameterised import format (Fichier menu) of the delimited type, with ";" as the field separator and these fields in this order:')}</p>
        <p className="mono">{['Code journal', 'Date (JJMMAA)', 'N° pièce', 'N° compte général', 'N° compte tiers', 'Section analytique', 'Libellé écriture', 'Montant débit', 'Montant crédit'].join(' ; ')}</p>
        <p className="muted">{t('The .txt file uses Windows (ANSI) characters and has no header line. The .csv file has a header line and opens directly in Excel.')}</p>
      </details>
    </div>
  );
}
