import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, cap, gal, money, type Surface } from '../api';
import { ChartCard, compact, HBars, PairedColumns, SplitBar, StatTile } from '../charts';
import { lang, locale, t } from '../i18n';
import { Empty, PageHead, useLoad, useMe } from '../ui';
import { download } from './reports';

// Fuel usage dashboard for a client company: what it gave its employees, what they used, where and which fuel,
// month by month, with simple flags. The company sees its own; the distributor picks a company.

const monthLabel = (mo: string) => new Date(`${mo}-01T12:00:00Z`).toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
const htg0 = (minor: number) => `${Math.round(minor / 100).toLocaleString(locale)} HTG`;
const gal1 = (mgal: number) => `${gal(mgal, 1)} gal`;

/** Change between the last two months, as "▲ +12 %" (arrow and sign, never color alone). */
function Change({ prev, now }: { prev: number; now: number }) {
  if (!prev && !now) return <span className="muted">–</span>;
  if (!prev) return <span className="muted">{t('New')}</span>;
  const pct = Math.round(((now - prev) / prev) * 100);
  return <span className={Math.abs(pct) >= 30 ? 'delta-bad' : 'muted'}>{pct > 0 ? '▲ +' : pct < 0 ? '▼ ' : '= '}{pct} %</span>;
}

const FLAG: Record<string, () => string> = {
  above_usual: () => t('Well above usual'),
  many_stations: () => t('Many stations'),
  not_used: () => t('Not used'),
};

function toCsv(data: any) {
  const n = (minor: number) => (minor / 100).toFixed(2).replace('.', lang === 'fr' ? ',' : '.');
  const g = (mgal: number) => (mgal / 1000).toFixed(2).replace('.', lang === 'fr' ? ',' : '.');
  const rows: string[][] = [[data.company.name, data.months[0], data.months.at(-1)]];
  rows.push([], [t('Month'), t('Given to employees (HTG)'), t('Used (HTG)'), t('Gallons'), t('Fuelings'), t('Employees who fueled')],
    ...data.monthly.map((m: any) => [m.month, n(m.given_minor), n(m.used_minor), g(m.used_mgal), String(m.fuelings), String(m.employees)]));
  rows.push([], [t('Gallons by station'), ...data.months, t('Total'), t('Favorite of (employees)')],
    ...data.stations.map((s: any) => [s.name, ...s.months.map((m: any) => g(m.mgal)), g(s.mgal), String(s.favorite_of)]));
  rows.push([], [t('Gallons by fuel'), ...data.months, t('Total')],
    ...data.grades.map((x: any) => [cap(x.grade), ...x.months.map((m: any) => g(m.mgal)), g(x.mgal)]));
  rows.push([], [t('Employee'), t('Dept'), t('Given (HTG)'), t('Used (HTG)'), t('Gallons'), t('Fuelings'), t('Balance now (HTG)'), t('Favorite station'), t('Main fuel'), t('Flags')],
    ...data.employees.map((e: any) => [e.name, e.dept ?? '', n(e.given_minor), n(e.used_minor), g(e.used_mgal), String(e.fuelings), n(e.balance_minor),
      e.favorite_station ?? '', e.main_grade ? cap(e.main_grade) : '', e.flags.map((f: string) => FLAG[f]()).join(', ')]));
  const c = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + rows.map((r) => r.map(c).join(';')).join('\r\n');
}

/** Distributor: pick a company, then the same dashboard the company sees. */
export function CompanyUsagePicker() {
  const d = api('distributor');
  const list = useLoad(async () => (await d.get('/api/distributor/dashboard')).companies as any[], []);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const id = companyId ?? list.data?.[0]?.id ?? null;
  return id ? (
    <CompanyUsage surface="distributor" companyId={id}
      picker={<select value={id} onChange={(e) => setCompanyId(Number(e.target.value))} aria-label={t('Company')}>
        {list.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>} />
  ) : null;
}

export function CompanyUsage({ surface = 'corporate', companyId, picker }: { surface?: Surface; companyId?: number; picker?: ReactNode }) {
  const me = useMe();
  const id = companyId ?? me.companyId!;
  const client = useMemo(() => api(surface), [surface]);
  const [months, setMonths] = useState(6);
  const [dept, setDept] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ months: String(months), ...(dept ? { dept } : {}) }).toString();
  const { data } = useLoad(async () => { setBusy(true); try { return await client.get(`/api/companies/${id}/usage?${query}`); } finally { setBusy(false); } }, [id, query]);
  useEffect(() => { document.title = `${t('Fuel usage')} · ALFA`; }, []);

  const k = data?.kpis;
  // The current month is still running: compare the last two full months.
  const last = data ? data.monthly.at(-2) : null;
  const prev = data ? data.monthly.at(-3) : null;
  const head = (m: string, i: number) => (i === data.months.length - 1 ? t('{month} (so far)', { month: monthLabel(m) }) : monthLabel(m));
  const employees = (data?.employees ?? []).filter((e: any) =>
    (!onlyFlagged || e.flags.length) && (!search || `${e.name} ${e.dept ?? ''}`.toLowerCase().includes(search.toLowerCase())));
  const gradeParts = data ? (['diesel', 'gasoline'] as const).map((g, i) => ({
    name: cap(g), value: data.grades.find((x: any) => x.grade === g)?.mgal ?? 0, slot: (i + 1) as 1 | 2,
  })) : [];

  return (
    <>
      <PageHead eyebrow={data ? data.company.name : t('Reports')} title={t('Fuel usage')} />
      <div className="dash-filters">
        {picker}
        <div className="seg">
          {[3, 6, 12].map((m) => <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>{t('{n} months', { n: m })}</button>)}
        </div>
        {!!data?.depts.length && (
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label={t('Dept')}>
            <option value="">{t('All departments')}</option>
            {data.depts.map((x: string) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
        <button className="sm ghost" disabled={!data} onClick={() => download(`ALFA-consommation-${data.company.name}-${data.months[0]}_${data.months.at(-1)}.csv`, toCsv(data))}>{t('Export CSV')}</button>
      </div>
      {data && <p className="small muted" style={{ marginTop: 8 }}>{t('{from} to {to} · figures by month, Haiti time', { from: monthLabel(data.months[0]), to: monthLabel(data.months.at(-1)) })}</p>}

      {k && (
        <div style={{ opacity: busy ? 0.55 : 1, transition: 'opacity 0.2s' }}>
          <div className="grid g4 mt">
            <StatTile label={t('Given to employees')} value={htg0(k.given_minor)} note={t('Allocations posted in the period')} />
            <StatTile label={t('Used at the pump')} value={htg0(k.used_minor)} note={t('{gal} · {n} fueling(s)', { gal: gal1(k.used_mgal), n: k.fuelings })} />
            <StatTile label={t('Gallons in {month}', { month: monthLabel(last.month) })} value={gal1(last.used_mgal)} now={last.used_mgal} prev={prev?.used_mgal} upIsGood={false} vs={t('vs previous month')} />
            <StatTile label={t('Left in wallets now')} value={htg0(k.balance_minor)} note={t('{a} of {b} employees fueled', { a: k.active_employees, b: k.employees })} />
          </div>

          <div className="mt">
            <ChartCard busy={busy} title={t('Given vs used, by month')} sub={t('HTG given to employees and HTG used at the pump')}
              chart={<PairedColumns names={[t('Given'), t('Used')]} format={htg0} axisFormat={(v) => compact(v / 100, locale)}
                points={data.monthly.map((m: any) => ({ label: monthLabel(m.month), a: m.given_minor, b: m.used_minor }))} />}
              table={<table><thead><tr><th>{t('Month')}</th><th className="r">{t('Given')}</th><th className="r">{t('Used')}</th><th className="r">{t('Difference')}</th><th className="r">{t('Gallons')}</th><th className="r">{t('Fuelings')}</th></tr></thead>
                <tbody>{data.monthly.map((m: any) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="r num">{money(m.given_minor)}</td><td className="r num">{money(m.used_minor)}</td>
                  <td className="r num">{money(m.given_minor - m.used_minor)}</td><td className="r num">{gal(m.used_mgal, 1)}</td><td className="r num">{m.fuelings}</td></tr>)}</tbody></table>} />
          </div>

          <div className="card white table-wrap mt">
            <h2 style={{ marginBottom: 2 }}>{t('Gallons by station, month by month')}</h2>
            <div className="small muted">{t('Change compares the last two full months; ±30 % or more is highlighted.')}</div>
            {data.stations.length ? (
              <table className="mt">
                <thead><tr><th>{t('Station')}</th>{data.months.map((m: string, i: number) => <th key={m} className="r">{head(m, i)}</th>)}<th className="r">{t('Total')}</th><th className="r">{t('Change')}</th></tr></thead>
                <tbody>
                  {data.stations.map((s: any) => (
                    <tr key={s.name}><td><b>{s.name}</b></td>{s.months.map((m: any) => <td key={m.month} className="r num">{m.mgal ? gal(m.mgal, 1) : <span className="muted">–</span>}</td>)}
                      <td className="r num"><b>{gal(s.mgal, 1)}</b></td><td className="r"><Change prev={s.months.at(-3)?.mgal ?? 0} now={s.months.at(-2).mgal} /></td></tr>
                  ))}
                  <tr><td className="muted">{t('Total')}</td>{data.monthly.map((m: any) => <td key={m.month} className="r num muted">{gal(m.used_mgal, 1)}</td>)}
                    <td className="r num"><b>{gal(k.used_mgal, 1)}</b></td><td className="r"><Change prev={prev?.used_mgal ?? 0} now={last.used_mgal} /></td></tr>
                </tbody>
              </table>
            ) : <Empty>{t('No fuelings in this period.')}</Empty>}
          </div>

          <div className="grid g2 mt">
            <ChartCard busy={busy} title={t('Stations employees favor')} sub={t('Employees whose most-used station it is')}
              chart={<HBars rows={data.stations.map((s: any) => ({ name: s.name, value: s.favorite_of, lines: [t('{n} employee(s) fueled here', { n: s.employees }), t('{n} fueling(s)', { n: s.fuelings }), gal1(s.mgal)] }))}
                format={(v) => t('{n} employee(s)', { n: v })} empty={t('No fuelings in this period.')} />}
              table={<table><thead><tr><th>{t('Station')}</th><th className="r">{t('Favorite of')}</th><th className="r">{t('Employees')}</th><th className="r">{t('Fuelings')}</th><th className="r">{t('Gallons')}</th></tr></thead>
                <tbody>{data.stations.map((s: any) => <tr key={s.name}><td>{s.name}</td><td className="r num">{s.favorite_of}</td><td className="r num">{s.employees}</td><td className="r num">{s.fuelings}</td><td className="r num">{gal(s.mgal, 1)}</td></tr>)}</tbody></table>} />
            <ChartCard busy={busy} title={t('Fuel type')} sub={t('Share of gallons')}
              chart={<SplitBar parts={gradeParts} format={gal1} empty={t('No fuelings in this period.')} />}
              table={<table><thead><tr><th>{t('Fuel')}</th>{data.months.map((m: string, i: number) => <th key={m} className="r">{head(m, i)}</th>)}<th className="r">{t('Total')}</th></tr></thead>
                <tbody>{data.grades.map((x: any) => <tr key={x.grade}><td>{cap(x.grade)}</td>{x.months.map((m: any) => <td key={m.month} className="r num">{gal(m.mgal, 1)}</td>)}<td className="r num"><b>{gal(x.mgal, 1)}</b></td></tr>)}</tbody></table>} />
          </div>

          <div className="card white mt">
            <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>{t('Employees')}</h2>
                <div className="small muted">{t('Flags: last full month or this month so far {pct} % and {gal} gal above the employee’s usual; {n} or more stations in one month; given but never used.', {
                  pct: data.rules.abovePct, gal: gal(data.rules.aboveMinMgal), n: data.rules.manyStations })}</div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input placeholder={t('Search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 160 }} aria-label={t('Search')} />
                <label className="small" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />{t('Flagged only ({n})', { n: k.flagged })}</label>
              </div>
            </div>
            <div className="table-wrap mt">
              <table>
                <thead><tr><th>{t('Employee')}</th><th className="r">{t('Given')}</th><th className="r">{t('Used')}</th><th className="r">{t('Gallons')}</th><th className="r">{monthLabel(data.months.at(-2))}</th><th className="r">{t('{month} (so far)', { month: monthLabel(data.months.at(-1)) })}</th><th className="r">{t('Usual / month')}</th><th className="r">{t('Balance now')}</th><th>{t('Favorite station')}</th><th>{t('Fuel')}</th><th>{t('Flags')}</th></tr></thead>
                <tbody>
                  {employees.map((e: any) => (
                    <tr key={e.id}>
                      <td className="nowrap"><b>{e.name}</b>{e.dept && <div className="small muted">{e.dept}</div>}</td>
                      <td className="r num nowrap">{htg0(e.given_minor)}</td><td className="r num nowrap">{htg0(e.used_minor)}</td><td className="r num">{gal(e.used_mgal, 1)}</td>
                      <td className="r num">{gal(e.last_month_mgal, 1)}</td><td className="r num">{gal(e.month_so_far_mgal, 1)}</td><td className="r num muted">{e.usual_mgal ? gal(e.usual_mgal, 1) : '–'}</td>
                      <td className="r num nowrap">{htg0(e.balance_minor)}</td>
                      <td>{e.favorite_station ?? <span className="muted">–</span>}{e.stations_used > 1 && <span className="small muted"> {t('(+{n} other)', { n: e.stations_used - 1 })}</span>}</td>
                      <td>{e.main_grade ? cap(e.main_grade) : <span className="muted">–</span>}</td>
                      <td>{e.flags.map((f: string) => <span key={f} className="badge warn" style={{ marginRight: 4 }}>{FLAG[f]()}</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!employees.length && <Empty>{onlyFlagged ? t('No flagged employees.') : t('No employees.')}</Empty>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
