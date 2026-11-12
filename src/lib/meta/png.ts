import { ascii, concat, crc32, inflate, latin1, u32be, utf8, writeU32be } from './bytes';
import { editExif, newDateExif } from './exifedit';
import { describeTiff, orientationOnlyTiff, readTiff } from './tiff';
import { exifPlan, removeWhenEditing, type FormatResult } from './index';
import type { EditReport, MetaBlock, Options } from './types';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Ancillary chunks that affect how the image looks (or animates) are kept.
const KEEP = new Set([
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'pHYs', 'bKGD', 'hIST', 'sPLT',
  'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32be(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32be(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function decodeText(type: string, d: Uint8Array): Promise<{ key: string; text: string }> {
  const nul = d.indexOf(0);
  const key = latin1(d.subarray(0, nul < 0 ? d.length : nul));
  if (nul < 0) return { key, text: '' };
  try {
    if (type === 'tEXt') return { key, text: latin1(d.subarray(nul + 1)) };
    if (type === 'zTXt') return { key, text: latin1(await inflate(d.subarray(nul + 2))) };
    // iTXt: keyword\0 flag method lang\0 translated\0 text
    const compressed = d[nul + 1] === 1;
    let p = nul + 3;
    p = d.indexOf(0, p) + 1; // language tag
    p = d.indexOf(0, p) + 1; // translated keyword
    const body = d.subarray(p);
    return { key, text: utf8(compressed ? await inflate(body) : body) };
  } catch {
    return { key, text: '' };
  }
}

export async function runPng(b: Uint8Array, opts: Options): Promise<FormatResult> {
  if (!SIGNATURE.every((v, i) => b[i] === v)) throw new Error('Not a PNG file');
  const mode = opts.mode ?? 'all';
  let edit: EditReport | undefined;
  const blocks: MetaBlock[] = [];
  const keep: Uint8Array[] = [b.subarray(0, 8)];
  let orientation = 1;
  let hasGps = false;
  let tiff: Uint8Array | undefined;
  let xmp: string | undefined;
  let afterIhdr = 1;
  let exifRemoved = false;

  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    const end = pos + 12 + len;
    if (end > b.length) throw new Error('Truncated PNG');
    const whole = b.subarray(pos, end);
    const data = b.subarray(pos + 8, pos + 8 + len);
    // In the edit modes most chunks stay; `removed` is decided by the shared policy.
    const add = (block: Omit<MetaBlock, 'size' | 'payload' | 'removed'>, text?: string) => {
      const removed = mode === 'all' || removeWhenEditing(mode, block.category, block.label, text);
      if (!removed) keep.push(whole);
      blocks.push({ ...block, removed, size: whole.length, payload: data });
    };
    const critical = type.charCodeAt(0) < 0x61; // uppercase first letter

    if (critical || KEEP.has(type)) {
      keep.push(whole);
      if (type === 'IHDR') afterIhdr = keep.length;
    } else if (type === 'iCCP') {
      const kept = mode !== 'all' || opts.keepColorProfile;
      if (kept) keep.push(whole);
      blocks.push({ category: 'icc', label: 'Colour profile (ICC)', size: whole.length, payload: data, removed: !kept, notes: kept ? ['Kept so colours stay correct'] : [] });
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const { key, text } = await decodeText(type, data);
      if (key === 'XML:com.adobe.xmp') {
        xmp = text;
        add({ category: 'xmp', label: 'XMP', notes: [] }, text);
      } else {
        add({ category: 'text', label: `Text: “${key}”`, notes: text ? [text.slice(0, 200)] : [], key, text }, `${key}\n${text}`);
      }
    } else if (type === 'eXIf') {
      const sum = readTiff(data);
      tiff = data;
      orientation = sum.orientation;
      hasGps ||= sum.hasGps;
      const plan = exifPlan(mode, data);
      if (plan === 'remove') {
        exifRemoved = true;
        blocks.push({ category: 'exif', label: 'EXIF', size: whole.length, payload: data, removed: true, notes: describeTiff(sum) });
      } else if (plan === 'keep') {
        keep.push(whole);
        blocks.push({ category: 'exif', label: 'EXIF', size: whole.length, payload: data, removed: false, notes: describeTiff(sum) });
      } else {
        const r = editExif(data.slice(), opts, orientation, true);
        edit = { ...edit, ...r.report };
        keep.push(r.report.error ? whole : chunk('eXIf', r.tiff));
        blocks.push({ category: 'exif', label: 'EXIF', size: whole.length, payload: data, removed: false, notes: [r.note, ...describeTiff(sum).filter((n) => !(r.report.gpsRemoved && n.includes('GPS')))].filter(Boolean) });
      }
    } else if (type === 'caBX') {
      add({ category: 'c2pa', label: 'C2PA Content Credentials', notes: ['Provenance manifest (who/what created or edited the image)'] });
    } else if (type === 'tIME') {
      add({ category: 'other', label: 'Last-modified time', notes: [] });
    } else {
      add({ category: 'other', label: `Chunk “${type}”`, notes: [] });
    }
    pos = end;
    if (type === 'IEND') break;
  }

  if (pos < b.length) {
    const extra = b.subarray(pos);
    const removed = mode === 'all' || removeWhenEditing(mode, 'trailer', '');
    if (!removed) keep.push(extra);
    blocks.push({ category: 'trailer', label: 'Hidden data after the image', size: extra.length, removed, notes: [], payload: extra });
  }

  if (exifRemoved && opts.keepOrientation && orientation !== 1) {
    keep.splice(afterIhdr, 0, chunk('eXIf', orientationOnlyTiff(orientation)));
    blocks.find((x) => x.category === 'exif')?.notes.push('Orientation kept so the image is not sideways');
  }
  if (mode === 'date' && !tiff) {
    const r = newDateExif(opts);
    edit = r.report;
    if (r.tiff) keep.splice(afterIhdr, 0, chunk('eXIf', r.tiff));
  }
  if (mode === 'gps' && !edit) edit = { gpsRemoved: false };

  return { blocks, output: concat(keep), orientation, hasGps, tiff, xmp, blanked: false, edit };
}
