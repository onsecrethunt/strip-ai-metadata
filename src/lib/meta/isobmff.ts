// HEIC / HEIF / AVIF. Metadata lives in "items" referenced by byte offsets
// (iloc). Cutting bytes out would break every offset, so instead each metadata
// item is overwritten with zeros and marked as a hidden, unknown item type that
// every decoder ignores. The picture data is untouched.
import { ascii, startsWith, u16be, u32be, utf8 } from './bytes';
import { editExif } from './exifedit';
import { describeTiff, readTiff } from './tiff';
import { exifPlan, removeWhenEditing, type FormatResult } from './index';
import type { EditReport, ImageFormat, MetaBlock, Options } from './types';

const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

interface Box {
  type: string;
  start: number;
  header: number;
  end: number;
}

function readBoxes(b: Uint8Array, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1) {
      size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12);
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header || p + size > to) break;
    boxes.push({ type, start: p, header, end: p + size });
    p += size;
  }
  return boxes;
}

function readUint(b: Uint8Array, o: number, size: number): number {
  if (size === 0) return 0;
  if (size === 2) return u16be(b, o);
  if (size === 4) return u32be(b, o);
  return u32be(b, o) * 2 ** 32 + u32be(b, o + 4);
}

const hex = (b: Uint8Array, o: number, n: number) =>
  Array.from(b.subarray(o, o + n), (x) => x.toString(16).padStart(2, '0')).join('');

export function isobmffFormat(b: Uint8Array): ImageFormat | null {
  if (!startsWith(b, 4, 'ftyp')) return null;
  const size = u32be(b, 0);
  const brands: string[] = [ascii(b, 8, 4)];
  for (let p = 16; p + 4 <= Math.min(size, b.length); p += 4) brands.push(ascii(b, p, 4));
  if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
  if (brands.some((x) => ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'mif2'].includes(x))) return 'heif';
  return null;
}

export async function runIsobmff(input: Uint8Array, opts: Options): Promise<FormatResult> {
  const mode = opts.mode ?? 'all';
  let edit: EditReport | undefined;
  const b = input.slice();
  const blocks: MetaBlock[] = [];
  let hasGps = false;
  let tiff: Uint8Array | undefined;
  let xmp: string | undefined;

  const blank = (from: number, to: number) => b.fill(0, from, to);
  const top = readBoxes(b, 0, b.length);

  for (const box of top) {
    if (box.type === 'uuid') {
      const id = hex(b, box.start + box.header, 16);
      const payload = input.subarray(box.start + box.header + 16, box.end);
      if (id === C2PA_UUID || id === XMP_UUID) {
        const isC2pa = id === C2PA_UUID;
        if (!isC2pa) xmp = utf8(payload);
        const removed = mode === 'all' || removeWhenEditing(mode, isC2pa ? 'c2pa' : 'xmp', 'XMP', xmp);
        blocks.push({
          category: isC2pa ? 'c2pa' : 'xmp',
          label: isC2pa ? 'C2PA Content Credentials' : 'XMP',
          size: box.end - box.start,
          removed,
          notes: isC2pa ? ['Provenance manifest (who/what created or edited the image)'] : [],
          payload,
        });
        if (removed) {
          // turn it into a 'free' box full of zeros
          b.set([0x66, 0x72, 0x65, 0x65], box.start + 4);
          blank(box.start + box.header, box.end);
        }
      }
    }
  }

  const meta = top.find((x) => x.type === 'meta');
  if (meta) {
    const children = readBoxes(b, meta.start + meta.header + 4, meta.end);
    const iinf = children.find((x) => x.type === 'iinf');
    const iloc = children.find((x) => x.type === 'iloc');
    const idat = children.find((x) => x.type === 'idat');

    interface Item { id: number; type: string; contentType: string; typeAt: number; flagsAt: number }
    const items: Item[] = [];
    if (iinf) {
      const v = b[iinf.start + iinf.header];
      const countSize = v === 0 ? 2 : 4;
      const first = iinf.start + iinf.header + 4 + countSize;
      for (const infe of readBoxes(b, first, iinf.end)) {
        if (infe.type !== 'infe') continue;
        const o = infe.start + infe.header;
        const ver = b[o];
        if (ver < 2) continue;
        let p = o + 4;
        const id = ver === 2 ? u16be(b, p) : u32be(b, p);
        p += ver === 2 ? 2 : 4;
        p += 2; // protection index
        const typeAt = p;
        const type = ascii(b, p, 4);
        p += 4;
        p = b.indexOf(0, p) + 1; // item name
        let contentType = '';
        if (type === 'mime' && p > 0) {
          const e = b.indexOf(0, p);
          contentType = ascii(b, p, (e < 0 ? infe.end : e) - p);
        }
        items.push({ id, type, contentType, typeAt, flagsAt: o + 3 });
      }
    }

    const extents = new Map<number, Array<[number, number]>>();
    if (iloc) {
      const o = iloc.start + iloc.header;
      const ver = b[o];
      let p = o + 4;
      const offsetSize = b[p] >> 4;
      const lengthSize = b[p] & 15;
      const baseSize = b[p + 1] >> 4;
      const indexSize = ver === 1 || ver === 2 ? b[p + 1] & 15 : 0;
      p += 2;
      const count = ver < 2 ? u16be(b, p) : u32be(b, p);
      p += ver < 2 ? 2 : 4;
      for (let i = 0; i < count && p < iloc.end; i++) {
        const id = ver < 2 ? u16be(b, p) : u32be(b, p);
        p += ver < 2 ? 2 : 4;
        let method = 0;
        if (ver === 1 || ver === 2) {
          method = u16be(b, p) & 15;
          p += 2;
        }
        p += 2; // data reference index
        const base = readUint(b, p, baseSize);
        p += baseSize;
        const n = u16be(b, p);
        p += 2;
        const list: Array<[number, number]> = [];
        for (let e = 0; e < n; e++) {
          p += indexSize;
          const off = readUint(b, p, offsetSize);
          p += offsetSize;
          const len = readUint(b, p, lengthSize);
          p += lengthSize;
          const origin = method === 1 && idat ? idat.start + idat.header : 0;
          if (method <= 1 && len > 0) list.push([origin + base + off, origin + base + off + len]);
        }
        extents.set(id, list);
      }
    }

    for (const item of items) {
      const isExif = item.type === 'Exif';
      const isXmp = item.type === 'mime' && /rdf\+xml|xmp/i.test(item.contentType);
      const isC2pa = item.type === 'mime' && /c2pa/i.test(item.contentType);
      if (!isExif && !isXmp && !isC2pa) continue;
      const ranges = (extents.get(item.id) ?? []).filter(([s, e]) => e <= b.length);
      const payload = ranges.length ? input.subarray(ranges[0][0], ranges[0][1]) : new Uint8Array();
      const size = ranges.reduce((a, [s, e]) => a + e - s, 0);
      const notes: string[] = [];
      if (isExif && payload.length > 4) {
        const t = payload.subarray(4 + u32be(payload, 0));
        const sum = readTiff(t);
        tiff ??= t;
        hasGps ||= sum.hasGps;
        notes.push(...describeTiff(sum));
      }
      if (isXmp) xmp = utf8(payload);
      const category = isExif ? 'exif' : isXmp ? 'xmp' : 'c2pa';
      const label = isExif ? 'EXIF' : isXmp ? 'XMP' : 'C2PA Content Credentials';
      const plan = isExif ? exifPlan(mode, payload) : undefined;
      const removed = isExif ? plan === 'remove' : mode === 'all' || removeWhenEditing(mode, category, label, xmp);

      if (plan === 'edit') {
        // Edit the EXIF where it sits (single-extent items only; offsets can't move).
        if (ranges.length === 1 && payload.length > 4) {
          const [s] = ranges[0];
          const r = editExif(b.subarray(s + 4 + u32be(payload, 0), ranges[0][1]), opts, 1, false);
          edit = { ...edit, ...r.report };
          if (r.report.gpsRemoved) notes.splice(0, notes.length, ...notes.filter((n) => !n.includes('GPS')));
          if (r.note) notes.unshift(r.note);
        } else edit = { error: 'This file stores EXIF in a way we cannot edit' };
      }
      blocks.push({ category, label, size, removed, notes, payload });
      if (removed) {
        for (const [s, e] of ranges) blank(s, e);
        b.set([0x66, 0x72, 0x65, 0x65], item.typeAt); // 'free' — unknown type, ignored by decoders
        b[item.flagsAt] |= 1; // hidden item
      }
    }
  }

  // Orientation in HEIF/AVIF lives in the irot/imir properties, not EXIF,
  // so it survives automatically.
  if (mode === 'date' && !edit) edit = { error: 'This file has no date fields to edit' };
  if (mode === 'gps' && !edit) edit = { gpsRemoved: false };
  return { blocks, output: b, orientation: 1, hasGps, tiff, xmp, blanked: blocks.some((x) => x.removed), edit };
}
