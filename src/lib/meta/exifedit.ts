// In-place EXIF edits that keep the TIFF the same length, so they work in every
// container (JPEG, PNG, WebP and HEIC/AVIF, where offsets must not move).

import type { EditReport, Options } from './types';

const TAG_GPS = 0x8825;
const TAG_EXIF = 0x8769;
const TAG_DATETIME = 0x0132;
const TAG_ORIGINAL = 0x9003;
const TAG_DIGITIZED = 0x9004;
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

interface Tiff {
  t: Uint8Array;
  u16: (o: number) => number;
  u32: (o: number) => number;
  w16: (o: number, v: number) => void;
  w32: (o: number, v: number) => void;
}

function open(t: Uint8Array): Tiff | null {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  return {
    t,
    u16: (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]),
    u32: (o) =>
      le
        ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + ((t[o + 3] << 24) >>> 0)
        : ((t[o] << 24) >>> 0) + ((t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]),
    w16: (o, v) => {
      t[o + (le ? 0 : 1)] = v & 0xff;
      t[o + (le ? 1 : 0)] = (v >> 8) & 0xff;
    },
    w32: (o, v) => {
      for (let i = 0; i < 4; i++) t[o + (le ? i : 3 - i)] = (v >>> (i * 8)) & 0xff;
    },
  };
}

/** Entries of the IFD at `ifd`: [tag, entryOffset]. */
function entries(x: Tiff, ifd: number): Array<[number, number]> {
  if (ifd < 8 || ifd + 2 > x.t.length) return [];
  const n = x.u16(ifd);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= x.t.length; i++) out.push([x.u16(ifd + 2 + i * 12), ifd + 2 + i * 12]);
  return out;
}

/**
 * Removes the GPS IFD: its entries and values are zeroed and the pointer to it is
 * deleted from IFD0 (later entries shift up; the freed 12 bytes become padding).
 */
export function scrubGps(t: Uint8Array): boolean {
  const x = open(t);
  if (!x) return false;
  const ifd0 = x.u32(4);
  const ptr = entries(x, ifd0).find(([tag]) => tag === TAG_GPS);
  if (!ptr) return false;
  const gps = x.u32(ptr[1] + 8);
  for (const [, e] of entries(x, gps)) {
    const size = (TYPE_SIZE[x.u16(e + 2)] ?? 1) * x.u32(e + 4);
    if (size > 4) {
      const off = x.u32(e + 8);
      if (off + size <= t.length) t.fill(0, off, off + size);
    }
  }
  if (gps >= 8 && gps + 2 <= t.length) t.fill(0, gps, Math.min(t.length, gps + 2 + x.u16(gps) * 12 + 4));

  const n = x.u16(ifd0);
  const end = ifd0 + 2 + n * 12 + 4; // entries + next-IFD offset
  t.copyWithin(ptr[1], ptr[1] + 12, end);
  t.fill(0, end - 12, end);
  x.w16(ifd0, n - 1);
  return true;
}

export type DateEdit = { kind: 'set'; value: string } | { kind: 'shift'; seconds: number };

const DATE_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

export function parseExifDate(s: string): Date | null {
  const m = s.match(DATE_RE);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return isNaN(+d) ? null : d;
}

export function formatExifDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

interface DateField {
  tag: number;
  at: number; // byte offset of the 20-byte value
}

function dateFields(x: Tiff): DateField[] {
  const out: DateField[] = [];
  const pick = (ifd: number, tags: number[]) => {
    for (const [tag, e] of entries(x, ifd)) {
      if (!tags.includes(tag) || x.u16(e + 2) !== 2 || x.u32(e + 4) < 20) continue;
      const at = x.u32(e + 8);
      if (at + 20 <= x.t.length) out.push({ tag, at });
    }
  };
  const ifd0 = x.u32(4);
  pick(ifd0, [TAG_DATETIME]);
  const exif = entries(x, ifd0).find(([tag]) => tag === TAG_EXIF);
  if (exif) pick(x.u32(exif[1] + 8), [TAG_ORIGINAL, TAG_DIGITIZED]);
  return out;
}

const ascii = (t: Uint8Array, o: number, n: number) => String.fromCharCode(...t.subarray(o, o + n));

/** The photo's "date taken" (DateTimeOriginal, falling back to the other dates). */
export function readDateTaken(t: Uint8Array): string | undefined {
  const x = open(t);
  if (!x) return undefined;
  const f = dateFields(x);
  const best = f.find((d) => d.tag === TAG_ORIGINAL) ?? f.find((d) => d.tag === TAG_DIGITIZED) ?? f[0];
  return best ? ascii(t, best.at, 19) : undefined;
}

export interface DateResult {
  before?: string;
  after?: string;
  /** false when the EXIF has no date fields to edit in place */
  edited: boolean;
}

/** Rewrites all three EXIF dates in place. */
export function editDates(t: Uint8Array, edit: DateEdit): DateResult {
  const x = open(t);
  if (!x) return { edited: false };
  const fields = dateFields(x);
  const before = readDateTaken(t);
  if (!fields.length) return { before, edited: false };
  let after: string | undefined;
  for (const f of fields) {
    let value: string | undefined;
    if (edit.kind === 'set') value = edit.value;
    else {
      const d = parseExifDate(ascii(t, f.at, 19));
      if (d) value = formatExifDate(new Date(+d + edit.seconds * 1000));
    }
    if (!value) continue;
    for (let i = 0; i < 19; i++) t[f.at + i] = value.charCodeAt(i);
    t[f.at + 19] = 0;
    if (f.tag === TAG_ORIGINAL || !after) after = value;
  }
  return { before, after, edited: !!after };
}

/** A new big-endian TIFF with the three dates (and orientation, if not 1). */
export function buildDateTiff(date: string, orientation = 1): Uint8Array {
  const tags0: Array<[number, number, number, number | 'date' | 'exif']> = [];
  if (orientation !== 1) tags0.push([0x0112, 3, 1, orientation]);
  tags0.push([TAG_DATETIME, 2, 20, 'date'], [TAG_EXIF, 4, 1, 'exif']);
  const ifd0Size = 2 + tags0.length * 12 + 4;
  const date0At = 8 + ifd0Size;
  const exifAt = date0At + 20;
  const exifSize = 2 + 2 * 12 + 4;
  const d1 = exifAt + exifSize;
  const d2 = d1 + 20;
  const t = new Uint8Array(d2 + 20);
  t.set([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]); // big-endian header, IFD0 at 8
  const x = open(t)!;
  x.w16(8, tags0.length);
  tags0.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12;
    x.w16(e, tag);
    x.w16(e + 2, type);
    x.w32(e + 4, count);
    if (value === 'date') x.w32(e + 8, date0At);
    else if (value === 'exif') x.w32(e + 8, exifAt);
    else x.w16(e + 8, value);
  });
  x.w16(exifAt, 2);
  [[TAG_ORIGINAL, d1], [TAG_DIGITIZED, d2]].forEach(([tag, at], i) => {
    const e = exifAt + 2 + i * 12;
    x.w16(e, tag);
    x.w16(e + 2, 2);
    x.w32(e + 4, 20);
    x.w32(e + 8, at);
  });
  for (const at of [date0At, d1, d2]) for (let i = 0; i < 19; i++) t[at + i] = date.charCodeAt(i);
  return t;
}

/**
 * Applies the "gps" or "date" edit to an EXIF TIFF (edited in place when
 * possible). `canGrow` is false for HEIC/AVIF, where the EXIF can't be replaced
 * by a bigger one.
 */
export function editExif(t: Uint8Array, opts: Options, orientation: number, canGrow: boolean): { tiff: Uint8Array; report: EditReport; note: string } {
  if (opts.mode === 'gps') {
    const gpsRemoved = scrubGps(t);
    return { tiff: t, report: { gpsRemoved }, note: gpsRemoved ? 'GPS location removed, camera and dates kept' : 'No GPS location in EXIF' };
  }
  const edit = opts.date!;
  const r = editDates(t, edit);
  if (r.edited) return { tiff: t, report: { dateBefore: r.before, dateAfter: r.after }, note: `Date changed to ${r.after}` };
  if (edit.kind === 'set' && canGrow) {
    return {
      tiff: buildDateTiff(edit.value, orientation),
      report: { dateAfter: edit.value },
      note: 'Had no date fields: new EXIF with the date was written',
    };
  }
  return { tiff: t, report: { error: edit.kind === 'shift' ? 'No original date to shift' : 'No date fields to edit in this file' }, note: '' };
}

/** For files with no EXIF at all, in "date" mode. */
export function newDateExif(opts: Options, orientation = 1): { tiff: Uint8Array | null; report: EditReport } {
  if (opts.date?.kind !== 'set') return { tiff: null, report: { error: 'No original date to shift' } };
  return { tiff: buildDateTiff(opts.date.value, orientation), report: { dateAfter: opts.date.value } };
}
