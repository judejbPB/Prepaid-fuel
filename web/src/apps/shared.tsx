import { useState } from 'react';
import { api, cap, gal, money, when, type Surface } from '../api';
import { Empty, Modal, Status, useAction, useLoad, useMe } from '../ui';
import { t } from '../i18n';

const DIST = ['dist_admin', 'dist_treasury', 'dist_approver'];

/** Exception queue shared by the distributor control center and the station manager view. */
export function ExceptionsPanel({ surface, onlyOpen = true }: { surface: Surface; onlyOpen?: boolean }) {
  const me = useMe();
  const [showAll, setShowAll] = useState(!onlyOpen);
  const { data, reload } = useLoad(() => api(surface).get(`/api/exceptions${showAll ? '' : '?status=open'}`), [showAll], 15000);
  const [proposing, setProposing] = useState<any>(null);
  const [replying, setReplying] = useState<any>(null);
  const { busy, run } = useAction();
  const canDecide = me.role === 'dist_approver' || me.role === 'dist_admin';
  const canPropose = me.role === 'st_manager' || DIST.includes(me.role);

  const decide = async (id: number, approve: boolean) => {
    const note = approve ? undefined : prompt(t('Why is this proposal declined?')) ?? undefined;
    if (!approve && note === undefined) return;
    if (await run(() => api(surface).post(`/api/exceptions/${id}/decide`, { approve, note }), approve ? t('Approved and posted') : t('Proposal declined'))) reload();
  };

  return (
    <div className="card white">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h2>{t('Exception queue')}</h2>
        <label className="row" style={{ flexDirection: 'row', fontWeight: 500 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {t('Show resolved')}
        </label>
      </div>
      {!data?.length && <Empty>{t('No exceptions. Everything reconciles.')}</Empty>}
      <div className="stack">
        {data?.map((e: any) => (
          <div key={e.id} className="card" style={{ padding: 14 }}>
            <div className="row between">
              <div className="row"><span className="badge info">{cap(e.kind)}</span><b>{e.summary}</b></div>
              <Status s={e.status} />
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              #{e.id} · {when(e.created_at)}{e.station_name ? ` · ${e.station_name}` : ''}{e.company_name ? ` · ${e.company_name}` : ''}
            </div>
            {e.kind === 'shift_variance' && e.detail && typeof e.detail === 'object' && (
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table>
                  <thead><tr><th>{t('Fuel')}</th><th className="r">{t('Charged')}</th><th className="r">{t('POS')}</th><th className="r">{t('Recorded gal')}</th><th className="r">{t('Pump meter gal')}</th></tr></thead>
                  <tbody>
                    {Object.keys(e.detail.pump).map((g) => (
                      <tr key={g}><td>{cap(g)}</td>
                        <td className="r num">{money(e.detail.digital.amounts[g])}</td><td className="r num">{money(e.detail.pos[g])}</td>
                        <td className="r num">{gal(e.detail.digital.gallons[g], 1)}</td><td className="r num">{gal(e.detail.pump[g], 1)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {e.kind === 'dispute' && e.detail && <p className="small" style={{ marginTop: 6 }}>{t('Employee says: “{text}”', { text: String(e.detail) })}</p>}
            {e.messages?.map((m: any) => (
              <p key={m.id} className="small" style={{ marginTop: 4 }}>
                <span className="muted">{t('Reply sent by {name}, {when}:', { name: m.author_name ?? '—', when: when(m.created_at) })}</span> {m.body}
              </p>
            ))}
            {e.proposal && (
              <p className="small" style={{ marginTop: 6 }}>
                {t('Proposal by {name}:', { name: e.proposed_by_name })} <b>{cap(e.proposal.action)}</b>
                {e.proposal.amount ? ` ${money(e.proposal.amount * 100)}` : ''} — {e.proposal.note}
              </p>
            )}
            {e.resolution && <p className="small muted" style={{ marginTop: 4 }}>{e.resolution}{e.resolved_by_name ? ` · ${e.resolved_by_name}` : ''}</p>}
            <div className="row" style={{ marginTop: 10 }}>
              {canPropose && e.status === 'open' && e.kind !== 'adjustment' && (
                <button className="sm" onClick={() => setProposing(e)}>{e.kind === 'shift_variance' ? t('Explain') : t('Propose resolution')}</button>
              )}
              {canPropose && e.kind === 'dispute' && e.status !== 'rejected' && (
                <button className="sm ghost" onClick={() => setReplying(e)}>{t('Reply to employee')}</button>
              )}
              {canDecide && e.status === 'proposed' && (
                <>
                  <button className="sm dark" disabled={busy || e.proposed_by === me.userId} onClick={() => decide(e.id, true)}>
                    {t('Approve')}
                  </button>
                  <button className="sm secondary" disabled={busy || e.proposed_by === me.userId} onClick={() => decide(e.id, false)}>{t('Decline')}</button>
                  {e.proposed_by === me.userId && <span className="small muted">{t('You proposed this; another approver must decide.')}</span>}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {proposing && <ProposeModal surface={surface} ex={proposing} onClose={() => setProposing(null)} onDone={() => { setProposing(null); reload(); }} />}
      {replying && <DisputeReply surface={surface} ex={replying} onClose={() => setReplying(null)} onDone={() => { setReplying(null); reload(); }} />}
    </div>
  );
}

function ProposeModal({ surface, ex, onClose, onDone }: { surface: Surface; ex: any; onClose: () => void; onDone: () => void }) {
  const variance = ex.kind === 'shift_variance';
  const [action, setAction] = useState(variance ? 'accept_variance' : 'reverse');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const body: any = { action, note };
    if (action === 'reverse') body.amount = Number(amount);
    if (await run(() => api(surface).post(`/api/exceptions/${ex.id}/propose`, body), t('Sent for distributor decision'))) onDone();
  };
  return (
    <Modal title={variance ? t('Explain variance') : t('Resolve dispute')} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{ex.summary}</p>
        {!variance && (
          <div className="seg">
            <button className={action === 'reverse' ? 'on' : ''} onClick={() => setAction('reverse')}>{t('Refund to employee')}</button>
            <button className={action === 'reject_dispute' ? 'on' : ''} onClick={() => setAction('reject_dispute')}>{t('Reject dispute')}</button>
          </div>
        )}
        {action === 'reverse' && (
          <label>{t('Amount to return to the employee (HTG)')}
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        )}
        <label>{variance ? t('Manager explanation') : t('Note')}
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="small muted">{t('A different distributor approver must approve before anything posts to the ledger.')}</p>
        <button disabled={busy || note.length < 3 || (action === 'reverse' && !(Number(amount) > 0))} onClick={submit}>{t('Submit')}</button>
      </div>
    </Modal>
  );
}

/** Reply to the employee who raised a dispute, with optional AI help: a summary of the facts, what to check, a
 * suggested outcome (advice only) and reply drafts in French and Kreyòl that staff edit before sending. */
function DisputeReply({ surface, ex, onClose, onDone }: { surface: Surface; ex: any; onClose: () => void; onDone: () => void }) {
  const [help, setHelp] = useState<any>(null);
  const [lang, setLang] = useState<'fr' | 'ht'>('fr');
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  const analyse = async () => {
    const out = await run(() => api(surface).post(`/api/exceptions/${ex.id}/ai-summary`));
    if (out) { setHelp(out); if (!text.trim()) setText(out.replies[lang]); }
  };
  const pick = (l: 'fr' | 'ht') => { setLang(l); if (help) setText(help.replies[l]); };
  const send = async () => {
    if (await run(() => api(surface).post(`/api/exceptions/${ex.id}/reply`, { text }), t('Reply sent to the employee'))) onDone();
  };
  const s = help?.suggestion;
  return (
    <Modal title={t('Reply to employee')} onClose={onClose}>
      <div className="stack">
        <p className="small muted">{ex.summary}</p>
        {ex.detail && <p className="small">{t('Employee says: “{text}”', { text: String(ex.detail) })}</p>}
        <div className="card">
          <div className="row between">
            <strong className="small">{t('AI summary')}</strong>
            <button className="sm ghost" disabled={busy} onClick={analyse}>{busy && !help ? t('Reading…') : help ? t('Ask again') : t('Analyse with AI')}</button>
          </div>
          {!help && <p className="small muted">{t('AI reads the fueling, its shift and earlier disputes, then drafts a reply in French and Kreyòl. It decides nothing: a refund or rejection still goes through Propose resolution and a second approver.')}</p>}
          {help && (
            <>
              <ul className="small" style={{ margin: '8px 0', paddingLeft: 18 }}>{help.summary.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
              {help.checks.length > 0 && <><strong className="small">{t('To check')}</strong>
                <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>{help.checks.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></>}
              <p className="small" style={{ margin: 0 }}>
                <span className={`badge ${s.action === 'refund' ? 'ok' : s.action === 'reject' ? 'bad' : 'warn'}`}>
                  {s.action === 'refund' ? (s.amountMinor ? t('Suggests a refund of {amount}', { amount: money(s.amountMinor) }) : t('Suggests a refund'))
                    : s.action === 'reject' ? t('Suggests rejecting') : t('Suggests checking further')}
                </span>{' '}{s.why}
              </p>
            </>
          )}
        </div>
        <div className="row between">
          <strong className="small">{t('Message to the employee')}</strong>
          {help && (
            <div className="seg">
              <button className={lang === 'fr' ? 'on' : ''} onClick={() => pick('fr')}>Français</button>
              <button className={lang === 'ht' ? 'on' : ''} onClick={() => pick('ht')}>Kreyòl</button>
            </div>
          )}
        </div>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Write to the employee, or start from the AI draft.')} />
        <p className="small muted">{t('The employee sees this message on their dispute in the wallet. Read it before sending.')}</p>
        <button disabled={busy || text.trim().length < 3} onClick={send}>{t('Send to employee')}</button>
      </div>
    </Modal>
  );
}
