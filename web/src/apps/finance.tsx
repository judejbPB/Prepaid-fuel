import { useState } from 'react';
import { api, ApiError, cap, money, when, type Surface } from '../api';
import { Empty, Modal, PageHead, Status, useAction, useLoad, useMe } from '../ui';
import { t } from '../i18n';

const d = api('distributor');

const SAMPLE = `Date,Reference,Description,Amount
2026-10-12,UNIBANK-90001,"Virement Entreprise B TR-4823",2000000.00
2026-10-12,UNIBANK-90002,Bank charges,-150.00`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function BankStatements() {
  const me = useMe();
  const { data, reload } = useLoad(() => d.get('/api/bank/transactions'), []);
  const funding = useLoad(() => d.get('/api/funding'), []);
  const [csv, setCsv] = useState('');
  const [file, setFile] = useState<{ name: string; kind: 'xlsx' | 'pdf'; data: string } | null>(null);
  const [aiOffer, setAiOffer] = useState(false);
  const [aiPreview, setAiPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [matching, setMatching] = useState<any>(null);
  const { busy, run } = useAction();
  const canImport = me.role === 'dist_treasury' || me.role === 'dist_admin';

  // Excel workbooks and PDFs go to the server as base64 (it reads .xlsx and explains old .xls); CSV goes as text.
  // PDFs, and files whose columns the import doesn't recognise, can be read by AI into a preview first.
  const onFile = async (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    input.value = '';
    setAiOffer(false); setAiPreview(null); setResult(null);
    if (!picked) return;
    if (/\.(xlsx?|pdf)$/i.test(picked.name)) {
      setFile({ name: picked.name, kind: /\.pdf$/i.test(picked.name) ? 'pdf' : 'xlsx', data: toBase64(await picked.arrayBuffer()) });
      setCsv('');
    } else { setCsv(await picked.text()); setFile(null); }
  };
  const clear = () => { setCsv(''); setFile(null); setAiOffer(false); setAiPreview(null); };
  const imported = (out: any) => { setResult(out); clear(); reload(); funding.reload(); };
  const doImport = async () => {
    const out = await run(async () => {
      try {
        return await d.post('/api/bank/import', file ? { xlsx: file.data } : { csv });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'bad_columns') setAiOffer(true);
        throw e;
      }
    });
    if (out) imported(out);
  };
  const readWithAi = async () => {
    const body = file ? (file.kind === 'pdf' ? { pdf: file.data } : { xlsx: file.data }) : { csv };
    const out = await run(() => d.post('/api/bank/ai-read', body));
    if (out) setAiPreview(out);
  };
  const importPreview = async () => {
    const out = await run(() => d.post('/api/bank/import', { csv: aiPreview.csv }));
    if (out) imported(out);
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
          <p className="small muted">{t('Excel (.xlsx) or CSV statement downloaded from online banking, with at least a reference column and an amount or credit column (date and description optional). Credits whose description contains a funding reference (TR-xxxx) and the exact expected amount are matched automatically. A different approver still activates each lot.')}</p>
          <p className="small muted">{t('PDF statement, or a file laid out differently? AI can read the credit lines for you to check before importing.')}</p>
          <div className="row mt">
            <input type="file" accept=".xlsx,.xls,.csv,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              style={{ maxWidth: 320 }} onChange={(e) => onFile(e.target)} />
            <button className="ghost sm" onClick={() => { clear(); setCsv(SAMPLE); }}>{t('Paste sample')}</button>
          </div>
          {file ? (
            <div className="banner mt"><span className="grow">{file.kind === 'pdf' ? t('PDF ready: {name}', { name: file.name }) : t('Excel file ready: {name}', { name: file.name })}</span>
              <button className="ghost sm" onClick={clear}>{t('Remove')}</button></div>
          ) : (
            <textarea className="mt mono" rows={5} value={csv} onChange={(e) => { setCsv(e.target.value); setAiOffer(false); setAiPreview(null); }} placeholder={t('…or paste CSV here')} />
          )}
          {!aiPreview && (
            <div className="row mt">
              {file?.kind !== 'pdf' && <button disabled={busy || (!file && csv.trim().length < 10)} onClick={doImport}>{t('Import and match')}</button>}
              {(file?.kind === 'pdf' || aiOffer) && <button className={file?.kind === 'pdf' ? '' : 'ghost'} disabled={busy} onClick={readWithAi}>{busy ? t('Reading…') : t('Read with AI')}</button>}
            </div>
          )}
          {aiOffer && !aiPreview && <p className="small muted">{t('The columns of this file were not recognised. AI can read it instead; you check the lines before anything is imported.')}</p>}
          {aiPreview && <AiPreview data={aiPreview} busy={busy} onImport={importPreview} onCancel={() => setAiPreview(null)} />}
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

/** What AI read from a statement, for treasury to check before importing it through the normal import. */
function AiPreview({ data, busy, onImport, onCancel }: { data: any; busy: boolean; onImport: () => void; onCancel: () => void }) {
  const total = data.lines.reduce((s: number, l: any) => s + l.amountMinor, 0);
  return (
    <div className="card mt">
      <h3>{t('AI reading: check before importing')}</h3>
      <p className="small muted">{t('{n} credit line(s), total {total}. Compare with the statement: AI can misread. Nothing is imported until you confirm.', { n: data.lines.length, total: money(total) })}</p>
      {data.notes && <div className="banner mt"><span className="grow small">{t('AI note:')} {data.notes}</span></div>}
      {data.dropped > 0 && <p className="small" style={{ color: 'var(--bad)' }}>{t('{n} line(s) left out because the amount could not be read.', { n: data.dropped })}</p>}
      {data.lines.length > 0 && (
        <div className="table-wrap mt">
          <table>
            <thead><tr><th>{t('Date')}</th><th>{t('Bank reference')}</th><th>{t('Description')}</th><th className="r">{t('Amount')}</th></tr></thead>
            <tbody>
              {data.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td className="small">{l.date || '—'}</td>
                  <td className="mono small">{l.reference}{l.generatedReference && <div className="muted">{t('no bank reference: generated')}</div>}</td>
                  <td className="small">{l.description}</td>
                  <td className="r num">{money(l.amountMinor, l.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row mt">
        <button disabled={busy || !data.lines.length} onClick={onImport}>{t('Import these {n} line(s) and match', { n: data.lines.length })}</button>
        <button className="ghost" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function MatchLine({ txn, funding, onClose, onDone }: { txn: any; funding: any[]; onClose: () => void; onDone: () => void }) {
  const [fid, setFid] = useState<number | ''>('');
  const { busy, run } = useAction();
  const sameAmount = funding.filter((f) => f.amount_minor === txn.amount_minor);
  const [ai, setAi] = useState<any>(null);
  const askAi = async () => {
    const out = await run(() => d.post(`/api/bank/transactions/${txn.id}/suggest`));
    if (out) setAi(out);
  };
  return (
    <Modal title={t('Match {ref}', { ref: txn.bank_reference })} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{money(txn.amount_minor, txn.currency)} · {txn.memo || t('no description')}</p>
        <div className="card">
          <div className="row between">
            <strong className="small">{t('AI suggestions')}</strong>
            <button className="sm ghost" disabled={busy} onClick={askAi}>{ai ? t('Ask again') : t('Suggest a match')}</button>
          </div>
          {!ai && <p className="small muted">{t('AI compares this line with the open funding requests (reference typos, company name, amount, date). It only suggests: you choose, and a second approver still activates the lot.')}</p>}
          {ai && !ai.suggestions.length && <p className="small muted">{t('No likely match among the open requests. Contact the company or ignore the line.')}</p>}
          {ai?.suggestions.map((s: any) => (
            <div key={s.fundingId} className="row mt" style={{ alignItems: 'flex-start' }}>
              <div className="small" style={{ flex: 1 }}>
                <div><span className="mono">{s.reference}</span> · {s.company} · {money(s.amountMinor, s.currency)}{' '}
                  <span className={`badge ${s.confidence === 'high' ? 'ok' : s.confidence === 'medium' ? 'info' : ''}`}>{s.confidence === 'high' ? t('Likely') : s.confidence === 'medium' ? t('Possible') : t('Unlikely')}</span></div>
                <div className="muted">{s.reason}</div>
                {!s.amountMatches && <div style={{ color: 'var(--bad)' }}>{t('Amount differs: contact the company before matching.')}</div>}
              </div>
              <button className="sm" disabled={!s.amountMatches} onClick={() => setFid(s.fundingId)}>{fid === s.fundingId ? t('Selected') : t('Choose')}</button>
            </div>
          ))}
        </div>
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
