// MP4 / MOV / M4V / 3GP metadata removal without loading the video into memory.
//
// Only the small boxes around the video data are read (mainly "moov"). They are
// edited in place at the same size, so every offset into the video data stays
// valid. The output is a Blob stitched from untouched slices of the original
// file plus the edited boxes, so even multi-GB files are cleaned in about a second.
import { ascii, u16be, u32be, utf8 } from './meta/bytes';

export type VideoMode = 'all' | 'gps';

export interface VideoReport {
  found: string[];
  removed: string[];
  location?: string;
  hasGps: boolean;
  warnings: string[];
}

interface Box {
  type: string;
  start: number;
  header: number;
  end: number;
}

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
// Sample formats of timed-metadata tracks that carry GPS/telemetry
const TELEMETRY = new Set(['gpmd', 'camm']);
const MAX_READ = 256 * 1024 * 1024;

const hex = (b: Uint8Array, o: number, n: number) => Array.from(b.subarray(o, o + n), (x) => x.toString(16).padStart(2, '0')).join('');
const FREE = [0x66, 0x72, 0x65, 0x65];

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32be(b, p);
    let header = 8;
    if (size === 1) {
      size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12);
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header || p + size > to) break;
    out.push({ type: ascii(b, p + 4, 4), start: p, header, end: p + size });
    p += size;
  }
  return out;
}

/** Turn a box into a 'free' box full of zeros (same size, so nothing moves). */
function blank(b: Uint8Array, box: Box) {
  b.set(FREE, box.start + 4);
  b.fill(0, box.start + box.header, box.end);
}

const isFourCC = (b: Uint8Array, o: number) => o + 4 <= b.length && Array.from(b.subarray(o, o + 4)).every((c) => c >= 0x20 && c < 0x7f);

/** Apple's 'meta' (hdlr mdta) has no version/flags; the ISO one does. */
const metaChildrenStart = (b: Uint8Array, box: Box) => {
  const p = box.start + box.header;
  return isFourCC(b, p + 4) && ascii(b, p + 4, 4) === 'hdlr' ? p : p + 4;
};

/** ISO 6709 "+37.3349-122.0090+010.000/" → "37.3349, -122.0090" */
function iso6709(s: string): string | undefined {
  const m = s.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  return m ? `${Number(m[1])}, ${Number(m[2])}` : undefined;
}

class Moov {
  report: VideoReport = { found: [], removed: [], hasGps: false, warnings: [] };
  /** absolute file ranges to overwrite with zeros (telemetry samples) */
  zeroRanges: Array<[number, number]> = [];
  /** telemetry label → its sample ranges, to tell whether it was already blanked */
  telemetry: Array<{ label: string; ranges: Array<[number, number]> }> = [];

  constructor(
    private b: Uint8Array,
    private mode: VideoMode,
  ) {}

  private note(label: string, removed: boolean) {
    if (!this.report.found.includes(label)) this.report.found.push(label);
    if (removed && !this.report.removed.includes(label)) this.report.removed.push(label);
  }

  private zeroTimes(box: Box) {
    if (this.mode !== 'all') return;
    const p = box.start + box.header;
    const v1 = this.b[p] === 1;
    const times = this.b.subarray(p + 4, p + 4 + (v1 ? 16 : 8)); // creation + modification time
    if (times.every((x) => x === 0)) return; // already clear
    times.fill(0);
    this.note('Recording date and time', true);
  }

  udta(box: Box) {
    const b = this.b;
    for (const c of boxes(b, box.start + box.header, box.end)) {
      if (c.type === 'free' || c.type === 'skip') continue; // already blanked
      if (c.type === '©xyz' || c.type === 'loci') {
        this.report.hasGps = true;
        if (c.type === '©xyz') this.report.location ??= iso6709(utf8(b.subarray(c.start + c.header + 4, c.end)));
        this.note('GPS location', true);
        blank(b, c);
      } else if (c.type === 'meta') this.meta(c);
      else if (c.type === 'XMP_' && /GPS/.test(utf8(b.subarray(c.start + c.header, c.end)))) {
        this.report.hasGps = true;
        this.note('XMP (with location)', true);
        blank(b, c);
      } else if (this.mode === 'all') {
        this.note(c.type.startsWith('©') ? 'Camera, software and text tags' : 'User data', true);
        blank(b, c);
      }
    }
  }

  /** Apple QuickTime keys/ilst (make, model, software, location, creation date) or iTunes-style tags. */
  meta(box: Box) {
    const b = this.b;
    const kids = boxes(b, metaChildrenStart(b, box), box.end);
    const keysBox = kids.find((k) => k.type === 'keys');
    const ilst = kids.find((k) => k.type === 'ilst');
    const keys: string[] = [];
    if (keysBox) {
      let p = keysBox.start + keysBox.header + 8; // version/flags + entry_count
      while (p + 8 <= keysBox.end) {
        const size = u32be(b, p);
        if (size < 8) break;
        keys.push(utf8(b.subarray(p + 8, p + size)));
        p += size;
      }
    }
    for (const item of ilst ? boxes(b, ilst.start + ilst.header, ilst.end) : []) {
      const key = keys[u32be(b, item.start + 4) - 1] ?? item.type;
      const data = boxes(b, item.start + item.header, item.end).find((d) => d.type === 'data');
      const isLoc = /location/i.test(key);
      if (isLoc) {
        this.report.hasGps = true;
        if (data && /ISO6709/i.test(key)) this.report.location ??= iso6709(utf8(b.subarray(data.start + data.header + 8, data.end)));
      }
      const label = isLoc ? 'GPS location' : /make|model|software|creationdate/i.test(key) ? 'Camera, software and text tags' : 'Other tags';
      const remove = this.mode === 'all' || isLoc;
      this.note(label, remove);
      if (remove && data) b.fill(0, data.start + data.header + 8, data.end); // keep type/locale, blank the value
    }
    if (this.mode === 'all') blank(b, box);
  }

  uuid(box: Box) {
    const id = hex(this.b, box.start + box.header, 16);
    if (id === C2PA_UUID) {
      this.note('C2PA Content Credentials', true);
      blank(this.b, box);
    } else if (id === XMP_UUID) {
      const gps = /GPS/.test(utf8(this.b.subarray(box.start + box.header + 16, box.end)));
      if (gps) this.report.hasGps = true;
      const remove = this.mode === 'all' || gps;
      this.note('XMP metadata', remove);
      if (remove) blank(this.b, box);
    }
  }

  private trak(box: Box) {
    const b = this.b;
    const find = (parent: Box, path: string[]): Box | undefined => {
      let cur: Box | undefined = parent;
      for (const t of path) cur = cur && boxes(b, cur.start + cur.header, cur.end).find((x) => x.type === t);
      return cur;
    };
    const hdlr = find(box, ['mdia', 'hdlr']);
    const handler = hdlr ? ascii(b, hdlr.start + hdlr.header + 8, 4) : '';
    const stbl = find(box, ['mdia', 'minf', 'stbl']);
    const stsd = stbl && find(stbl, ['stsd']);
    const format = stsd ? ascii(b, stsd.start + stsd.header + 12, 4) : '';

    for (const c of boxes(b, box.start + box.header, box.end)) {
      if (c.type === 'tkhd') this.zeroTimes(c);
      else if (c.type === 'udta') this.udta(c);
      else if (c.type === 'meta') this.meta(c);
    }
    const mdhd = find(box, ['mdia', 'mdhd']);
    if (mdhd) this.zeroTimes(mdhd);

    if (stbl && (TELEMETRY.has(format) || (handler === 'meta' && format !== 'mebx'))) {
      // GPS/sensor telemetry lives in the video data itself: blank those samples.
      const label = format === 'gpmd' ? 'GoPro GPS/sensor telemetry' : format === 'camm' ? 'Camera motion & GPS track' : 'Timed metadata track';
      const ranges = sampleRanges(b, stbl);
      this.telemetry.push({ label, ranges });
      this.report.hasGps ||= format === 'gpmd' || format === 'camm';
      this.note(label, true);
      this.zeroRanges.push(...ranges);
    }
  }

  run(moov: Box) {
    for (const c of boxes(this.b, moov.start + moov.header, moov.end)) {
      if (c.type === 'mvhd') this.zeroTimes(c);
      else if (c.type === 'trak') this.trak(c);
      else if (c.type === 'udta') this.udta(c);
      else if (c.type === 'meta') this.meta(c);
      else if (c.type === 'uuid') this.uuid(c);
    }
    return this;
  }
}

/** Absolute byte ranges of every sample in a track, from stsc/stsz/stco. */
function sampleRanges(b: Uint8Array, stbl: Box): Array<[number, number]> {
  const kids = boxes(b, stbl.start + stbl.header, stbl.end);
  const stsc = kids.find((k) => k.type === 'stsc');
  const stsz = kids.find((k) => k.type === 'stsz');
  const stco = kids.find((k) => k.type === 'stco' || k.type === 'co64');
  if (!stsc || !stsz || !stco) return [];
  const p = (box: Box) => box.start + box.header + 4;

  const chunkCount = u32be(b, p(stco));
  const wide = stco.type === 'co64';
  const offset = (i: number) => (wide ? u32be(b, p(stco) + 4 + i * 8) * 2 ** 32 + u32be(b, p(stco) + 8 + i * 8) : u32be(b, p(stco) + 4 + i * 4));
  const fixed = u32be(b, p(stsz));
  const sampleCount = u32be(b, p(stsz) + 4);
  const size = (i: number) => (fixed || u32be(b, p(stsz) + 8 + i * 4));
  const runs = u32be(b, p(stsc));
  const run = (i: number) => ({ first: u32be(b, p(stsc) + 4 + i * 12), per: u32be(b, p(stsc) + 8 + i * 12) });

  const out: Array<[number, number]> = [];
  let sample = 0;
  for (let r = 0; r < runs; r++) {
    const { first, per } = run(r);
    const last = r + 1 < runs ? run(r + 1).first - 1 : chunkCount;
    for (let chunk = first; chunk <= last && chunk <= chunkCount; chunk++) {
      let len = 0;
      for (let s = 0; s < per && sample < sampleCount; s++) len += size(sample++);
      if (len) out.push([offset(chunk - 1), offset(chunk - 1) + len]);
    }
  }
  return out;
}

const read = async (file: Blob, start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());

async function topLevel(file: Blob): Promise<Box[]> {
  const out: Box[] = [];
  let p = 0;
  while (p + 8 <= file.size && out.length < 10_000) {
    const h = await read(file, p, p + 16);
    let size = u32be(h, 0);
    let header = 8;
    if (size === 1) {
      size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
      header = 16;
    } else if (size === 0) size = file.size - p;
    if (size < header || p + size > file.size) break;
    out.push({ type: ascii(h, 4, 4), start: p, header, end: p + size });
    p += size;
  }
  return out;
}

export const VIDEO_ACCEPT = '.mp4,.mov,.m4v,.3gp,.3g2,video/mp4,video/quicktime,video/x-m4v,video/3gpp';

export async function cleanVideo(file: Blob, mode: VideoMode = 'all'): Promise<{ blob: Blob; report: VideoReport }> {
  const head = await read(file, 0, 12);
  if (ascii(head, 4, 4) !== 'ftyp' && !['moov', 'mdat', 'wide', 'free'].includes(ascii(head, 4, 4))) {
    throw new Error('Not an MP4 or MOV video. WebM, MKV and AVI are not supported yet.');
  }
  const top = await topLevel(file);
  if (!top.some((t) => t.type === 'moov')) throw new Error('This video is incomplete or damaged (no index found).');

  const replaced = new Map<number, Uint8Array>();
  const report: VideoReport = { found: [], removed: [], hasGps: false, warnings: [] };
  const zeroRanges: Array<[number, number]> = [];
  const merge = (r: VideoReport) => {
    for (const k of ['found', 'removed', 'warnings'] as const) for (const x of r[k]) if (!report[k].includes(x)) report[k].push(x);
    report.hasGps ||= r.hasGps;
    report.location ??= r.location;
  };

  for (const box of top) {
    if (!['moov', 'uuid', 'meta', 'udta'].includes(box.type)) continue;
    if (box.end - box.start > MAX_READ) {
      report.warnings.push(`Skipped an unusually large ${box.type} section`);
      continue;
    }
    const bytes = await read(file, box.start, box.end);
    const local = { ...box, start: 0, end: bytes.length };
    const m = new Moov(bytes, mode);
    if (box.type === 'moov') m.run(local);
    else if (box.type === 'uuid') m.uuid(local);
    else if (box.type === 'meta') m.meta(local);
    else m.udta(local);
    // Telemetry already all zeros (a file cleaned before) is not reported again.
    for (const t of m.telemetry) {
      let clean = true;
      for (const [s, e] of t.ranges) {
        if (e <= s || e > file.size) continue;
        if ((await read(file, s, Math.min(e, s + 65536))).some((x) => x !== 0)) {
          clean = false;
          break;
        }
      }
      if (clean) {
        m.report.found = m.report.found.filter((x) => x !== t.label);
        m.report.removed = m.report.removed.filter((x) => x !== t.label);
      }
    }
    m.report.hasGps = m.report.found.some((x) => /GPS|location/i.test(x));
    merge(m.report);
    zeroRanges.push(...m.zeroRanges);
    replaced.set(box.start, bytes);
  }

  // Stitch: original slices + edited boxes + zeros over telemetry samples.
  const parts: BlobPart[] = [];
  const ranges = zeroRanges.filter(([s, e]) => e > s && e <= file.size).sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let zeroBuf = new Uint8Array(0);
  const zeros = (n: number) => {
    if (zeroBuf.length < n) zeroBuf = new Uint8Array(Math.max(n, 65536));
    return zeroBuf.subarray(0, n);
  };
  const copyTo = (end: number) => {
    // copy [cursor, end) from the file, but with zeros over telemetry ranges
    while (cursor < end) {
      const r = ranges.find(([s, e]) => e > cursor && s < end);
      if (!r) {
        parts.push(file.slice(cursor, end));
        cursor = end;
      } else {
        if (r[0] > cursor) parts.push(file.slice(cursor, r[0]));
        const zEnd = Math.min(r[1], end);
        parts.push(zeros(zEnd - Math.max(r[0], cursor)).slice());
        cursor = zEnd;
      }
    }
  };
  for (const box of top) {
    const edited = replaced.get(box.start);
    if (edited) {
      copyTo(box.start);
      parts.push(edited as BlobPart);
      cursor = box.end;
    }
  }
  copyTo(file.size);

  const blob = new Blob(parts, { type: file.type || 'video/mp4' });
  if (blob.size !== file.size) throw new Error('Internal error: output size changed');
  return { blob, report };
}
