// Camera RAW metadata removal (CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF…).
//
// RAW files are fragile: editors need the maker notes, colour data and the exact
// byte layout to decode the sensor data. So nothing is ever moved or cut out.
// Identifying values are overwritten in place with blanks (same size, same
// offsets), the GPS directory is emptied, and XMP packets are replaced by an
// empty packet padded to the same length. Sensor data is never touched, and the
// file keeps exactly the same size.
//
// Pure byte code with no DOM, so it runs in the browser and in Node.
import { ascii, startsWith } from './meta/bytes';

export interface RawOptions {
  /** Also blank the capture and modification dates. Default true. */
  removeDates?: boolean;
}

export interface RawReport {
  /** e.g. "Canon CR3" */
  format: string;
  make?: string;
  model?: string;
  /** What the file contained before cleaning: [label, value] */
  found: [string, string][];
  /** Labels of what was removed */
  removed: string[];
  /** What was kept on purpose, and why */
  kept: string[];
  warnings: string[];
  /** Number of bytes that changed (all inside metadata) */
  changedBytes: number;
}

export interface RawResult {
  output: Uint8Array;
  report: RawReport;
}

export const RAW_EXTENSIONS = ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'rw2', 'orf', 'pef', 'srw', '3fr', 'erf', 'mef', 'mos', 'tif', 'tiff'];
export const RAW_ACCEPT = RAW_EXTENSIONS.map((e) => `.${e}`).join(',');

export class UnsupportedRawError extends Error {}

// ---------------------------------------------------------------------------

interface Tiff {
  /** absolute offset of the TIFF header; IFD offsets are relative to this */
  base: number;
  /** absolute end of the readable region */
  end: number;
  le: boolean;
}

interface Entry {
  at: number;
  tag: number;
  type: number;
  count: number;
  /** absolute offset of the value */
  data: number;
  size: number;
  valid: boolean;
}

type Kind = 'main' | 'exif' | 'gps' | 'canon' | 'fuji' | 'pana';

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/** Text tags blanked in IFD0 / Exif / SubIFDs, by tag id. */
const BLANK_TAGS: Record<number, { label: string; kind: 'text' | 'date' | 'bin' }> = {
  0x010e: { label: 'Image description', kind: 'text' },
  0x013b: { label: 'Artist / owner', kind: 'text' },
  0x8298: { label: 'Copyright notice', kind: 'text' },
  0x013c: { label: 'Host computer', kind: 'text' },
  0xc62f: { label: 'Camera serial number', kind: 'text' },
  0xa430: { label: 'Camera owner name', kind: 'text' },
  0xa431: { label: 'Camera serial number', kind: 'text' },
  0xa435: { label: 'Lens serial number', kind: 'text' },
  0xa420: { label: 'Image unique ID', kind: 'text' },
  0x9286: { label: 'User comment', kind: 'bin' },
  0x9c9b: { label: 'Windows title', kind: 'bin' },
  0x9c9c: { label: 'Windows comment', kind: 'bin' },
  0x9c9d: { label: 'Windows author', kind: 'bin' },
  0x9c9e: { label: 'Windows keywords', kind: 'bin' },
  0x9c9f: { label: 'Windows subject', kind: 'bin' },
  0x83bb: { label: 'IPTC (captions, keywords, creator)', kind: 'bin' },
  0xc68b: { label: 'Original file name', kind: 'text' },
};

const DATE_TAGS: Record<number, string> = {
  0x0132: 'Date modified',
  0x9003: 'Date taken',
  0x9004: 'Date digitized',
  0x9010: 'Time zone',
  0x9011: 'Time zone',
  0x9012: 'Time zone',
  0x9290: 'Sub-second time',
  0x9291: 'Sub-second time',
  0x9292: 'Sub-second time',
};

const XMP_OPEN = '<x:xmpmeta';
const XMP_CLOSE = '</x:xmpmeta>';
const XMP_EMPTY = '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>';

class Cleaner {
  found = new Map<string, string>();
  removed = new Set<string>();
  kept = new Set<string>();
  warnings = new Set<string>();
  changed = 0;
  make = '';
  model = '';
  private visited = new Set<number>();
  private xmpDone = new Set<number>();

  constructor(
    public b: Uint8Array,
    private opts: Required<RawOptions>,
    private dry: boolean,
  ) {}

  // --- byte helpers -------------------------------------------------------
  u16(t: Tiff, abs: number) {
    const b = this.b;
    return t.le ? b[abs] | (b[abs + 1] << 8) : (b[abs] << 8) | b[abs + 1];
  }
  u32(t: Tiff, abs: number) {
    const b = this.b;
    return t.le
      ? (b[abs] | (b[abs + 1] << 8) | (b[abs + 2] << 16)) + ((b[abs + 3] << 24) >>> 0)
      : ((b[abs] << 24) >>> 0) + ((b[abs + 1] << 16) | (b[abs + 2] << 8) | b[abs + 3]);
  }
  fill(abs: number, len: number, value: number) {
    if (this.dry) return;
    const end = Math.min(this.b.length, abs + len);
    for (let i = abs; i < end; i++) {
      if (this.b[i] !== value) {
        this.b[i] = value;
        this.changed++;
      }
    }
  }
  writeAscii(abs: number, text: string) {
    if (this.dry) return;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (this.b[abs + i] !== c) {
        this.b[abs + i] = c;
        this.changed++;
      }
    }
  }
  note(label: string, value: string) {
    if (!this.found.has(label)) this.found.set(label, value.length > 120 ? `${value.slice(0, 117)}…` : value);
  }

  // --- TIFF structure -----------------------------------------------------
  tiffAt(base: number, end: number): Tiff | null {
    const b = this.b;
    if (base + 8 > end) return null;
    const le = b[base] === 0x49 && b[base + 1] === 0x49;
    if (!le && !(b[base] === 0x4d && b[base + 1] === 0x4d)) return null;
    const t: Tiff = { base, end, le };
    const magic = this.u16(t, base + 2);
    // 42 = TIFF, 0x4f52/0x5352 = Olympus ORF, 0x55 = Panasonic RW2
    if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) return null;
    return t;
  }

  entry(t: Tiff, at: number): Entry {
    const tag = this.u16(t, at);
    const type = this.u16(t, at + 2);
    const count = this.u32(t, at + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const data = size <= 4 ? at + 8 : t.base + this.u32(t, at + 8);
    const valid = type >= 1 && type <= 13 && size < 0x7fffffff && data >= 0 && data + size <= t.end;
    return { at, tag, type, count, data, size, valid };
  }

  text(e: Entry): string {
    if (!e.valid) return '';
    let s = '';
    for (let i = 0; i < e.size && i < 4096; i++) {
      const c = this.b[e.data + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  isBlank(e: Entry): boolean {
    for (let i = 0; i < e.size; i++) {
      const c = this.b[e.data + i];
      if (c !== 0 && c !== 0x20) return false;
    }
    return true;
  }

  /** The offsets stored in a LONG/IFD entry (SubIFDs, pointers). */
  offsets(t: Tiff, e: Entry): number[] {
    if (!e.valid || (e.type !== 4 && e.type !== 13)) return [];
    const out: number[] = [];
    for (let i = 0; i < Math.min(e.count, 16); i++) out.push(t.base + this.u32(t, e.data + i * 4));
    return out;
  }

  walk(t: Tiff, ifd: number, kind: Kind, depth = 0) {
    if (depth > 10 || ifd < t.base || ifd + 2 > t.end || this.visited.has(ifd)) return;
    this.visited.add(ifd);
    let n = this.u16(t, ifd);
    if (n === 0 || n > 2000) return;
    n = Math.min(n, Math.floor((t.end - ifd - 2) / 12));
    if (kind === 'gps') return this.clearGps(t, ifd, n);

    // Make/Model first, so the maker note can be read by brand
    for (let i = 0; i < n; i++) {
      const e = this.entry(t, ifd + 2 + i * 12);
      if (e.tag === 0x010f && !this.make) this.make = this.text(e);
      if (e.tag === 0x0110 && !this.model) this.model = this.text(e);
    }

    for (let i = 0; i < n; i++) {
      const e = this.entry(t, ifd + 2 + i * 12);
      if (kind === 'canon') this.canonTag(t, e);
      else if (kind === 'fuji') this.fujiTag(e);
      else if (kind === 'pana') this.panaTag(e);
      else this.mainTag(t, e, kind, depth);
    }

    // IFD0 -> IFD1 -> … chain (thumbnails and previews)
    if (kind === 'main') {
      const nextAt = ifd + 2 + n * 12;
      if (nextAt + 4 <= t.end) {
        const next = this.u32(t, nextAt);
        if (next) this.walk(t, t.base + next, 'main', depth + 1);
      }
    }
  }

  mainTag(t: Tiff, e: Entry, kind: Kind, depth: number) {
    if (!e.valid) return;
    switch (e.tag) {
      case 0x8769: // Exif IFD
        for (const o of this.offsets(t, e)) this.walk(t, o, 'exif', depth + 1);
        return;
      case 0x8825: // GPS IFD
        for (const o of this.offsets(t, e)) this.walk(t, o, 'gps', depth + 1);
        return;
      case 0x014a: // SubIFDs (full-size raw and previews in DNG, NEF, ARW…)
        for (const o of this.offsets(t, e)) this.walk(t, o, 'main', depth + 1);
        return;
      case 0x02bc: // XMP
        this.cleanXmpRange(e.data, e.size);
        return;
      case 0x927c: // Maker note
        if (kind === 'exif') this.makerNote(t, e, depth);
        return;
      case 0xc634: // DNGPrivateData / Sony SR2Private: maker data raw converters need
        this.kept.add('Camera private data block (raw converters use it for colour)');
        return;
      case 0xc68c: // DNG original raw file data
        this.warnings.add('This DNG embeds the original raw file. Its metadata could not be cleaned; convert without "Embed original raw file" to remove it.');
        return;
    }

    const date = DATE_TAGS[e.tag];
    if (date) {
      if (this.isBlank(e)) return;
      if (!this.opts.removeDates) {
        this.kept.add('Capture date and time (you chose to keep it)');
        return;
      }
      this.note(date, this.text(e));
      this.removed.add('Capture and edit dates');
      // Blank dates are written as spaces, which the EXIF standard defines as "unknown"
      this.fill(e.data, Math.max(0, e.size - 1), 0x20);
      return;
    }

    const blank = BLANK_TAGS[e.tag];
    if (!blank || this.isBlank(e)) return;
    this.note(blank.label, blank.kind === 'text' ? this.text(e) || '(set)' : `${e.size} bytes`);
    this.removed.add(blank.label);
    this.fill(e.data, e.size, 0);
  }

  makerNote(t: Tiff, e: Entry, depth: number) {
    const at = e.data;
    if (startsWith(this.b, at, 'Nikon')) {
      this.kept.add('Nikon maker note, with the serial number and shutter count: Nikon uses them to decode the colours, so removing them would ruin the photo');
      return;
    }
    if (startsWith(this.b, at, 'FUJIFILM')) {
      const fuji: Tiff = { base: at, end: Math.min(t.end, at + e.size), le: true };
      this.walk(fuji, at + this.u32(fuji, at + 8), 'fuji', depth + 1);
      return;
    }
    if (startsWith(this.b, at, 'Panasonic')) {
      this.walk(t, at + 12, 'pana', depth + 1);
      return;
    }
    if (/^canon/i.test(this.make)) {
      // Canon maker notes are a plain IFD with offsets relative to the TIFF header
      this.walk(t, at, 'canon', depth + 1);
      return;
    }
    this.kept.add(/^sony/i.test(this.make) ? 'Sony maker note (encrypted; raw converters need it, and it holds an internal serial number)' : 'Camera maker note (settings editors need to read the photo)');
  }

  canonTag(t: Tiff, e: Entry) {
    if (!e.valid) return;
    if (e.tag === 0x0009 && !this.isBlank(e)) {
      this.note('Camera owner name', this.text(e));
      this.removed.add('Camera owner name');
      this.fill(e.data, e.size, 0);
    } else if (e.tag === 0x000c && e.type === 4 && !this.isBlank(e)) {
      this.note('Camera serial number', String(this.u32(t, e.data)));
      this.removed.add('Camera serial number');
      this.fill(e.data, e.size, 0);
    } else if (e.tag === 0x0096 && !this.isBlank(e)) {
      this.note('Internal serial number', this.text(e));
      this.removed.add('Internal serial number');
      this.fill(e.data, e.size, 0);
    } else if (e.tag === 0x0028 && !this.isBlank(e)) {
      this.removed.add('Image unique ID');
      this.fill(e.data, e.size, 0);
    }
  }

  fujiTag(e: Entry) {
    if (e.valid && e.tag === 0x0010 && !this.isBlank(e)) {
      this.note('Internal serial number', this.text(e));
      this.removed.add('Internal serial number');
      this.fill(e.data, e.size, 0);
    }
  }

  panaTag(e: Entry) {
    if (e.valid && e.tag === 0x0025 && !this.isBlank(e)) {
      this.note('Internal serial number', this.text(e) || '(set)');
      this.removed.add('Internal serial number');
      this.fill(e.data, e.size, 0);
    }
  }

  clearGps(t: Tiff, ifd: number, n: number) {
    const entries: Entry[] = [];
    for (let i = 0; i < n; i++) entries.push(this.entry(t, ifd + 2 + i * 12));
    const useful = entries.filter((e) => e.tag !== 0x0000 && e.valid && !this.isBlank(e));
    if (!useful.length) return;
    const where = this.gpsText(t, entries);
    this.note('GPS location', where ?? `${useful.length} GPS fields`);
    this.removed.add('GPS location');
    // Zero every value stored outside the directory, then empty the directory.
    for (const e of entries) if (e.valid && e.size > 4) this.fill(e.data, e.size, 0);
    this.fill(ifd, 2 + n * 12 + 4, 0);
  }

  gpsText(t: Tiff, entries: Entry[]): string | undefined {
    const coord = (tag: number) => {
      const e = entries.find((x) => x.tag === tag);
      if (!e || !e.valid || e.type !== 5 || e.count < 3) return undefined;
      const r = (i: number) => {
        const den = this.u32(t, e.data + i * 8 + 4);
        return den ? this.u32(t, e.data + i * 8) / den : 0;
      };
      return r(0) + r(1) / 60 + r(2) / 3600;
    };
    const ref = (tag: number) => {
      const e = entries.find((x) => x.tag === tag);
      return e ? String.fromCharCode(this.b[e.data]) : '';
    };
    const lat = coord(2);
    const lon = coord(4);
    if (lat === undefined || lon === undefined || (lat === 0 && lon === 0)) return undefined;
    return `${(ref(1) === 'S' ? -lat : lat).toFixed(5)}, ${(ref(3) === 'W' ? -lon : lon).toFixed(5)}`;
  }

  // --- XMP ----------------------------------------------------------------
  /** Replace an XMP packet inside [start, start+len) with an empty one of the same size. */
  cleanXmpRange(start: number, len: number) {
    const open = indexOf(this.b, XMP_OPEN, start, start + len);
    if (open < 0) {
      // Not a recognisable packet: blank it
      if (!this.isBlankRange(start, len)) {
        this.removed.add('XMP (edit history, ratings, keywords, AI labels)');
        this.fill(start, len, 0x20);
      }
      return;
    }
    this.cleanXmpAt(open, start + len);
  }

  cleanXmpAt(open: number, limit: number) {
    if (this.xmpDone.has(open)) return;
    const close = indexOf(this.b, XMP_CLOSE, open, limit);
    if (close < 0) return;
    this.xmpDone.add(open);
    const end = close + XMP_CLOSE.length;
    const body = ascii(this.b, open, end - open);
    if (!/rdf:(RDF|Description)/.test(body)) return; // already empty
    const label = 'XMP (edit history, ratings, keywords, AI labels)';
    if (/GPS(Latitude|Longitude)/i.test(body)) this.removed.add('GPS location');
    if (/c2pa|contentcredentials|DigitalSourceType/i.test(body)) this.note('AI / provenance labels', 'found in XMP');
    this.note('XMP', `${end - open} bytes`);
    this.removed.add(label);
    if (end - open >= XMP_EMPTY.length) {
      this.writeAscii(open, XMP_EMPTY);
      this.fill(open + XMP_EMPTY.length, end - open - XMP_EMPTY.length, 0x20);
    } else {
      this.fill(open, end - open, 0x20);
    }
  }

  isBlankRange(start: number, len: number) {
    for (let i = start; i < start + len && i < this.b.length; i++) if (this.b[i] !== 0 && this.b[i] !== 0x20) return false;
    return true;
  }

  // --- whole-file passes --------------------------------------------------
  /** Embedded JPEG previews (and RAF's main JPEG) carry their own EXIF. */
  scanEmbeddedExif() {
    const b = this.b;
    let i = 0;
    while ((i = indexOf(b, 'Exif\0\0', i, b.length)) >= 0) {
      if (i >= 4 && b[i - 4] === 0xff && b[i - 3] === 0xe1) {
        const len = (b[i - 2] << 8) | b[i - 1];
        const t = this.tiffAt(i + 6, Math.min(b.length, i - 2 + len));
        if (t) this.walk(t, t.base + this.u32(t, t.base + 4), 'main');
      }
      i += 6;
    }
  }

  scanXmp() {
    const b = this.b;
    let i = 0;
    while ((i = indexOf(b, XMP_OPEN, i, b.length)) >= 0) {
      this.cleanXmpAt(i, Math.min(b.length, i + 8 * 1024 * 1024));
      i += XMP_OPEN.length;
    }
  }

  /** Canon CR3 keeps its EXIF in four small TIFFs: CMT1 (IFD0), CMT2 (Exif), CMT3 (maker note), CMT4 (GPS). */
  cr3() {
    const b = this.b;
    const limit = Math.min(b.length, 16 * 1024 * 1024);
    const kinds: Record<string, Kind> = { CMT1: 'main', CMT2: 'exif', CMT3: 'canon', CMT4: 'gps' };
    for (const [box, kind] of Object.entries(kinds)) {
      let i = 0;
      while ((i = indexOf(b, box, i, limit)) >= 0) {
        if (i >= 4) {
          const size = ((b[i - 4] << 24) >>> 0) + ((b[i - 3] << 16) | (b[i - 2] << 8) | b[i - 1]);
          const t = size > 16 ? this.tiffAt(i + 4, Math.min(b.length, i - 4 + size)) : null;
          if (t) {
            if (kind === 'canon') this.make ||= 'Canon';
            this.walk(t, t.base + this.u32(t, t.base + 4), kind);
          }
        }
        i += 4;
      }
    }
    if (!this.make) this.make = 'Canon';
  }
}

function indexOf(b: Uint8Array, text: string, from: number, to: number): number {
  const first = text.charCodeAt(0);
  const last = to - text.length;
  let i = from;
  while (i <= last) {
    i = b.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let ok = true;
    for (let k = 1; k < text.length; k++) {
      if (b[i + k] !== text.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
    i++;
  }
  return -1;
}

type Container = 'cr3' | 'raf' | 'tiff';

function container(b: Uint8Array): Container | null {
  if (startsWith(b, 4, 'ftyp') && startsWith(b, 8, 'crx ')) return 'cr3';
  if (startsWith(b, 0, 'FUJIFILMCCD-RAW')) return 'raf';
  const le = b[0] === 0x49 && b[1] === 0x49;
  const be = b[0] === 0x4d && b[1] === 0x4d;
  if (!le && !be) return null;
  const magic = le ? b[2] | (b[3] << 8) : (b[2] << 8) | b[3];
  return [42, 0x4f52, 0x5352, 0x55].includes(magic) ? 'tiff' : null;
}

function formatName(kind: Container, b: Uint8Array, make: string, ext: string): string {
  if (kind === 'cr3') return 'Canon CR3';
  if (kind === 'raf') return 'Fujifilm RAF';
  if (startsWith(b, 8, 'CR')) return 'Canon CR2';
  if (b[2] === 0x55) return 'Panasonic RW2';
  if (startsWith(b, 2, 'RO') || startsWith(b, 2, 'RS') || startsWith(b, 2, 'OR')) return 'Olympus ORF';
  const e = ext.toUpperCase();
  if (e === 'DNG') return 'Adobe DNG';
  if (/^nikon/i.test(make)) return `Nikon ${e === 'NRW' ? 'NRW' : 'NEF'}`;
  if (/^sony/i.test(make)) return `Sony ${e || 'ARW'}`;
  if (/^(pentax|ricoh)/i.test(make)) return `Pentax ${e || 'PEF'}`;
  if (/^samsung/i.test(make)) return 'Samsung SRW';
  return e ? `${make ? `${make.split(' ')[0]} ` : ''}${e}` : 'TIFF-based RAW';
}

function run(b: Uint8Array, opts: Required<RawOptions>, dry: boolean, ext: string) {
  const kind = container(b);
  if (!kind) throw new UnsupportedRawError('This is not a supported RAW file. Use CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF or PEF.');
  const c = new Cleaner(b, opts, dry);
  if (kind === 'tiff') {
    const t = c.tiffAt(0, b.length)!;
    c.walk(t, c.u32(t, 4), 'main');
  } else if (kind === 'cr3') {
    c.cr3();
  } else {
    c.make = 'FUJIFILM';
  }
  c.scanEmbeddedExif();
  c.scanXmp();
  return { c, format: formatName(kind, b, c.make, ext) };
}

/** Read what a RAW file reveals, without changing it. */
export function inspectRaw(input: Uint8Array, fileName = ''): RawReport {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const { c, format } = run(input, { removeDates: true }, true, ext);
  return {
    format,
    make: c.make || undefined,
    model: c.model || undefined,
    found: [...c.found],
    removed: [],
    kept: [...c.kept],
    warnings: [...c.warnings],
    changedBytes: 0,
  };
}

/** Remove identifying metadata from a RAW file. The input is not modified. */
export function cleanRaw(input: Uint8Array, fileName = '', options: RawOptions = {}): RawResult {
  const opts: Required<RawOptions> = { removeDates: options.removeDates ?? true };
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const output = input.slice();
  const { c, format } = run(output, opts, false, ext);

  // Check the result: read it again and make sure nothing identifying is left.
  const after = run(output.slice(), opts, true, ext).c;
  const leftover = [...after.found.keys()].filter((k) => opts.removeDates || !Object.values(DATE_TAGS).includes(k));
  const warnings = [...c.warnings];
  if (leftover.length) warnings.push(`Could not fully remove: ${leftover.join(', ')}`);
  if (output.length !== input.length) warnings.push('File size changed unexpectedly.');

  c.kept.add('Camera and lens model, exposure settings and white balance (raw editors need them)');
  return {
    output,
    report: {
      format,
      make: c.make || undefined,
      model: c.model || undefined,
      found: [...c.found],
      removed: [...c.removed],
      kept: [...c.kept],
      warnings,
      changedBytes: c.changed,
    },
  };
}
