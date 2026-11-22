import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { t } from './i18n';

// One Leaflet map for every station view. Stations are circle markers (no image files to ship); their size
// can carry a quantity (e.g. gallons) and their tone a state. Tapping a marker selects it; the page shows the
// details next to the map, so nothing is only reachable inside a popup. Tiles: OpenStreetMap.

export interface MapPoint {
  id: number;
  lat: number;
  lng: number;
  label: string;
  /** 0–1: marker size relative to the largest (e.g. gallons); omit for a plain marker. */
  weight?: number;
  tone?: 'default' | 'own' | 'warn' | 'muted';
}

const PORT_AU_PRINCE: L.LatLngExpression = [18.54, -72.33];
const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Distance in km between two points (great-circle). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Directions from wherever the phone is, in the phone's maps app. */
export const directionsUrl = (p: { lat: number; lng: number }) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

export function StationMap({ points, selected, onSelect, me, pick, onPick, height = 420 }: {
  points: MapPoint[];
  selected?: number | null;
  onSelect?: (id: number) => void;
  /** The user's own position (blue dot). */
  me?: { lat: number; lng: number } | null;
  /** Placing a station: shows this point as a draggable pin; tapping the map moves it. */
  pick?: { lat: number; lng: number } | null;
  onPick?: (p: { lat: number; lng: number }) => void;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true }).setView(PORT_AU_PRINCE, 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => onPickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // The map's box can change size after layout (tabs, phone rotation).
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const color = { default: css('--viz-1', '#2a78d6'), own: css('--amber', '#ED253E'), warn: css('--viz-2', '#eb6834'), muted: '#9aa0b4' };
    for (const p of points) {
      const tone = p.tone ?? 'default';
      const r = p.weight == null ? 8 : 6 + Math.sqrt(Math.max(0, p.weight)) * 16;
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: r, color: '#fff', weight: selected === p.id ? 4 : 2,
        fillColor: color[tone], fillOpacity: tone === 'muted' ? 0.55 : 0.9,
      });
      marker.bindTooltip(p.label, { direction: 'top', offset: [0, -r] }); // text, not HTML
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); onSelect?.(p.id); });
      marker.addTo(g);
    }
    if (me) L.circleMarker([me.lat, me.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).bindTooltip(t('You are here')).addTo(g);
    if (pick) {
      L.marker([pick.lat, pick.lng], {
        draggable: true,
        icon: L.divIcon({ className: 'map-pick', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 22] }),
      }).on('dragend', (e) => { const ll = (e.target as L.Marker).getLatLng(); onPickRef.current?.({ lat: ll.lat, lng: ll.lng }); }).addTo(g);
    }
    // Frame the stations once, when they first arrive.
    if (!fitted.current && points.length) {
      fitted.current = true;
      const all = points.map((p) => [p.lat, p.lng] as [number, number]).concat(me ? [[me.lat, me.lng]] : []);
      if (all.length === 1) m.setView(all[0], 14); else m.fitBounds(L.latLngBounds(all), { padding: [30, 30], maxZoom: 14 });
    }
  }, [points, selected, me, pick, onSelect]);

  useEffect(() => {
    const p = points.find((x) => x.id === selected);
    if (p && map.current) map.current.panTo([p.lat, p.lng]);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (pick && map.current) map.current.panTo([pick.lat, pick.lng]); }, [pick?.lat, pick?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="station-map" style={{ height }} role="region" aria-label={t('Station map')} />;
}

/** The phone's position, if the user allows it. */
export function locate(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error(t('This device cannot share its location.')));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error(t('Location not available. Allow location for this app, or place the pin on the map.'))),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}
