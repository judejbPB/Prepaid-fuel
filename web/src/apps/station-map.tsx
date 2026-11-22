import { useEffect, useMemo, useState } from 'react';
import { api, gal, when, type Surface } from '../api';
import { locale, t } from '../i18n';
import { directionsUrl, distanceKm, locate, StationMap, type MapPoint } from '../map';
import { Empty, PageHead, useAction, useLoad } from '../ui';

// The station map, one page per kind of user (data from GET /api/map, shaped by role on the server):
//   NetworkMap     distributor: the network's health, and placing stations that have no location yet
//   CompanyMap     company staff: where our employees fuel (last 30 days)
//   MyStationMap   station manager: set the station's exact location and hours so employees can find it
//   FuelNearMe     employee wallet: open stations nearest to me, with directions

const km = (d: number) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toLocaleString(locale, { maximumFractionDigits: d < 10 ? 1 : 0 })} km`);
const located = (s: any) => s.lat != null && s.lng != null;

function Legend({ items }: { items: [string, string][] }) {
  return <div className="map-legend">{items.map(([color, label]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>;
}

/** Hours and address fields plus a save button; the pin comes from the map (tap, drag, or "use my position"). */
function LocationEditor({ client, station, pick, setPick, onSaved, onCancel }: {
  client: ReturnType<typeof api>; station: any; pick: { lat: number; lng: number } | null;
  setPick: (p: { lat: number; lng: number }) => void; onSaved: () => void; onCancel?: () => void;
}) {
  const [address, setAddress] = useState(station.address ?? '');
  const [hours, setHours] = useState(station.hours ?? '');
  const [locating, setLocating] = useState(false);
  const { busy, run } = useAction();
  const here = async () => {
    setLocating(true);
    try { setPick(await locate()); } catch (e) { await run(() => Promise.reject(e)); } finally { setLocating(false); }
  };
  const save = async () => {
    if (!pick) return;
    if (await run(() => client.post(`/api/stations/${station.id}/location`, { lat: pick.lat, lng: pick.lng, address, hours }), t('Location saved'))) onSaved();
  };
  return (
    <div className="card white">
      <h2 style={{ marginBottom: 4 }}>{t('Location of {station}', { station: station.name })}</h2>
      <p className="small muted">{t('Tap the map where the pumps are, or drag the pin. At the station, “Use my position” places it from the phone.')}</p>
      <div className="row mt">
        <button className="secondary sm" disabled={locating} onClick={here}>{locating ? t('Locating…') : t('Use my position')}</button>
        <span className="small muted">{pick ? `${pick.lat.toFixed(5)}, ${pick.lng.toFixed(5)}` : t('No pin yet')}</span>
      </div>
      <div className="grid g2 mt">
        <label>{t('Address')}<input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} /></label>
        <label>{t('Opening hours')}<input value={hours} onChange={(e) => setHours(e.target.value)} maxLength={100} placeholder={t('e.g. 6h–22h, 7 days')} /></label>
      </div>
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <button className="secondary" onClick={onCancel}>{t('Cancel')}</button>}
        <button disabled={busy || !pick} onClick={save}>{t('Save location')}</button>
      </div>
    </div>
  );
}

const TERMINAL: Record<string, () => string> = {
  active: () => t('Terminal active'), not_activated: () => t('Terminal not activated'), frozen: () => t('Terminal frozen'), none: () => t('No terminal'),
};

export function NetworkMap() {
  const client = useMemo(() => api('distributor'), []);
  const { data, reload } = useLoad(() => client.get('/api/map'), []);
  const [selected, setSelected] = useState<number | null>(null);
  const [placing, setPlacing] = useState<any>(null);
  const [pick, setPick] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => { document.title = `${t('Network map')} · ALFA`; }, []);
  if (!data) return null;
  const max = Math.max(1, ...data.stations.map((s: any) => s.mgal_month));
  const attention = (s: any) => s.status !== 'active' || s.terminal !== 'active' || s.open_alerts > 0 || s.open_exceptions > 0;
  const points: MapPoint[] = data.stations.filter(located).map((s: any) => ({
    id: s.id, lat: s.lat, lng: s.lng, label: s.name, weight: s.mgal_month / max, tone: attention(s) ? 'warn' : 'default',
  }));
  const sel = data.stations.find((s: any) => s.id === selected);
  const startPlacing = (s: any) => { setPlacing(s); setPick(located(s) ? { lat: s.lat, lng: s.lng } : null); setSelected(s.id); };

  return (
    <>
      <PageHead eyebrow={t('Clients & stations')} title={t('Network map')} />
      <p className="small muted">{t('Every station, sized by gallons served through ALFA this month. Orange needs a look: open alerts or exceptions, a terminal that is not working, or a frozen station.')}</p>
      {data.missing_location > 0 && <div className="banner warn mt">{t('{n} station(s) have no location yet: employees cannot find them on their map.', { n: data.missing_location })}</div>}
      <div className="grid g2 mt" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div>
          <StationMap points={points} selected={selected} onSelect={(id) => { if (!placing) setSelected(id); }}
            pick={placing ? pick : null} onPick={placing ? setPick : undefined} height={460} />
          <Legend items={[['var(--viz-1)', t('Running normally')], ['var(--viz-2)', t('Needs a look')]]} />
        </div>
        <div className="stack">
          {placing ? (
            <LocationEditor client={client} station={placing} pick={pick} setPick={setPick}
              onSaved={() => { setPlacing(null); reload(); }} onCancel={() => setPlacing(null)} />
          ) : sel ? (
            <div className="card white">
              <h2 style={{ marginBottom: 2 }}>{sel.name}</h2>
              <div className="small muted">{sel.address ?? t('No address')}{sel.hours ? ` · ${sel.hours}` : ''}</div>
              <table className="mt"><tbody>
                <tr><td>{t('Gallons this month')}</td><td className="r num">{gal(sel.mgal_month, 1)}</td></tr>
                <tr><td>{t('Fuelings this month')}</td><td className="r num">{sel.fuelings_month}</td></tr>
                <tr><td>{t('Last fueling')}</td><td className="r">{sel.last_fueling ? when(sel.last_fueling) : '–'}</td></tr>
                <tr><td>{t('Terminal')}</td><td className="r">{TERMINAL[sel.terminal]()}</td></tr>
                <tr><td>{t('Fuel alerts to review')}</td><td className="r num">{sel.open_alerts}</td></tr>
                <tr><td>{t('Open exceptions')}</td><td className="r num">{sel.open_exceptions}</td></tr>
              </tbody></table>
              <div className="row mt" style={{ justifyContent: 'flex-end' }}><button className="sm secondary" onClick={() => startPlacing(sel)}>{t('Move on the map')}</button></div>
            </div>
          ) : <div className="card white"><p className="small muted">{t('Select a station on the map or in the list.')}</p></div>}
          <div className="map-list">
            {data.stations.map((s: any) => (
              <button key={s.id} className={`map-item${selected === s.id ? ' on' : ''}`} onClick={() => (located(s) ? setSelected(s.id) : startPlacing(s))}>
                <div className="row between"><b>{s.name}</b>{!located(s) ? <span className="badge warn">{t('Place on the map')}</span> : attention(s) && <span className="badge warn">{t('Needs a look')}</span>}</div>
                <div className="small muted">{t('{gal} gal this month', { gal: gal(s.mgal_month, 1) })} · {TERMINAL[s.terminal]()}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function CompanyMap() {
  const client = useMemo(() => api('corporate'), []);
  const { data } = useLoad(() => client.get('/api/map'), []);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => { document.title = `${t('Station map')} · ALFA`; }, []);
  if (!data) return null;
  const stations = [...data.stations].sort((a: any, b: any) => b.mgal_30d - a.mgal_30d);
  const max = Math.max(1, ...stations.map((s: any) => s.mgal_30d));
  const points: MapPoint[] = stations.map((s: any) => ({
    id: s.id, lat: s.lat, lng: s.lng, label: s.name, weight: s.mgal_30d / max, tone: s.mgal_30d ? 'default' : 'muted',
  }));
  return (
    <>
      <PageHead eyebrow={t('Fuel usage')} title={t('Where your employees fuel')} />
      <p className="small muted">{t('Stations in the ALFA network, sized by the gallons your employees took there in the last 30 days. Grey: not used by your employees.')}</p>
      <div className="grid g2 mt" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div>
          <StationMap points={points} selected={selected} onSelect={setSelected} height={460} />
          <Legend items={[['var(--viz-1)', t('Used by your employees')], ['#9aa0b4', t('Not used yet')]]} />
        </div>
        <div className="map-list">
          {!stations.length && <Empty>{t('No stations on the map yet.')}</Empty>}
          {stations.map((s: any) => (
            <button key={s.id} className={`map-item${selected === s.id ? ' on' : ''}`} onClick={() => setSelected(s.id)}>
              <div className="row between"><b>{s.name}</b>{!s.open && <span className="badge warn">{t('Closed')}</span>}</div>
              <div className="small muted">{s.address ?? ''}{s.hours ? ` · ${s.hours}` : ''}</div>
              <div className="small" style={{ marginTop: 4 }}>{s.fuelings_30d
                ? t('{gal} gal · {n} fueling(s) · {e} employee(s)', { gal: gal(s.mgal_30d, 1), n: s.fuelings_30d, e: s.employees_30d })
                : <span className="muted">{t('No fuelings by your employees in 30 days')}</span>}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function MyStationMap({ surface = 'station' }: { surface?: Surface }) {
  const client = useMemo(() => api(surface), [surface]);
  const { data, reload } = useLoad(() => client.get('/api/map'), []);
  const [pick, setPick] = useState<{ lat: number; lng: number } | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { document.title = `${t('My station on the map')} · ALFA`; }, []);
  const own = data?.stations.find((s: any) => s.own);
  useEffect(() => { if (own && located(own)) setPick({ lat: own.lat, lng: own.lng }); else if (own) setEditing(true); }, [own?.id, own?.lat, own?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !own) return null;
  const points: MapPoint[] = data.stations.filter((s: any) => located(s) && !(editing && s.own))
    .map((s: any) => ({ id: s.id, lat: s.lat, lng: s.lng, label: s.name, tone: s.own ? 'own' : 'muted' }));
  return (
    <>
      <PageHead eyebrow={own.name} title={t('My station on the map')} />
      <p className="small muted">{t('Employees see this point, the address and the opening hours in their wallet to find your station. Keep them exact.')}</p>
      {!located(own) && <div className="banner warn mt">{t('Your station is not on the map yet: employees cannot find it. Place it below.')}</div>}
      <div className="grid g2 mt" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', alignItems: 'start' }}>
        <div>
          <StationMap points={points} selected={own.id} pick={editing ? pick : null} onPick={editing ? setPick : undefined} height={420} />
          <Legend items={[['var(--amber)', t('Your station')], ['#9aa0b4', t('Other ALFA stations')]]} />
        </div>
        {editing ? (
          <LocationEditor client={client} station={own} pick={pick} setPick={setPick} onSaved={() => { setEditing(false); reload(); }}
            onCancel={located(own) ? () => { setEditing(false); setPick({ lat: own.lat, lng: own.lng }); } : undefined} />
        ) : (
          <div className="card white">
            <h2 style={{ marginBottom: 2 }}>{own.name}</h2>
            <div className="small muted">{own.address ?? t('No address')}</div>
            <div className="small" style={{ marginTop: 4 }}>{own.hours ? t('Open: {hours}', { hours: own.hours }) : <span className="muted">{t('Opening hours not set')}</span>}</div>
            <div className="small muted mt">{t('{gal} gal and {n} fueling(s) through ALFA this month', { gal: gal(own.mgal_month, 1), n: own.fuelings_month })}</div>
            <div className="row mt" style={{ justifyContent: 'flex-end' }}><button className="sm secondary" onClick={() => setEditing(true)}>{t('Correct the location or hours')}</button></div>
          </div>
        )}
      </div>
    </>
  );
}

export function FuelNearMe() {
  const client = useMemo(() => api('employee'), []);
  const { data } = useLoad(() => client.get('/api/map'), []);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [problem, setProblem] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => { locate().then(setMe).catch((e) => setProblem(e.message)); }, []);
  if (!data) return null;
  const stations = data.stations.map((s: any) => ({ ...s, km: me ? distanceKm(me, s) : null }))
    .sort((a: any, b: any) => (a.km ?? 0) - (b.km ?? 0) || b.my_fuelings - a.my_fuelings);
  const points: MapPoint[] = stations.map((s: any) => ({ id: s.id, lat: s.lat, lng: s.lng, label: s.name }));
  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>{t('Where to fuel')}</h2>
      <p className="small muted" style={{ margin: 0 }}>{me ? t('ALFA stations open to your wallet, nearest first.') : problem || t('Finding your position…')}</p>
      <StationMap points={points} selected={selected} onSelect={setSelected} me={me} height={240} />
      {!stations.length && <Empty>{t('No station is on the map yet.')}</Empty>}
      <div className="map-list">
        {stations.map((s: any) => (
          <div key={s.id} className={`map-item${selected === s.id ? ' on' : ''}`} onClick={() => setSelected(s.id)}>
            <div className="row between"><b>{s.name}</b>{s.km != null && <span className="small"><b>{km(s.km)}</b></span>}</div>
            <div className="small muted">{s.address ?? ''}</div>
            {s.hours && <div className="small">{t('Open: {hours}', { hours: s.hours })}</div>}
            {s.my_fuelings > 0 && <div className="small muted">{t('You fueled here {n} time(s) in 90 days', { n: s.my_fuelings })}</div>}
            <button className="sm secondary" style={{ marginTop: 8 }}
              onClick={(e) => { e.stopPropagation(); window.open(directionsUrl(s), '_blank', 'noopener'); }}>{t('Directions')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
