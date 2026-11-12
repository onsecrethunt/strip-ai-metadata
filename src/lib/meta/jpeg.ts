import { concat, startsWith, u16be, utf8 } from './bytes';
import { editExif, newDateExif } from './exifedit';
import { describeTiff, orientationOnlyTiff, readTiff } from './tiff';
import { exifPlan, removeWhenEditing, type FormatResult } from './index';
import type { Category, EditReport, MetaBlock, Options } from './types';

const EXIF_ID = 'Exif\0\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';

interface Segment {
  marker: number;
  start: number;
  end: number;
  /** payload starts after marker + length */
  data: number;
}

function segments(b: Uint8Array): { segs: Segment[]; trailer: number } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG file');
  const segs: Segment[] = [];
  let pos = 2;
  while (pos < b.length - 1) {
    if (b[pos] !== 0xff) throw new Error('Corrupt JPEG structure');
    while (b[pos + 1] === 0xff && pos < b.length - 2) pos++; // fill bytes
    const start = pos;
    const marker = b[pos + 1];
    if (marker === 0xd9) {
      segs.push({ marker, start, end: pos + 2, data: pos + 2 });
      return { segs, trailer: pos + 2 };
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segs.push({ marker, start, end: pos + 2, data: pos + 2 });
      pos += 2;
      continue;
    }
    const len = u16be(b, pos + 2);
    let end = pos + 2 + len;
    if (end > b.length) throw new Error('Truncated JPEG');
    if (marker === 0xda) {
      // Skip entropy-coded data up to the next real marker.
      let i = end;
      while (i < b.length - 1) {
        if (b[i] === 0xff) {
          const nb = b[i + 1];
          if (nb === 0x00 || (nb >= 0xd0 && nb <= 0xd7)) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      end = i;
    }
    segs.push({ marker, start, end, data: pos + 4 });
    pos = end;
  }
  return { segs, trailer: b.length };
}

const app1 = (tiff: Uint8Array) => {
  const len = 2 + 6 + tiff.length;
  return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), new TextEncoder().encode(EXIF_ID), tiff]);
};

interface Info {
  category: Category;
  label: string;
  notes?: string[];
  text?: string;
}

/** What a marker segment is: null = image structure (always kept). */
function classify(b: Uint8Array, s: Segment, payload: Uint8Array): Info | 'jfif' | 'exif' | 'icc' | null {
  const m = s.marker;
  const at = (id: string) => startsWith(b, s.data, id);
  if (m === 0xe0) {
    if (at('JFIF\0')) return 'jfif';
    if (at('JFXX\0')) return { category: 'thumbnail', label: 'JFIF thumbnail' };
    return { category: 'other', label: 'APP0 data' };
  }
  if (m === 0xe1) {
    if (at(EXIF_ID)) return 'exif';
    if (at(XMP_ID)) return { category: 'xmp', label: 'XMP', text: utf8(payload.subarray(XMP_ID.length)) };
    if (at(XMP_EXT_ID)) return { category: 'xmp', label: 'Extended XMP', text: utf8(payload) };
    return { category: 'other', label: 'APP1 data' };
  }
  if (m === 0xe2) {
    if (at('ICC_PROFILE\0')) return 'icc';
    if (at('MPF\0')) return { category: 'other', label: 'Multi-picture index (MPF)', notes: ['Points to extra embedded images'] };
    return { category: 'other', label: 'APP2 data' };
  }
  if (m === 0xeb) {
    const isC2pa = /c2pa/i.test(String.fromCharCode(...payload.subarray(0, Math.min(payload.length, 64))));
    return {
      category: 'c2pa',
      label: isC2pa ? 'C2PA Content Credentials' : 'JUMBF box (APP11)',
      notes: isC2pa ? ['Provenance manifest (who/what created or edited the image)'] : [],
    };
  }
  if (m === 0xed) return { category: 'iptc', label: at('Photoshop 3.0\0') ? 'IPTC / Photoshop data' : 'APP13 data' };
  if (m === 0xee && at('Adobe')) return null; // needed to decode colours correctly
  if (m >= 0xe3 && m <= 0xef) return { category: 'other', label: `APP${m - 0xe0} data` };
  if (m === 0xfe) {
    const text = utf8(payload).replace(/\0+$/, '');
    return { category: 'comment', label: 'JPEG comment', notes: text ? [text.slice(0, 200)] : [], text };
  }
  return null;
}

export async function runJpeg(b: Uint8Array, opts: Options): Promise<FormatResult> {
  const mode = opts.mode ?? 'all';
  const { segs, trailer } = segments(b);
  const blocks: MetaBlock[] = [];
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let orientation = 1;
  let hasGps = false;
  let tiff: Uint8Array | undefined;
  let xmp: string | undefined;
  let edit: EditReport | undefined;
  let insertAt = 1; // index in `keep` where a new EXIF segment goes
  let exifRemoved = false;

  for (const s of segs) {
    const seg = b.subarray(s.start, s.end);
    const payload = b.subarray(s.data, s.end);
    const info = classify(b, s, payload);

    if (info === null) keep.push(seg);
    else if (info === 'jfif') {
      keep.push(seg);
      insertAt = keep.length;
    } else if (info === 'icc') {
      const kept = mode !== 'all' || opts.keepColorProfile;
      if (kept) keep.push(seg);
      blocks.push({ category: 'icc', label: 'Colour profile (ICC)', size: seg.length, removed: !kept, notes: kept ? ['Kept so colours stay correct'] : [], payload });
    } else if (info === 'exif') {
      const t = payload.subarray(6);
      const sum = readTiff(t);
      if (!tiff) tiff = t;
      orientation = sum.orientation;
      hasGps ||= sum.hasGps;
      const notes = describeTiff(sum);
      const plan = exifPlan(mode, t);
      if (plan === 'remove') {
        exifRemoved = true;
        blocks.push({ category: 'exif', label: 'EXIF', size: seg.length, removed: true, notes, payload });
      } else if (plan === 'keep') {
        keep.push(seg);
        blocks.push({ category: 'exif', label: 'EXIF', size: seg.length, removed: false, notes, payload });
      } else {
        const r = editExif(t.slice(), opts, orientation, true);
        edit = { ...edit, ...r.report };
        keep.push(r.report.error ? seg : app1(r.tiff));
        blocks.push({ category: 'exif', label: 'EXIF', size: seg.length, removed: false, notes: [r.note, ...notes.filter((n) => !(r.report.gpsRemoved && n.includes('GPS')))].filter(Boolean), payload });
      }
    } else {
      if (info.category === 'xmp' && info.label === 'XMP') xmp = info.text;
      const removed = mode === 'all' || removeWhenEditing(mode, info.category, info.label, info.text);
      if (!removed) keep.push(seg);
      blocks.push({ category: info.category, label: info.label, size: seg.length, removed, notes: info.notes ?? [], payload, text: info.category === 'comment' ? info.text : undefined });
    }
  }

  if (trailer < b.length) {
    const extra = b.subarray(trailer);
    const removed = mode === 'all' || removeWhenEditing(mode, 'trailer', '');
    if (!removed) keep.push(extra);
    blocks.push({ category: 'trailer', label: 'Hidden data after the image', size: extra.length, removed, notes: ['e.g. motion-photo video, depth map or embedded images'], payload: extra });
  }

  if (exifRemoved && opts.keepOrientation && orientation !== 1) {
    keep.splice(insertAt, 0, app1(orientationOnlyTiff(orientation)));
    blocks.find((x) => x.category === 'exif')?.notes.push('Orientation kept so the photo is not sideways');
  }
  if (mode === 'date' && !tiff) {
    const r = newDateExif(opts);
    edit = r.report;
    if (r.tiff) keep.splice(insertAt, 0, app1(r.tiff));
  }
  if (mode === 'gps' && !edit) edit = { gpsRemoved: false };

  return { blocks, output: concat(keep), orientation, hasGps, tiff, xmp, blanked: false, edit };
}
