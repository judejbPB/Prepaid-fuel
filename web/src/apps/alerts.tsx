import { useState } from 'react';
import { api, cap, date, gal, when } from '../api';
import { Empty, Modal, PageHead, useAction, useLoad, useMe } from '../ui';
import { t } from '../i18n';

const d = api('distributor');

/** Title of each detection rule. */
const title = (rule: string) => ({
  large_fill: t('Large fill'),
  rapid_repeat: t('Repeated fueling'),
  daily_volume: t('High daily volume'),
  night: t('Night fueling'),
  attendant_variances: t('Repeated shift differences'),
  offline_share: t('Mostly offline sales'),
} as Record<string, string>)[rule] ?? rule;

/** The facts behind an alert, as a sentence in the reader's language. */
function explain(a: any): string {
  const f = a.facts;
  switch (a.rule) {
    case 'large_fill':
      return t('{gal} gal of {grade} in one fueling (limit {limit} gal).', { gal: gal(f.mgal, 1), grade: cap(f.grade).toLowerCase(), limit: gal(f.limitMgal) });
    case 'rapid_repeat':
      return f.twoStations
        ? t('Two fuelings {minutes} min apart at two different stations ({a}, then {b}); {gal} gal in total.', { minutes: f.minutes, a: f.stationNames?.[0], b: f.stationNames?.[1], gal: gal(f.mgal, 1) })
        : t('Two fuelings {minutes} min apart at the same station; {gal} gal in total.', { minutes: f.minutes, gal: gal(f.mgal, 1) });
    case 'daily_volume':
      return t('{gal} gal in {count} fuelings on {day} (limit {limit} gal per day).', { gal: gal(f.mgal, 1), count: f.count, day: date(f.day), limit: gal(f.limitMgal) });
    case 'night':
      return t('Fueling at {hour}h, Haiti time ({gal} gal).', { hour: f.hour, gal: gal(f.mgal, 1) });
    case 'attendant_variances':
      return t('{n} shifts with cash or meter differences in the last {days} days.', { n: f.shifts, days: f.days });
    case 'offline_share':
      return t('{pct}% of this terminal’s sales this week were offline ({offline} of {total}). Offline sales are only checked when the terminal reconnects.', { pct: f.share, offline: f.offline, total: f.total });
    default:
      return '';
  }
}

const SEVERITY_CLASS: Record<string, string> = { high: 'bad', medium: 'warn', low: '' };
const severity = (s: string) => (s === 'high' ? t('High') : s === 'medium' ? t('Medium') : t('Low'));

export function FuelAlerts() {
  const me = useMe();
  const canReview = me.role === 'dist_admin' || me.role === 'dist_approver';
  const [all, setAll] = useState(false);
  const { data, reload } = useLoad(() => d.get(`/api/alerts${all ? '?status=all' : ''}`), [all]);
  const [reviewing, setReviewing] = useState<{ alert: any; outcome: 'cleared' | 'confirmed' } | null>(null);

  return (
    <>
      <PageHead eyebrow={t('Controls')} title={t('Fuel alerts')} />
      <div className="card white">
        <p className="small muted">{t('Fixed rules look at the last 30 days of fuel sales and shifts and flag patterns worth a look. An alert blocks nothing and accuses no one: a person checks it, then marks it normal or to follow up. To stop an employee or a terminal, use Freeze in Clients & stations.')}</p>
        <label className="row mt" style={{ flexDirection: 'row' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={all} onChange={(e) => setAll(e.target.checked)} /> {t('Show reviewed alerts')}
        </label>
      </div>
      <div className="stack mt">
        {data?.map((a: any) => (
          <div key={a.id} className="card white">
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div className="row">
                  <span className={`badge ${SEVERITY_CLASS[a.severity]}`}>{severity(a.severity)}</span>
                  <strong>{title(a.rule)}</strong>
                  <span className="small muted">{when(a.created_at)}</span>
                </div>
                <p className="mt" style={{ marginBottom: 6 }}>{explain(a)}</p>
                <p className="small muted" style={{ margin: 0 }}>
                  {[a.employee_name && `${t('Employee')} : ${a.employee_name}`, a.company_name, a.station_name, a.attendant_name && `${t('Attendant')} : ${a.attendant_name}`]
                    .filter(Boolean).join(' · ')}
                  {a.facts.codes ? ` · ${a.facts.codes.join(', ')}` : a.facts.code ? ` · ${a.facts.code}` : ''}
                </p>
                {a.status !== 'open' && (
                  <p className="small mt" style={{ marginBottom: 0 }}>
                    <span className={`badge ${a.status === 'confirmed' ? 'bad' : 'ok'}`}>{a.status === 'confirmed' ? t('To follow up') : t('Normal')}</span>{' '}
                    {a.review_note} <span className="muted">— {a.reviewed_by_name}, {when(a.reviewed_at)}</span>
                  </p>
                )}
              </div>
              {a.status === 'open' && canReview && (
                <div className="row">
                  <button className="sm ghost" onClick={() => setReviewing({ alert: a, outcome: 'cleared' })}>{t('Normal')}</button>
                  <button className="sm" onClick={() => setReviewing({ alert: a, outcome: 'confirmed' })}>{t('To follow up')}</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {data && !data.length && <div className="card white"><Empty>{all ? t('No alerts in the last 30 days.') : t('No alerts to review.')}</Empty></div>}
      </div>
      {!canReview && <p className="small muted mt">{t('Only the distributor admin or approver can review alerts.')}</p>}
      {reviewing && <Review {...reviewing} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); reload(); }} />}
    </>
  );
}

function Review({ alert, outcome, onClose, onDone }: { alert: any; outcome: 'cleared' | 'confirmed'; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={outcome === 'cleared' ? t('Mark as normal') : t('Mark to follow up')} onClose={onClose}>
      <div className="stack">
        <p className="small"><strong>{title(alert.rule)}</strong> · {explain(alert)}</p>
        <label>{outcome === 'cleared' ? t('Why is it normal? (e.g. delivery truck with a 50 gal tank)') : t('What happens next? (e.g. call the company, check the pump camera)')}
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button disabled={busy || note.trim().length < 2} onClick={async () => {
          if (await run(() => d.post(`/api/alerts/${alert.id}/review`, { outcome, note: note.trim() }), t('Alert reviewed'))) onDone();
        }}>{t('Save')}</button>
      </div>
    </Modal>
  );
}
