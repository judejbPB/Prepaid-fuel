import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

/**
 * Camera QR scanner. Calls onResult once per distinct code that starts with `prefix`.
 * Falls back to a paste box when no camera is available (also handy for support staff).
 */
export function QrScanner({ prefix, onResult, facing = 'environment', label }: {
  prefix: string;
  onResult: (text: string) => void;
  facing?: 'environment' | 'user';
  label?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const last = useRef('');
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (stopped) return;
      const v = videoRef.current;
      if (v && v.readyState === v.HAVE_ENOUGH_DATA && ctx) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (found?.data?.startsWith(prefix) && found.data !== last.current) {
          last.current = found.data;
          cb.current(found.data);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError('Camera unavailable on this device.');
    } else {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } })
        .then((s) => {
          if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
          stream = s;
          if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); }
          raf = requestAnimationFrame(tick);
        })
        .catch(() => setCamError('Camera unavailable. Allow camera access, or paste the code below.'));
    }
    return () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [prefix, facing]);

  return (
    <div className="stack">
      {!camError && <div className="scanner"><video ref={videoRef} playsInline muted aria-label={label ?? 'Camera'} /></div>}
      {camError && <div className="banner">{camError}</div>}
      <details className="small">
        <summary className="muted">Enter code manually</summary>
        <textarea rows={3} className="mono" aria-label="Paste code" value={manual} onChange={(e) => setManual(e.target.value.trim())} placeholder={`${prefix}…`} />
        <button className="sm secondary mt" disabled={!manual.startsWith(prefix)} onClick={() => { cb.current(manual); setManual(''); }}>Use code</button>
      </details>
    </div>
  );
}
