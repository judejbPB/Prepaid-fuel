import { useEffect, useMemo, useState } from 'react';
import { api, cap, gal, money, type Surface } from '../api';
import { ChartCard, compact, PairedColumns, StatTile } from '../charts';
import { lang, locale, t } from '../i18n';
import { Empty, Modal, PageHead, useAction, useLoad } from '../ui';
import { toBase64 } from './finance';
import { download } from './reports';

// Station performance: each station's own monthly sales (all customers), entered or imported with history,
// compared month to month and with the same month a year earlier. Used by the distributor and station managers.

const monthLabel = (mo: string) => new Date(`${mo}-01T12:00:00Z`).toLocaleDateString(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
const gal1 = (mgal: number | null) => (mgal == null ? '–' : `${gal(mgal, 1)} gal`);

/** "▲ +12 %" / "▼ -8 %", arrow and sign so it never relies on color; sales going up reads as good. */
function Pct({ v }: { v: number | null }) {
  if (v == null) return <span className="muted">–</span>;
  return <span className={v > 0 ? 'delta-good' : v < 0 ? 'delta-bad' : 'muted'}>{v > 0 ? '▲ +' : v < 0 ? '▼ ' : '= '}{v} %</span>;
}

const TEMPLATE = (station?: string) => [
  station ? 'Mois;Carburant;Gallons;Montant HTG' : 'Station;Mois;Carburant;Gallons;Montant HTG',
  `${station ? '' : 'Station 1;'}2025-09;Diesel;12500;9375000`,
  `${station ? '' : 'Station 1;'}2025-09;Gazoline;8400;6720000`,
].join('\r\n');

function toCsv(data: any) {
  const g = (mgal: number | null) => (mgal == null ? '' : (mgal / 1000).toFixed(1).replace('.', lang === 'fr' ? ',' : '.'));
  const p = (v: number | null) => (v == null ? '' : String(v));
  const rows: string[][] = [[data.station?.name ?? t('All stations')]];
  rows.push([t('Month'), t('Gallons sold'), t('vs previous month (%)'), t('Same month last year'), t('vs last year (%)'), t('Through ALFA (gal)'), t('ALFA share (%)')],
    ...data.rows.map((r: any) => [r.month, g(r.actual_mgal), p(r.mom_pct), g(r.last_year_mgal), p(r.yoy_pct), g(r.alfa_mgal), p(r.alfa_share_pct)]));
  if (data.by_station.length) {
    rows.push([], [t('Station'), data.last_full_month, t('vs previous month (%)'), t('vs last year (%)'), t('Year to date'), t('vs last year to date (%)'), t('ALFA share (%)')],
      ...data.by_station.map((s: any) => [s.name, g(s.actual_mgal), p(s.mom_pct), p(s.yoy_pct), g(s.ytd_mgal), p(s.ytd_pct), p(s.alfa_share_pct)]));
  }
  const c = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + rows.map((r) => r.map(c).join(';')).join('\r\n');
}

export function StationPerformance({ surface }: { surface: Surface }) {
  const client = useMemo(() => api(surface), [surface]);
  const [stationId, setStationId] = useState('');
  const [months, setMonths] = useState(12);
  const [grade, setGrade] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ months: String(months), ...(stationId ? { stationId } : {}), ...(grade ? { grade } : {}) }).toString();
  const { data, reload } = useLoad(async () => { setBusy(true); try { return await client.get(`/api/stations/performance?${query}`); } finally { setBusy(false); } }, [query]);
  useEffect(() => { document.title = `${t('Station performance')} · ALFA`; }, []);
  if (!data) return null;
  const s = data.summary;
  const distributor = surface === 'distributor';
  const writer = data.can_edit || (distributor && !data.station);

  return (
    <>
      <PageHead eyebrow={data.station?.name ?? t('All stations')} title={t('Station performance')}>
        {data.can_edit && <button onClick={() => setEditing(data.last_full_month)}>{t('Enter a month')}</button>}
      </PageHead>
      <div className="dash-filters">
        {distributor && (
          <select value={stationId} onChange={(e) => setStationId(e.target.value)} aria-label={t('Station')}>
            <option value="">{t('All stations')}</option>
            {data.stations.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        <div className="seg">
          {[12, 24].map((m) => <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>{t('{n} months', { n: m })}</button>)}
        </div>
        <div className="seg">
          {[['', t('All fuels')], ['diesel', cap('diesel')], ['gasoline', cap('gasoline')]].map(([g, label]) => <button key={g} className={grade === g ? 'on' : ''} onClick={() => setGrade(g)}>{label}</button>)}
        </div>
        {writer && <button className="sm ghost" onClick={() => setImporting(true)}>{t('Import history')}</button>}
        <button className="sm ghost" onClick={() => download(`ALFA-performance-${data.station?.name ?? 'stations'}-${data.months[0]}_${data.months.at(-1)}.csv`, toCsv(data))}>{t('Export CSV')}</button>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>{t('Gallons sold by the station to all customers, as entered by the station. Compared with the month before and the same month a year earlier.')}
        {!data.station && ` ${t('Changes count only stations that entered both months.')}`}</p>
      {data.missing_months.length > 0 && (
        <div className="banner warn mt">{distributor && !data.station
          ? t('Some stations have not entered: {months}', { months: data.missing_months.map(monthLabel).join(', ') })
          : t('Sales not entered yet for: {months}', { months: data.missing_months.map(monthLabel).join(', ') })}</div>
      )}

      <div style={{ opacity: busy ? 0.55 : 1, transition: 'opacity 0.2s' }}>
        <div className="grid g4 mt">
          <StatTile label={t('Sold in {month}', { month: monthLabel(s.month) })} value={gal1(s.actual_mgal)} pct={s.mom_pct} vs={t('vs previous month')} note={t('Not entered yet')} />
          <StatTile label={t('Same month last year')} value={gal1(s.last_year_mgal)} pct={s.yoy_pct} vs={t('this year vs last year')} note={t('No history for that month')} />
          <StatTile label={t('Year to date {year}', { year: s.year })} value={gal1(s.ytd_mgal)} pct={s.ytd_pct} vs={t('vs same period last year')} note={t('January to {month}', { month: monthLabel(s.month) })} />
          <StatTile label={t('Sold through ALFA')} value={s.alfa_share_pct == null ? '–' : `${s.alfa_share_pct} %`} note={t('Share of {month} gallons paid from ALFA wallets', { month: monthLabel(s.month) })} />
        </div>

        <div className="mt">
          <ChartCard busy={busy} title={t('This year vs last year, by month')} sub={t('Gallons sold')}
            chart={<PairedColumns names={[t('This year'), t('A year earlier')]} format={(v) => gal1(v)} axisFormat={(v) => compact(v / 1000, locale)}
              points={data.rows.map((r: any) => ({ label: monthLabel(r.month).replace(/\s?\d{4}$/, ''), a: r.actual_mgal ?? 0, b: r.last_year_mgal ?? 0 }))} />}
            table={<table><thead><tr><th>{t('Month')}</th><th className="r">{t('This year')}</th><th className="r">{t('A year earlier')}</th><th className="r">{t('vs last year')}</th></tr></thead>
              <tbody>{data.rows.map((r: any) => <tr key={r.month}><td>{monthLabel(r.month)}</td><td className="r num">{gal1(r.actual_mgal)}</td><td className="r num">{gal1(r.last_year_mgal)}</td><td className="r"><Pct v={r.yoy_pct} /></td></tr>)}</tbody></table>} />
        </div>

        <div className="card white table-wrap mt">
          <h2>{t('Month by month')}</h2>
          <MonthTable data={data} onEdit={data.can_edit ? setEditing : undefined} />
        </div>

        {data.by_station.length > 0 && (
          <div className="card white table-wrap mt">
            <h2 style={{ marginBottom: 2 }}>{t('Stations in {month}', { month: monthLabel(data.last_full_month) })}</h2>
            <div className="small muted">{t('Select a station to see its months and enter or correct its sales.')}</div>
            <table className="mt">
              <thead><tr><th>{t('Station')}</th><th className="r">{t('Gallons sold')}</th><th className="r">{t('vs previous month')}</th><th className="r">{t('vs last year')}</th>
                <th className="r">{t('Year to date')}</th><th className="r">{t('vs last year to date')}</th><th className="r">{t('ALFA share')}</th></tr></thead>
              <tbody>
                {data.by_station.map((x: any) => (
                  <tr key={x.id} style={{ cursor: 'pointer' }} onClick={() => setStationId(String(x.id))}>
                    <td><b>{x.name}</b>{x.missing_last_month && <span className="badge warn" style={{ marginLeft: 6 }}>{t('Not entered')}</span>}</td>
                    <td className="r num">{gal1(x.actual_mgal)}</td><td className="r"><Pct v={x.mom_pct} /></td><td className="r"><Pct v={x.yoy_pct} /></td>
                    <td className="r num">{gal1(x.ytd_mgal)}</td><td className="r"><Pct v={x.ytd_pct} /></td><td className="r num">{x.alfa_share_pct == null ? '–' : `${x.alfa_share_pct} %`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && data.station && <EntryModal client={client} station={data.station} month={editing} entries={data.entries} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {importing && <ImportModal client={client} perStation={!!data.station && !distributor} stationName={data.station?.name} onClose={() => setImporting(false)} onDone={() => reload()} />}
    </>
  );
}

function MonthTable({ data, onEdit }: { data: any; onEdit?: (month: string) => void }) {
  const rows = [...data.rows].reverse();
  return (
    <table>
      <thead><tr><th>{t('Month')}</th><th className="r">{t('Gallons sold')}</th><th className="r">{t('Sales (HTG)')}</th><th className="r">{t('vs previous month')}</th>
        <th className="r">{t('Same month last year')}</th><th className="r">{t('vs last year')}</th><th className="r">{t('Through ALFA')}</th><th className="r">{t('ALFA share')}</th>{onEdit && <th />}</tr></thead>
      <tbody>
        {rows.map((r: any) => (
          <tr key={r.month}>
            <td className="nowrap">{monthLabel(r.month)}{r.in_progress && <span className="small muted"> {t('(in progress)')}</span>}
              {!data.station && r.stations_entered < data.total_stations && <div className="small muted">{t('{a} of {b} stations entered', { a: r.stations_entered, b: data.total_stations })}</div>}</td>
            <td className="r num">{r.actual_mgal == null ? <span className="muted">{t('Not entered')}</span> : <b>{gal(r.actual_mgal, 1)}</b>}</td>
            <td className="r num nowrap">{r.actual_minor ? money(r.actual_minor) : <span className="muted">–</span>}</td>
            <td className="r"><Pct v={r.mom_pct} /></td>
            <td className="r num">{r.last_year_mgal == null ? <span className="muted">–</span> : gal(r.last_year_mgal, 1)}</td>
            <td className="r"><Pct v={r.yoy_pct} /></td>
            <td className="r num">{gal(r.alfa_mgal, 1)}</td>
            <td className="r num">{r.alfa_share_pct == null ? '–' : `${r.alfa_share_pct} %`}</td>
            {onEdit && <td className="r"><button className="sm ghost" onClick={() => onEdit(r.month)}>{r.actual_mgal == null ? t('Enter') : t('Correct')}</button></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EntryModal({ client, station, month: initial, entries, onClose, onDone }: { client: ReturnType<typeof api>; station: any; month: string; entries: any[]; onClose: () => void; onDone: () => void }) {
  const [month, setMonth] = useState(initial);
  const existing = (g: string) => entries.find((e) => e.month === month && e.grade === g);
  const blank = () => ({
    diesel: existing('diesel') ? String(existing('diesel').gallons_mgal / 1000) : '', gasoline: existing('gasoline') ? String(existing('gasoline').gallons_mgal / 1000) : '',
    dieselAmt: existing('diesel')?.amount_minor != null ? String(existing('diesel').amount_minor / 100) : '', gasolineAmt: existing('gasoline')?.amount_minor != null ? String(existing('gasoline').amount_minor / 100) : '',
  });
  const [v, setV] = useState(blank);
  useEffect(() => setV(blank()), [month]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, run } = useAction();
  const num = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
  const save = async () => {
    const lines = (['diesel', 'gasoline'] as const).filter((g) => v[g].trim() !== '')
      .map((g) => ({ grade: g, gallons: num(v[g]), amount: v[`${g}Amt` as const].trim() ? num(v[`${g}Amt` as const]) : null }));
    if (await run(() => client.post(`/api/stations/${station.id}/actuals`, { month, lines }), t('Sales saved'))) onDone();
  };
  const remove = async () => { if (await run(() => client.post(`/api/stations/${station.id}/actuals/delete`, { month }), t('Month removed'))) onDone(); };
  const field = (key: keyof typeof v, label: string) => (
    <label>{label}<input inputMode="decimal" value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} /></label>
  );
  return (
    <Modal title={t('Monthly sales · {station}', { station: station.name })} onClose={onClose}>
      <p className="small muted">{t('Total gallons the station sold in the month, to all customers (pump meter totals). The amount in HTG is optional.')}</p>
      <label>{t('Month')}<input type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></label>
      <div className="grid g2 mt">
        {field('diesel', t('Diesel (gallons)'))}{field('dieselAmt', t('Diesel (HTG, optional)'))}
        {field('gasoline', t('Gazoline (gallons)'))}{field('gasolineAmt', t('Gazoline (HTG, optional)'))}
      </div>
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        {(existing('diesel') || existing('gasoline')) && <button className="ghost" disabled={busy} onClick={remove}>{t('Remove this month')}</button>}
        <button className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button disabled={busy || (!v.diesel.trim() && !v.gasoline.trim())} onClick={save}>{t('Save')}</button>
      </div>
    </Modal>
  );
}

const REASON: Record<string, () => string> = {
  unknown_station: () => t('station not found'), bad_month: () => t('month not readable'), no_gallons: () => t('no gallons'), bad_fuel: () => t('fuel not recognised'),
};

function ImportModal({ client, perStation, stationName, onClose, onDone }: { client: ReturnType<typeof api>; perStation: boolean; stationName?: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [result, setResult] = useState<any>(null);
  const pick = async (file: File) => {
    const body = /\.xlsx?$/i.test(file.name) ? { xlsx: toBase64(await file.arrayBuffer()) } : { csv: await file.text() };
    const out = await run(() => client.post('/api/stations/actuals/import', body));
    if (out) { setResult(out); onDone(); }
  };
  return (
    <Modal title={t('Import sales history')} onClose={onClose}>
      <p className="small muted">{perStation
        ? t('Excel (.xlsx) or CSV with one line per month and fuel: month, fuel (diesel or gazoline), gallons and, if you have it, the amount in HTG. A diesel column and a gazoline column per month also works. Months already entered are replaced.')
        : t('Excel (.xlsx) or CSV with a station column, then one line per month and fuel: month, fuel (diesel or gazoline), gallons and, if you have it, the amount in HTG. A diesel column and a gazoline column per month also works. Months already entered are replaced.')}</p>
      <div className="row mt">
        <input type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
          onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        <button className="sm ghost" onClick={() => download('ALFA-modele-ventes-station.csv', '﻿' + TEMPLATE(perStation ? stationName : undefined))}>{t('Download a template')}</button>
      </div>
      {result && (
        <div className="mt">
          <div className="banner ok">{result.imported
            ? t('{n} line(s) imported, {from} to {to}.', { n: result.imported, from: monthLabel(result.from), to: monthLabel(result.to) })
            : t('Nothing imported.')}</div>
          {result.skipped.length > 0 && (
            <div className="small mt">{t('Skipped:')} {result.skipped.slice(0, 20).map((s: any) => t('line {line} ({reason})', { line: s.line, reason: REASON[s.reason]?.() ?? s.reason })).join(' · ')}{result.skipped.length > 20 ? ' …' : ''}</div>
          )}
        </div>
      )}
      {!result && <Empty>{t('Choose a file to import.')}</Empty>}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}><button className="secondary" onClick={onClose}>{t('Close')}</button></div>
    </Modal>
  );
}
