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
