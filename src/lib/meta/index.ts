import { detectAi, isAiText } from './ai';
import { isobmffFormat, runIsobmff } from './isobmff';
import { runJpeg } from './jpeg';
import { runPng } from './png';
import { runWebp } from './webp';
import { searchable, startsWith } from './bytes';
import { DEFAULT_OPTIONS, UnsupportedFormatError } from './types';
import type { Analysis, Category, EditReport, ImageFormat, MetaBlock, Mode, Options, StripResult } from './types';

export * from './types';

export interface FormatResult {
  blocks: MetaBlock[];
  output: Uint8Array;
  orientation: number;
  hasGps: boolean;
  tiff?: Uint8Array;
  xmp?: string;
  blanked: boolean;
  edit?: EditReport;
}

/**
 * In the selective modes everything is kept except what the mode targets.
 * Content Credentials are dropped in every mode that changes the file, because
 * any edit breaks their signature anyway.
 */
export function removeWhenEditing(mode: Mode, category: Category, label: string, text = ''): boolean {
  if (category === 'c2pa') return true;
  if (mode === 'c2pa') return false;
  if (mode === 'ai') return ['xmp', 'text', 'comment'].includes(category) && isAiText(text);
  if (mode === 'gps') return category === 'trailer' || /MPF/.test(label) || (category === 'xmp' && /GPS(Latitude|Longitude|Altitude)|exif:GPS/i.test(text));
  if (mode === 'date') return category === 'xmp';
  return false;
}

/** What to do with the EXIF block in each mode. */
export function exifPlan(mode: Mode, tiff: Uint8Array): 'remove' | 'keep' | 'edit' {
  if (mode === 'all') return 'remove';
  if (mode === 'c2pa') return 'keep';
  // AI tools write their name or the whole prompt (UserComment) into EXIF
  if (mode === 'ai') return isAiText(searchable(tiff)) ? 'remove' : 'keep';
  return 'edit';
}

export function detectFormat(b: Uint8Array): ImageFormat | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && startsWith(b, 1, 'PNG')) return 'png';
  if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp';
  return isobmffFormat(b);
}

export const ACCEPT = '.jpg,.jpeg,.jfif,.png,.webp,.avif,.heic,.heif,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif';

export async function strip(b: Uint8Array, options: Partial<Options> = {}): Promise<StripResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const format = detectFormat(b);
  if (!format) throw new UnsupportedFormatError('Unsupported file type. Use JPG, PNG, WebP, AVIF or HEIC.');
  const run = format === 'jpeg' ? runJpeg : format === 'png' ? runPng : format === 'webp' ? runWebp : runIsobmff;
  const r = await run(b, opts);
  const ai = detectAi(r.blocks, r.xmp);
  return { ...r, format, ai, inputSize: b.length, outputSize: r.output.length };
}

export async function analyze(b: Uint8Array): Promise<Analysis> {
  const { output: _o, inputSize: _i, outputSize: _s, blanked: _b, ...rest } = await strip(b, { keepColorProfile: false, keepOrientation: false });
  return rest;
}

export const CATEGORY_LABEL: Record<MetaBlock['category'], string> = {
  exif: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC',
  icc: 'Colour profile',
  c2pa: 'C2PA',
  text: 'Text / prompt',
  comment: 'Comment',
  thumbnail: 'Thumbnail',
  trailer: 'Hidden data',
  other: 'Other',
};
