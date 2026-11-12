import { ascii, concat, startsWith, u32le, utf8, writeU32le } from './bytes';
import { editExif, newDateExif } from './exifedit';
import { describeTiff, orientationOnlyTiff, readTiff } from './tiff';
import { exifPlan, removeWhenEditing, type FormatResult } from './index';
import type { EditReport, MetaBlock, Options } from './types';

const KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  writeU32le(out, 4, data.length);
  out.set(data, 8);
  return out;
}

export async function runWebp(b: Uint8Array, opts: Options): Promise<FormatResult> {
  if (!startsWith(b, 0, 'RIFF') || !startsWith(b, 8, 'WEBP')) throw new Error('Not a WebP file');
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const mode = opts.mode ?? 'all';
  let edit: EditReport | undefined;
  let keptExif = false;
  let keptXmp = false;
  let exifRemoved = false;
  const blocks: MetaBlock[] = [];
  const keep: Uint8Array[] = [];
  let orientation = 1;
  let hasGps = false;
  let tiff: Uint8Array | undefined;
  let xmp: string | undefined;
  let vp8x: Uint8Array | undefined;
  let keptIcc = false;

  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const type = ascii(b, pos, 4);
    const len = u32le(b, pos + 4);
    const end = Math.min(riffEnd, pos + 8 + len + (len & 1));
    const whole = b.subarray(pos, end);
    const data = b.subarray(pos + 8, Math.min(riffEnd, pos + 8 + len));
    const add = (block: Omit<MetaBlock, 'size' | 'payload' | 'removed'>, text?: string) => {
      const removed = mode === 'all' || removeWhenEditing(mode, block.category, block.label, text);
      if (!removed) keep.push(whole);
      blocks.push({ ...block, removed, size: whole.length, payload: data });
      return !removed;
    };

    if (KEEP.has(type)) {
      const copy = whole.slice();
      if (type === 'VP8X') vp8x = copy;
      keep.push(copy);
    } else if (type === 'ICCP') {
      keptIcc = mode !== 'all' || opts.keepColorProfile;
      if (keptIcc) keep.push(whole);
      blocks.push({ category: 'icc', label: 'Colour profile (ICC)', size: whole.length, payload: data, removed: !keptIcc, notes: keptIcc ? ['Kept so colours stay correct'] : [] });
    } else if (type === 'EXIF') {
      const t = startsWith(data, 0, 'Exif\0\0') ? data.subarray(6) : data;
      const sum = readTiff(t);
      tiff = t;
      orientation = sum.orientation;
      hasGps ||= sum.hasGps;
      const plan = exifPlan(mode, t);
      if (plan === 'remove') {
        exifRemoved = true;
        blocks.push({ category: 'exif', label: 'EXIF', size: whole.length, payload: data, removed: true, notes: describeTiff(sum) });
      } else if (plan === 'keep') {
        keep.push(whole);
        keptExif = true;
        blocks.push({ category: 'exif', label: 'EXIF', size: whole.length, payload: data, removed: false, notes: describeTiff(sum) });
      } else {
        const r = editExif(t.slice(), opts, orientation, true);
        edit = { ...edit, ...r.report };
        keep.push(r.report.error ? whole : riffChunk('EXIF', r.tiff));
        keptExif = true;
        blocks.push({ category: 'exif', label: 'EXIF', size: whole.length, payload: data, removed: false, notes: [r.note, ...describeTiff(sum).filter((n) => !(r.report.gpsRemoved && n.includes('GPS')))].filter(Boolean) });
      }
    } else if (type === 'XMP ') {
      xmp = utf8(data);
      keptXmp = add({ category: 'xmp', label: 'XMP', notes: [] }, xmp);
    } else if (/c2pa/i.test(type)) {
      add({ category: 'c2pa', label: 'C2PA Content Credentials', notes: ['Provenance manifest (who/what created or edited the image)'] });
    } else {
      add({ category: 'other', label: `Chunk “${type.trim()}”`, notes: [] });
    }
    pos = end;
  }

  if (exifRemoved && opts.keepOrientation && orientation !== 1 && vp8x) {
    keep.push(riffChunk('EXIF', orientationOnlyTiff(orientation)));
    keptExif = true;
    blocks.find((x) => x.category === 'exif')?.notes.push('Orientation kept');
  }

  if (mode === 'date' && !tiff) {
    // Simple WebP files (no VP8X header) have nowhere to store EXIF.
    const r = vp8x ? newDateExif(opts) : { tiff: null, report: { error: 'This simple WebP file cannot hold a date' } };
    edit = r.report;
    if (r.tiff) {
      keep.push(riffChunk('EXIF', r.tiff));
      keptExif = true;
    }
  }
  if (mode === 'gps' && !edit) edit = { gpsRemoved: false };

  if (vp8x) {
    let flags = vp8x[8] & ~(FLAG_ICC | FLAG_EXIF | FLAG_XMP);
    if (keptIcc) flags |= FLAG_ICC;
    if (keptExif) flags |= FLAG_EXIF;
    if (keptXmp) flags |= FLAG_XMP;
    vp8x[8] = flags;
  }

  const body = concat(keep);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46]);
  writeU32le(header, 4, body.length + 4);
  header.set([0x57, 0x45, 0x42, 0x50], 8);
  return { blocks, output: concat([header, body]), orientation, hasGps, tiff, xmp, blanked: false, edit };
}
