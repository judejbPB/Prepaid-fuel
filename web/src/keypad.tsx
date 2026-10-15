// On-screen number pad for the station terminal. Fields are display boxes, not <input>s, so the
// Android keyboard never opens and covers the screen: the attendant taps a field, then types here.

export const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

/** Apply one key press to a typed number, respecting the allowed decimals and length. */
export function press(value: string, key: string, decimals: number, maxDigits = 9): string {
  if (key === '⌫') return value.slice(0, -1);
  if (key === 'C') return '';
  if (key === '.') {
    if (decimals === 0 || value.includes('.')) return value;
    return value === '' ? '0.' : value + '.';
  }
  const [whole, frac] = value.split('.');
  if (frac !== undefined) return frac.length >= decimals ? value : value + key;
  if (whole.replace(/^0+/, '').length >= maxDigits) return value;
  return whole === '0' ? key : value + key;
}

export function NumField({ label, value, placeholder, active, onSelect, big, suffix, testId }: {
  label: string; value: string; placeholder?: string; active: boolean; onSelect: () => void;
  big?: boolean; suffix?: string; testId?: string;
}) {
  return (
    <div className="numfield-wrap">
      <span className="numfield-label">{label}</span>
      <button type="button" className={`numfield${active ? ' active' : ''}${big ? ' big' : ''}`} onClick={onSelect}
        aria-pressed={active} data-testid={testId}>
        {value ? <span>{value}</span> : <span className="placeholder">{placeholder ?? '0'}</span>}
        {suffix && <span className="suffix">{suffix}</span>}
      </button>
    </div>
  );
}

export function Keypad({ value, onChange, decimals, maxDigits, quick, quickLabel }: {
  value: string; onChange: (v: string) => void; decimals: number; maxDigits?: number;
  quick?: number[]; quickLabel?: (n: number) => string;
}) {
  return (
    <div className="keypad-panel">
      {quick && quick.length > 0 && (
        <div className="quick-row">
          {quick.map((n) => (
            <button key={n} type="button" className="quick" onClick={() => onChange(String(n))}>{quickLabel ? quickLabel(n) : n}</button>
          ))}
        </div>
      )}
      <div className="keypad station-keypad">
        {KEYS.map((k) => (
          <button key={k} type="button" disabled={k === '.' && decimals === 0} aria-label={k === '⌫' ? 'Delete' : k}
            onClick={() => onChange(press(value, k, decimals, maxDigits))}>{k}</button>
        ))}
      </div>
      <button type="button" className="ghost sm" onClick={() => onChange('')}>Clear</button>
    </div>
  );
}
