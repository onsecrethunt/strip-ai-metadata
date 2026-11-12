import type { DateEdit } from './exifedit';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heif';

export type Category =
  | 'exif'
  | 'xmp'
  | 'iptc'
  | 'icc'
  | 'c2pa'
  | 'text'
  | 'comment'
  | 'thumbnail'
  | 'trailer'
  | 'other';

export interface MetaBlock {
  category: Category;
  label: string;
  size: number;
  /** false when the block was kept (e.g. colour profile) */
  removed: boolean;
  notes: string[];
  /** Raw payload, used by the viewer and the AI scan. Never sent anywhere. */
  payload?: Uint8Array;
  /** For PNG text chunks: keyword + decoded text */
  key?: string;
  text?: string;
}

export interface AiSignal {
  strength: 'declared' | 'mention';
  label: string;
  detail: string;
}

/**
 * all:  remove all metadata (default)
 * gps:  remove only location data, keep everything else
 * date: change the EXIF dates, keep everything else
 * c2pa: remove only C2PA Content Credentials, keep everything else
 * ai:   remove AI-related metadata (C2PA, AI source tags, prompts, generator names), keep the rest
 */
export type Mode = 'all' | 'gps' | 'date' | 'c2pa' | 'ai';

export interface Options {
  keepOrientation: boolean;
  keepColorProfile: boolean;
  mode?: Mode;
  date?: DateEdit;
}

export interface EditReport {
  gpsRemoved?: boolean;
  dateBefore?: string;
  dateAfter?: string;
  /** set when the requested edit could not be applied to this file */
  error?: string;
}

export interface Analysis {
  format: ImageFormat;
  blocks: MetaBlock[];
  ai: AiSignal[];
  hasGps: boolean;
  orientation: number;
  /** EXIF as a standalone TIFF buffer, for detailed tag decoding */
  tiff?: Uint8Array;
  xmp?: string;
}

export interface StripResult extends Analysis {
  output: Uint8Array;
  inputSize: number;
  outputSize: number;
  /** HEIF/AVIF: metadata is blanked in place rather than cut out */
  blanked: boolean;
  edit?: EditReport;
}

export const DEFAULT_OPTIONS: Options = { keepOrientation: true, keepColorProfile: true };

export class UnsupportedFormatError extends Error {}
