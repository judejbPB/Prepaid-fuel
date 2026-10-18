import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cap, gal, money } from '../api';
import { ChartCard, compact, HBars, LineChart, SplitBar, StatTile } from '../charts';
import { lang, locale, t } from '../i18n';
import { PageHead, useLoad } from '../ui';

const d = api('distributor');

// Periods are Haiti dates, like every figure on the platform.
const haitiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince' }).format(new Date());
const addDays = (day: string, n: number) => { const x = new Date(`${day}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

type Preset = '7d' | '30d' | '90d' | 'month' | 'last_month' | '12m';
function periodOf(p: Preset): { from: string; to: string } {
  const today = haitiToday();
  if (p === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === 'last_month') {
    const end = addDays(`${today.slice(0, 8)}01`, -1);
    return { from: `${end.slice(0, 8)}01`, to: end };
  }
  const days = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 }[p];
  return { from: addDays(today, -(days - 1)), to: today };
}

const shortDate = (iso: string) => new Date(`${iso.length === 7 ? `${iso}-01` : iso}T12:00:00Z`)
  .toLocaleDateString(locale, iso.length === 7 ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
const htg = (minor: number) => money(minor);
/** Whole gourdes for tiles and chart labels (cents stay in the tables and the CSV). */
const htg0 = (minor: number) => `${Math.round(minor / 100).toLocaleString(locale)} HTG`;
const htgAxis = (major: number) => compact(major, locale);

/** Every figure of the dashboard as CSV rows (semicolon-separated so French Excel opens it directly). */
function toCsv(data: any) {
  const n = (minor: number) => (minor / 100).toFixed(2).replace('.', lang === 'fr' ? ',' : '.');
  const g = (mgal: number) => (mgal / 1000).toFixed(2).replace('.', lang === 'fr' ? ',' : '.');
  const rows: string[][] = [[t('Period'), data.period.from, data.period.to]];
  const k = data.kpis;
  rows.push([], [t('Indicator'), t('This period'), t('Previous period')]);
  rows.push([t('Fuel sales (HTG)'), n(k.sales_minor), n(k.sales_minor_prev)], [t('Gallons served'), g(k.gallons_mgal), g(k.gallons_mgal_prev)],
    [t('Fuelings'), String(k.fuelings), String(k.fuelings_prev)], [t('Active employees'), String(k.active_employees), String(k.active_employees_prev)],
    [t('Deposits activated (HTG)'), n(k.deposits_minor), n(k.deposits_minor_prev)], [t('Refunds paid (HTG)'), n(k.refunds_paid_minor), ''],
    [t('Prepaid owed now (HTG)'), n(k.prepaid_owed_minor), '']);
  rows.push([], [data.period.grain === 'month' ? t('Month') : t('Day'), t('Sales (HTG)'), t('Gallons'), t('Fuelings')],
    ...data.series.map((p: any) => [p.period, n(p.minor), g(p.mgal), String(p.fuelings)]));
  for (const [title, list] of [[t('Station'), data.by_station], [t('Company'), data.by_company], [t('Fuel'), data.by_grade]] as const) {
    rows.push([], [title, t('Sales (HTG)'), t('Gallons'), t('Fuelings')], ...list.map((r: any) => [r.name, n(r.minor), g(r.mgal), String(r.fuelings)]));
  }
  rows.push([], [t('Company'), t('Not yet allocated (HTG)'), t('In employee wallets (HTG)'), t('Fuel used to date (HTG)'), t('Expired (HTG)')],
    ...data.prepaid.map((c: any) => [c.name, n(c.unallocated_minor), n(c.wallets_minor), n(c.used_minor), n(c.expired_minor)]));
  const cell = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ReportsDashboard() {
  const [preset, setPreset] = useState<Preset>('30d');
  const [companyId, setCompanyId] = useState('');
  const [stationId, setStationId] = useState('');
  const [busy, setBusy] = useState(false);
  const { from, to } = periodOf(preset);
  const query = new URLSearchParams({ from, to, ...(companyId ? { companyId } : {}), ...(stationId ? { stationId } : {}) }).toString();
  const { data } = useLoad(async () => { setBusy(true); try { return await d.get(`/api/reports/dashboard?${query}`); } finally { setBusy(false); } }, [query]);
  const lists = useLoad(async () => ({ companies: (await d.get('/api/distributor/dashboard')).companies, stations: await d.get('/api/stations') }), []);
  useEffect(() => { document.title = `${t('Reporting')} · ALFA`; }, []);

  const presets: [Preset, string][] = [['7d', t('7 days')], ['30d', t('30 days')], ['90d', t('90 days')], ['month', t('This month')], ['last_month', t('Last month')], ['12m', t('12 months')]];
  const k = data?.kpis;
  const periodText = data ? t('{from} to {to}, compared with {pfrom} to {pto}', {
    from: shortDate(data.period.from), to: shortDate(data.period.to), pfrom: shortDate(data.period.previous.from), pto: shortDate(data.period.previous.to),
  }) : '';
  const lines = (r: any) => [t('{gal} gal', { gal: gal(r.mgal, 1) }), t('{n} fueling(s)', { n: r.fuelings })];
  const gradeParts = data ? (['diesel', 'gasoline'] as const).map((g, i) => ({
    name: cap(g), value: data.by_grade.find((x: any) => x.name === g)?.minor ?? 0, slot: (i + 1) as 1 | 2,
  })) : [];

  return (
    <>
      <PageHead eyebrow={t('Reports')} title={t('Reporting dashboard')} />
      <div className="dash-filters">
        <div className="seg">
          {presets.map(([p, label]) => <button key={p} className={preset === p ? 'on' : ''} onClick={() => setPreset(p)}>{label}</button>)}
        </div>
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label={t('Company')}>
          <option value="">{t('All companies')}</option>
          {lists.data?.companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={stationId} onChange={(e) => setStationId(e.target.value)} aria-label={t('Station')}>
          <option value="">{t('All stations')}</option>
          {lists.data?.stations.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="sm ghost" disabled={!data} onClick={() => download(`ALFA-tableau-de-bord-${from}_${to}.csv`, toCsv(data))}>{t('Export CSV')}</button>
      </div>
      {data && <p className="small muted" style={{ marginTop: 8 }}>{periodText}</p>}

      {k && (
        <div style={{ opacity: busy ? 0.55 : 1, transition: 'opacity 0.2s' }}>
          <div className="grid g4 mt">
            <StatTile label={t('Fuel sales')} value={htg0(k.sales_minor)} now={k.sales_minor} prev={k.sales_minor_prev} />
            <StatTile label={t('Gallons served')} value={`${gal(k.gallons_mgal, 1)} gal`} now={k.gallons_mgal} prev={k.gallons_mgal_prev} />
            <StatTile label={t('Fuelings')} value={k.fuelings.toLocaleString(locale)} now={k.fuelings} prev={k.fuelings_prev} />
            <StatTile label={t('Active employees')} value={k.active_employees.toLocaleString(locale)} now={k.active_employees} prev={k.active_employees_prev} />
          </div>
          <div className="grid g4 mt">
            <StatTile label={t('Deposits activated')} value={htg0(k.deposits_minor)} now={k.deposits_minor} prev={k.deposits_minor_prev} />
            <StatTile label={t('Average fill')} value={`${gal(k.avg_fill_mgal, 1)} gal`} now={k.avg_fill_mgal} prev={k.avg_fill_mgal_prev} />
            <StatTile label={t('Prepaid owed now')} value={htg0(k.prepaid_owed_minor)} note={t('Not yet allocated + employee wallets')} />
            <StatTile label={t('Refunds paid')} value={htg0(k.refunds_paid_minor)} note={t('In this period')} />
          </div>

          <div className="mt">
            <ChartCard busy={busy} title={data.period.grain === 'month' ? t('Fuel sales by month') : t('Fuel sales by day')} sub={t('HTG charged to wallets')}
              chart={<LineChart points={data.series.map((p: any) => ({ label: shortDate(p.period), value: p.minor / 100, lines: lines(p) }))}
                format={(v) => htg0(v * 100)} axisFormat={htgAxis} />}
              table={<table><thead><tr><th>{data.period.grain === 'month' ? t('Month') : t('Day')}</th><th className="r">HTG</th><th className="r">{t('Gallons')}</th><th className="r">{t('Fuelings')}</th></tr></thead>
                <tbody>{data.series.map((p: any) => <tr key={p.period}><td>{shortDate(p.period)}</td><td className="r num">{htg(p.minor)}</td><td className="r num">{gal(p.mgal, 1)}</td><td className="r num">{p.fuelings}</td></tr>)}</tbody></table>} />
          </div>

          <div className="grid g2 mt">
            {[[t('Sales by station'), data.by_station], [t('Sales by company'), data.by_company]].map(([title, list]: any) => (
              <ChartCard key={title} busy={busy} title={title} sub={t('HTG, highest first')}
                chart={<HBars rows={list.map((r: any) => ({ name: r.name, value: r.minor, lines: lines(r) }))} format={htg0} empty={t('No fuel sales in this period.')} />}
                table={<table><thead><tr><th>{t('Name')}</th><th className="r">HTG</th><th className="r">{t('Gallons')}</th><th className="r">{t('Fuelings')}</th></tr></thead>
                  <tbody>{list.map((r: any) => <tr key={r.name}><td>{r.name}</td><td className="r num">{htg(r.minor)}</td><td className="r num">{gal(r.mgal, 1)}</td><td className="r num">{r.fuelings}</td></tr>)}</tbody></table>} />
            ))}
          </div>

          <div className="grid g2 mt">
            <ChartCard busy={busy} title={t('Fuel mix')} sub={t('Share of sales in HTG')}
              chart={<SplitBar parts={gradeParts} format={htg0} empty={t('No fuel sales in this period.')} />}
              table={<table><thead><tr><th>{t('Fuel')}</th><th className="r">HTG</th><th className="r">{t('Gallons')}</th></tr></thead>
                <tbody>{data.by_grade.map((r: any) => <tr key={r.name}><td>{cap(r.name)}</td><td className="r num">{htg(r.minor)}</td><td className="r num">{gal(r.mgal, 1)}</td></tr>)}</tbody></table>} />
            <ChartCard busy={busy} title={t('Deposits activated by company')} sub={t('HTG, highest first')}
              chart={<HBars rows={[...data.deposits_by_company].sort((a: any, b: any) => b.minor - a.minor).map((r: any) => ({ name: r.name, value: r.minor, lines: [] }))} format={htg0} empty={t('No deposits activated in this period.')} />}
              table={<table><thead><tr><th>{t('Company')}</th><th className="r">HTG</th></tr></thead>
                <tbody>{data.deposits_by_company.map((r: any) => <tr key={r.name}><td>{r.name}</td><td className="r num">{htg(r.minor)}</td></tr>)}</tbody></table>} />
          </div>

          <div className="card white table-wrap mt">
            <h2>{t('Prepaid credit by company (now)')}</h2>
            <table>
              <thead><tr><th>{t('Company')}</th><th className="r">{t('Not yet allocated')}</th><th className="r">{t('In employee wallets')}</th><th className="r">{t('Fuel used to date')}</th><th className="r">{t('Expired')}</th></tr></thead>
              <tbody>
                {data.prepaid.map((c: any) => (
                  <tr key={c.name}><td>{c.name}{c.frozen && <span className="badge bad" style={{ marginLeft: 6 }}>{t('Frozen')}</span>}</td>
                    <td className="r num">{htg(c.unallocated_minor)}</td><td className="r num">{htg(c.wallets_minor)}</td><td className="r num">{htg(c.used_minor)}</td><td className="r num">{htg(c.expired_minor)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card white mt">
            <h2>{t('Operations health')}</h2>
            <div className="grid g3 mt">
              <Health label={t('Disputes raised')} value={data.operations.disputes} to="/distributor/exceptions" />
              <Health label={t('Open exceptions')} value={data.operations.open_exceptions} to="/distributor/exceptions" />
              <Health label={t('Shifts with differences')} value={data.operations.shift_differences} of={data.operations.shifts} to="/distributor/shifts" />
              <Health label={t('Fuel alerts to review')} value={data.operations.open_fuel_alerts} to="/distributor/alerts" />
              <Health label={t('Offline sales')} value={data.operations.offline_share_pct} suffix=" %" to="/distributor/alerts" />
              <Health label={t('Unmatched bank lines')} value={data.operations.unmatched_bank_lines} to="/distributor/bank" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Health({ label, value, of, suffix = '', to }: { label: string; value: number; of?: number; suffix?: string; to: string }) {
  return (
    <Link to={to} className="card" style={{ padding: 14, textDecoration: 'none', color: 'inherit' }}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value.toLocaleString(locale)}{suffix}{of != null && <span className="small muted"> / {of}</span>}</div>
    </Link>
  );
}
