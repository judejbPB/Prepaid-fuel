import { useState } from 'react';
import { api, cap, money, when, type Surface } from '../api';
import { Empty, Modal, PageHead, Status, useAction, useLoad, useMe } from '../ui';
import { t } from '../i18n';

const d = api('distributor');

const SAMPLE = `Date,Reference,Description,Amount
2026-10-12,UNIBANK-90001,"Virement Company B TR-4823",2000000.00
2026-10-12,UNIBANK-90002,Bank charges,-150.00`;

export function BankStatements() {
  const me = useMe();
  const { data, reload } = useLoad(() => d.get('/api/bank/transactions'), []);
  const funding = useLoad(() => d.get('/api/funding'), []);
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [matching, setMatching] = useState<any>(null);
  const { busy, run } = useAction();
  const canImport = me.role === 'dist_treasury' || me.role === 'dist_admin';

  const onFile = async (file?: File) => { if (file) setCsv(await file.text()); };
  const doImport = async () => {
    const out = await run(() => d.post('/api/bank/import', { csv }));
    if (out) { setResult(out); setCsv(''); reload(); funding.reload(); }
  };
  const ignore = async (tx: any) => {
    const note = prompt(t('Why ignore this line? (e.g. not a fuel deposit)'));
    if (note && (await run(() => d.post(`/api/bank/transactions/${tx.id}/ignore`, { note }), t('Line ignored')))) reload();
  };

  return (
    <>
      <PageHead eyebrow={t('Step 02 · Activate')} title={t('Bank statements')} />
      {canImport && (
        <div className="card white">
          <h2>{t('Import a statement')}</h2>
          <p className="small muted">{t('CSV export from the bank with at least reference and amount columns (date and description optional). Credits whose description contains a funding reference (TR-xxxx) and the exact expected amount are matched automatically. A different approver still activates each lot.')}</p>
          <div className="row mt">
            <input type="file" accept=".csv,text/csv" style={{ maxWidth: 320 }} onChange={(e) => onFile(e.target.files?.[0])} />
            <button className="ghost sm" onClick={() => setCsv(SAMPLE)}>{t('Paste sample')}</button>
          </div>
          <textarea className="mt mono" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={t('…or paste CSV here')} />
          <button className="mt" disabled={busy || csv.trim().length < 10} onClick={doImport}>{t('Import and match')}</button>
          {result && (
            <div className="banner ok mt"><span className="grow">
              {t('Imported {n} line(s) · matched {m}', { n: result.imported, m: result.matched.length })}{result.matched.length ? ` (${result.matched.join(', ')})` : ''} ·
              {' '}{t('{u} need attention · {d} already imported · {s} debits/blank skipped', { u: result.unmatched, d: result.duplicates, s: result.skipped })}
            </span></div>
          )}
        </div>
      )}
      <div className="card white table-wrap mt">
        <h2>{t('Bank lines')}</h2>
        <table>
          <thead><tr><th>{t('Date')}</th><th>{t('Bank reference')}</th><th>{t('Description')}</th><th className="r">{t('Amount')}</th><th>{t('Status')}</th><th>{t('Funding')}</th><th></th></tr></thead>
          <tbody>
            {data?.map((tx: any) => (
              <tr key={tx.id}>
                <td className="small">{tx.value_date ?? when(tx.created_at)}</td><td className="mono">{tx.bank_reference}</td>
                <td className="small">{tx.memo}{tx.note && <div className="muted">{tx.note}</div>}</td>
                <td className="r num">{money(tx.amount_minor, tx.currency)}</td>
                <td><span className={`badge ${tx.status === 'matched' ? 'ok' : tx.status === 'unmatched' ? 'warn' : ''}`}>{cap(tx.status)}</span></td>
                <td className="small">{tx.funding_reference ? `${tx.funding_reference} · ${tx.company_name}` : '—'}</td>
                <td className="r">{tx.status === 'unmatched' && canImport && (
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="sm" onClick={() => setMatching(tx)}>{t('Match')}</button>
                    <button className="sm ghost" onClick={() => ignore(tx)}>{t('Ignore')}</button>
                  </div>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.length && <Empty>{t('No statements imported yet.')}</Empty>}
      </div>
      {matching && (
        <MatchLine txn={matching} funding={(funding.data ?? []).filter((f: any) => f.status === 'awaiting_bank')}
          onClose={() => setMatching(null)} onDone={() => { setMatching(null); reload(); funding.reload(); }} />
      )}
    </>
  );
}

function MatchLine({ txn, funding, onClose, onDone }: { txn: any; funding: any[]; onClose: () => void; onDone: () => void }) {
  const [fid, setFid] = useState<number | ''>('');
  const { busy, run } = useAction();
  const sameAmount = funding.filter((f) => f.amount_minor === txn.amount_minor);
  return (
    <Modal title={t('Match {ref}', { ref: txn.bank_reference })} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{money(txn.amount_minor, txn.currency)} · {txn.memo || t('no description')}</p>
        <label>{t('Funding request awaiting bank')}
          <select value={fid} onChange={(e) => setFid(Number(e.target.value))}>
            <option value="">{t('Select…')}</option>
            {funding.map((f) => (
              <option key={f.id} value={f.id}>{f.reference} · {f.company_name} · {money(f.amount_minor, f.currency)}{f.amount_minor === txn.amount_minor ? ` ✓ ${t('amount')}` : ''}</option>
            ))}
          </select>
        </label>
        {!sameAmount.length && <p className="small" style={{ color: 'var(--bad)' }}>{t('No open request has this exact amount. Contact the company before matching.')}</p>}
        <button disabled={busy || !fid} onClick={async () => {
          if (await run(() => d.post(`/api/bank/transactions/${txn.id}/match`, { fundingId: fid }), t('Matched; awaiting second approver'))) onDone();
        }}>{t('Match')}</button>
      </div>
    </Modal>
  );
}

/** Refund list with the actions the signed-in user may take. Used by distributor and corporate apps. */
export function RefundsTable({ surface }: { surface: Surface }) {
  const me = useMe();
  const client = api(surface);
  const { data, reload } = useLoad(() => client.get('/api/refunds'), []);
  const { busy, run } = useAction();
  const act = async (path: string, body: unknown, msg: string) => { if (await run(() => client.post(path, body), msg)) reload(); };
  const isDistApprover = me.role === 'dist_approver' || me.role === 'dist_admin';
  const isTreasury = me.role === 'dist_treasury' || me.role === 'dist_admin';
  return (
    <div className="card white table-wrap">
      <table>
        <thead><tr><th>#</th>{surface === 'distributor' && <th>{t('Company')}</th>}<th>{t('Lot')}</th><th className="r">{t('Amount')}</th><th>{t('Reason')}</th><th>{t('Status')}</th><th></th></tr></thead>
        <tbody>
          {data?.map((r: any) => (
            <tr key={r.id}>
              <td>{r.id}</td>{surface === 'distributor' && <td>{r.company_name}</td>}
              <td className="mono">{r.lot_code}</td>
              <td className="r num">{money(r.amount_minor, r.currency)}</td>
              <td className="small">{r.reason}<div className="muted">{t('by {name}', { name: r.requested_by_name })} · {when(r.created_at)}</div></td>
              <td>
                <span className={`badge ${r.status === 'paid' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'}`}>{r.status === 'approved' ? t('Approved · awaiting payout') : cap(r.status)}</span>
                {r.payout_reference && <div className="small muted">{t('Paid {ref}', { ref: r.payout_reference })}</div>}
                {r.reject_reason && <div className="small muted">{r.reject_reason}</div>}
              </td>
              <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
                {surface === 'distributor' && r.status === 'requested' && isDistApprover && (
                  <button className="sm dark" disabled={busy} onClick={() => act(`/api/refunds/${r.id}/approve`, {}, t('Refund approved'))}>{t('Approve')}</button>
                )}
                {surface === 'distributor' && r.status === 'approved' && isTreasury && (
                  <button className="sm" disabled={busy || r.approved_by === me.userId} title={r.approved_by === me.userId ? t('Another person must record the payout') : ''}
                    onClick={() => { const ref = prompt(t('Outgoing bank transfer reference')); if (ref) act(`/api/refunds/${r.id}/pay`, { payoutReference: ref }, t('Payout recorded')); }}>{t('Record payout')}</button>
                )}
                {r.status === 'requested' && (isDistApprover || me.role === 'co_approver') && (
                  <button className="sm ghost" disabled={busy} onClick={() => { const reason = prompt(t('Reason for rejecting/withdrawing')); if (reason) act(`/api/refunds/${r.id}/reject`, { reason }, t('Refund rejected')); }}>
                    {surface === 'corporate' ? t('Withdraw') : t('Reject')}
                  </button>
                )}
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!data?.length && <Empty>{t('No refunds.')}</Empty>}
    </div>
  );
}
