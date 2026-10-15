import { useState } from 'react';
import { api, type Surface } from '../api';
import { PageHead, useAction } from '../ui';
import { locale, t } from '../i18n';

interface Turn { q: string; a: string; sources: { tool: string; input: any; rows: any[]; error?: string }[] }

const TOOL = (name: string) => ({
  fuel_sales: t('Fuel sales'), deposits: t('Activated deposits'), balances: t('Company balances'),
  refunds: t('Refunds'), exceptions_and_alerts: t('Exceptions and alerts'),
} as Record<string, string>)[name] ?? name;

/** Column names of the report rows, for the reader. */
const COLUMN = (key: string) => ({
  group: t('Group'), fuelings: t('Fuelings'), gallons: t('Gallons'), htg: 'HTG', activated_deposits: t('Deposits'),
  company: t('Company'), frozen: t('Frozen'), not_yet_allocated_htg: t('Not yet allocated (HTG)'), in_employee_wallets_htg: t('In employee wallets (HTG)'),
  fuel_used_to_date_htg: t('Fuel used to date (HTG)'), expired_htg: t('Expired (HTG)'), status: t('Status'), refunds: t('Refunds'),
  type: t('Type'), item: t('Item'), count: t('Count'),
  station: t('Station'), grade: t('Fuel'), day: t('Day'), month: t('Month'), employee: t('Employee'), attendant: t('Attendant'),
} as Record<string, string>)[key] ?? key;

/** Example questions for each kind of user. */
const examples = (surface: Surface) => surface === 'corporate'
  ? [t('How much fuel did our employees use this month?'), t('Which employees fueled the most this month?'), t('How much credit is left to allocate?')]
  : surface === 'station'
    ? [t('How many gallons did we sell today, by fuel?'), t('Which attendant served the most this week?'), t('How many disputes this month?')]
    : [t('How much diesel did each company buy this month?'), t('Which station sold the most this week?'), t('Total deposits activated this month, by company')];

/**
 * Questions in plain language about the figures. Answers come from fixed read-only reports limited to what the user
 * may see; the AI cannot change anything. The reports it used are shown under each answer so figures can be checked.
 */
export function ReportsAssistant({ surface, embedded }: { surface: Surface; embedded?: boolean }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const { busy, run } = useAction();
  const ask = async (q: string) => {
    if (q.trim().length < 3) return;
    const history = turns.slice(-3).map(({ q, a }) => ({ q, a }));
    const out = await run(() => api(surface).post('/api/reports/ask', { question: q.trim(), history }));
    if (out) { setTurns([...turns, { q: q.trim(), a: out.answer, sources: out.sources }]); setQuestion(''); }
  };
  return (
    <>
      {!embedded && <PageHead eyebrow={t('Reports')} title={t('Ask the figures')} />}
      <div className="card white">
        {embedded && <h2>{t('Ask the figures')}</h2>}
        <p className="small muted">{t('Ask a question about fuel sales, deposits, balances, refunds or exceptions. The AI answers only from the platform’s reports, limited to what you are allowed to see, and cannot change anything. Check important figures in the reports shown under each answer.')}</p>
        <div className="row mt" style={{ flexWrap: 'wrap' }}>
          {examples(surface).map((ex) => <button key={ex} className="sm ghost" disabled={busy} onClick={() => ask(ex)}>{ex}</button>)}
        </div>
        <div className="row mt" style={{ alignItems: 'stretch' }}>
          <input style={{ flex: 1 }} value={question} placeholder={t('e.g. How much diesel did Entreprise B buy this month?')}
            onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ask(question); }} />
          <button disabled={busy || question.trim().length < 3} onClick={() => ask(question)}>{busy ? t('Reading…') : t('Ask')}</button>
        </div>
      </div>
      {[...turns].reverse().map((turn, i) => (
        <div key={turns.length - i} className="card white mt">
          <p className="small muted" style={{ marginTop: 0 }}>{turn.q}</p>
          <div style={{ whiteSpace: 'pre-wrap' }}>{turn.a}</div>
          {turn.sources.length > 0 && (
            <details className="mt small">
              <summary>{t('Reports used ({n})', { n: turn.sources.length })}</summary>
              {turn.sources.map((s, j) => (
                <div key={j} className="table-wrap mt">
                  <strong>{TOOL(s.tool)}</strong>
                  <span className="muted"> · {[s.input?.from && s.input?.to ? `${s.input.from} → ${s.input.to}` : '', s.input?.group_by && s.input.group_by !== 'none' ? t('by {what}', { what: COLUMN(s.input.group_by).toLowerCase() }) : ''].filter(Boolean).join(' · ')}</span>
                  {s.error ? <p className="muted">{t('Not available to you:')} {s.error}</p> : (
                    <table>
                      <thead><tr>{Object.keys(s.rows[0] ?? {}).map((k) => <th key={k}>{COLUMN(k)}</th>)}</tr></thead>
                      <tbody>{s.rows.map((r, k) => <tr key={k}>{Object.values(r).map((v, m) => <td key={m} className={typeof v === 'number' ? 'r num' : ''}>{typeof v === 'number' ? v.toLocaleString(locale) : typeof v === 'boolean' ? (v ? t('Yes') : t('No')) : String(v)}</td>)}</tr>)}</tbody>
                    </table>
                  )}
                </div>
              ))}
            </details>
          )}
        </div>
      ))}
    </>
  );
}
