// Reads the first worksheet of an Excel workbook (.xlsx) into rows of text, so bank statements exported
// to Excel go through the same importer as CSV. Haitian banks have no statement API: treasury downloads a
// file from online banking and uploads it here. Old binary .xls files are not supported (save as .xlsx).
import { inflateRawSync } from 'node:zlib';
import { badRequest } from '../errors.js';

const MAX_ENTRY_BYTES = 50 * 1024 * 1024; // guards against zip bombs

/** True when the bytes look like an .xlsx (zip) workbook. */
export const isXlsx = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
/** True for the legacy binary Excel format (.xls, OLE2), which we can't read. */
export const isLegacyXls = (buf: Buffer) => buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1;

/** The named entries of a zip archive (stored or deflated). */
function unzip(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw badRequest('bad_xlsx', 'This Excel file is damaged or not an .xlsx workbook');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw badRequest('bad_xlsx', 'This Excel file is damaged or not an .xlsx workbook');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!wanted(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw badRequest('bad_xlsx', 'This Excel file uses an unsupported compression');
  }
  return out;
}

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

/** Text of an <si> or <is> element: all <t> runs, without phonetic hints. */
const runText = (xml: string) =>
  decode([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateFormat = (code: string) => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

/** Which cell styles (by index) display a date. */
function dateStyles(xml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrs(m[0]);
    custom.set(Number(a.numFmtId), a.formatCode ?? '');
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
    const id = Number(attrs(m[0]).numFmtId ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) out.add(i);
  });
  return out;
}

/** Excel serial day number → ISO date (time of day dropped). */
function serialToDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

const columnIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** The first worksheet of an .xlsx workbook as rows of cell text (blank rows dropped). */
export function readXlsx(buf: Buffer): string[][] {
  if (isLegacyXls(buf)) throw badRequest('old_xls', 'Old Excel format (.xls): open it in Excel and save it as .xlsx or CSV, then upload again');
  if (!isXlsx(buf)) throw badRequest('bad_xlsx', 'This Excel file is damaged or not an .xlsx workbook');
  const parts = unzip(buf, (n) => n.startsWith('xl/') && !n.startsWith('xl/media/'));
  const text = (name: string) => parts.get(name)?.toString('utf8');

  const workbook = text('xl/workbook.xml') ?? '';
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*"(1|true)"/.test(workbook);
  const firstSheet = /<sheet\b[^>]*>/.exec(workbook);
  const relId = firstSheet ? (attrs(firstSheet[0])['r:id'] ?? '') : '';
  const rel = [...(text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => attrs(m[0])).find((a) => a.Id === relId);
  const target = rel?.Target?.replace(/^\/?xl\//, '').replace(/^\//, '');
  const sheet = text(target ? `xl/${target}` : 'xl/worksheets/sheet1.xml');
  if (!sheet) throw badRequest('bad_xlsx', 'This Excel file has no worksheet');

  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]));
  const dates = dateStyles(text('xl/styles.xml'));

  const rows: string[][] = [];
  for (const r of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    let next = 0;
    for (const c of (r[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]);
      const col = a.r ? columnIndex(a.r) : next;
      next = col + 1;
      const inner = c[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (a.t === 's') value = shared[Number(v)] ?? '';
      else if (a.t === 'inlineStr') value = runText(inner);
      else if (a.t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (a.t === 'e') value = '';
      else if (v !== undefined) {
        value = decode(v);
        const n = Number(value);
        if ((a.t === undefined || a.t === 'n') && Number.isFinite(n) && dates.has(Number(a.s ?? 0))) value = serialToDate(n, date1904);
      }
      while (row.length < col) row.push('');
      row[col] = value;
    }
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}
