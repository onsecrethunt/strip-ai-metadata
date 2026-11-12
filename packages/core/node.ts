// Node entry point shared by the `strip-ai-metadata` library/CLI and the MCP server.
// Wraps the same engine the website runs in the browser (src/lib), and adds file
// handling: folders, output names, and never touching the original.
import { readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { strip, analyze, detectFormat, type Mode } from '../../src/lib/meta/index';
import { readTiff } from '../../src/lib/meta/tiff';
import { readDateTaken } from '../../src/lib/meta/exifedit';
import { readC2pa } from '../../src/lib/meta/c2pa';
import { readPrompts } from '../../src/lib/meta/prompts';
import { cleanVideo } from '../../src/lib/video';
import { cleanPdf } from '../../src/lib/pdf';
import { cleanRaw, inspectRaw, RAW_EXTENSIONS } from '../../src/lib/raw';

export { strip, analyze, detectFormat, cleanVideo, cleanPdf, cleanRaw, inspectRaw };
export type { Mode };

export type FileKind = 'image' | 'video' | 'pdf' | 'raw';

const IMAGE_EXT = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'heic', 'heif'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v', '3gp', '3g2'];

export function kindOf(file: string): FileKind | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (RAW_EXTENSIONS.includes(ext)) return 'raw';
  return null;
}

export interface CleanOptions {
  /**
   * Images only. all = remove everything (default); ai = only AI tags, C2PA and
   * prompts (keeps camera data); gps = only location; c2pa = only Content Credentials.
   * Videos support all and gps.
   */
  mode?: 'all' | 'ai' | 'gps' | 'c2pa';
  /** Folder to save clean copies in. Default: next to each original. */
  outDir?: string;
  /** Overwrite the original instead of writing name-clean.ext. Default false. */
  inPlace?: boolean;
  /** Suffix for clean copies. Default "-clean". */
  suffix?: string;
  /** RAW only: keep capture dates. Default false. */
  keepDates?: boolean;
  /** Look inside sub-folders when a folder is given. Default false. */
  recursive?: boolean;
}

export interface FileResult {
  file: string;
  kind: FileKind | 'unsupported';
  ok: boolean;
  output?: string;
  removed: string[];
  found: string[];
  kept: string[];
  warnings: string[];
  error?: string;
  sizeBefore?: number;
  sizeAfter?: number;
}

/** Expand files and folders into a list of supported files. */
export async function expand(inputs: string[], recursive = false): Promise<string[]> {
  const out: string[] = [];
  async function visit(p: string, depth: number) {
    const s = await stat(p);
    if (s.isDirectory()) {
      if (depth > 0 && !recursive) return;
      for (const name of (await readdir(p)).sort()) {
        if (name.startsWith('.')) continue;
        const child = path.join(p, name);
        const cs = await stat(child).catch(() => null);
        if (!cs) continue;
        if (cs.isDirectory()) await visit(child, depth + 1);
        else if (kindOf(child) && !/-clean\.\w+$/i.test(name)) out.push(child);
      }
    } else out.push(p);
  }
  for (const p of inputs) await visit(path.resolve(p), 0);
  return out;
}

function outputPath(file: string, opts: CleanOptions): string {
  if (opts.inPlace) return file;
  const ext = path.extname(file);
  const base = path.basename(file, ext) + (opts.suffix ?? '-clean') + ext;
  return path.join(opts.outDir ? path.resolve(opts.outDir) : path.dirname(file), base);
}

const blockLabel: Record<string, string> = {
  exif: 'EXIF (camera, dates, settings)',
  xmp: 'XMP',
  iptc: 'IPTC',
  c2pa: 'C2PA Content Credentials',
  text: 'Text chunks / AI prompt',
  comment: 'Comment',
  thumbnail: 'Thumbnail',
  trailer: 'Hidden trailing data',
  other: 'Other metadata',
  icc: 'Colour profile',
};

/** Describe what an image contains, in plain words. */
async function describeImage(bytes: Uint8Array): Promise<{ found: string[]; ai: string[] }> {
  const a = await analyze(bytes);
  const found: string[] = [];
  const t = a.tiff ? readTiff(a.tiff) : undefined;
  if (t?.make || t?.model) found.push(`Camera: ${[t.make, t.model].filter(Boolean).join(' ')}`);
  if (t?.software) found.push(`Software: ${t.software}`);
  const date = a.tiff ? readDateTaken(a.tiff) : undefined;
  if (date) found.push(`Date taken: ${date}`);
  if (a.hasGps) found.push('GPS location');
  for (const cat of new Set(a.blocks.map((b) => b.category))) if (cat !== 'exif') found.push(blockLabel[cat] ?? cat);
  const c2 = readC2pa(a.format, a.blocks);
  if (c2) found.push(`C2PA: made with ${c2.active.generator ?? 'unknown app'}${c2.manifests.some((m) => m.aiGenerated) ? ' (AI-generated)' : c2.manifests.some((m) => m.aiEdited) ? ' (edited with AI)' : ''}`);
  const texts = Object.fromEntries(a.blocks.filter((b) => b.key && b.text).map((b) => [b.key!, b.text!]));
  const pi = readPrompts(texts);
  if (pi) found.push(`AI prompt (${pi.generator}): ${(pi.prompt ?? '').slice(0, 80)}`);
  return { found, ai: a.ai.map((s) => `${s.label}: ${s.detail}`) };
}

/** Read what a file reveals without changing anything. */
export async function inspectFile(file: string): Promise<FileResult> {
  const kind = kindOf(file);
  const base: FileResult = { file, kind: kind ?? 'unsupported', ok: false, removed: [], found: [], kept: [], warnings: [] };
  try {
    if (!kind) throw new Error('Unsupported file type');
    if (kind === 'image') {
      const d = await describeImage(new Uint8Array(await readFile(file)));
      return { ...base, ok: true, found: [...d.found, ...d.ai.map((x) => `AI signal: ${x}`)] };
    }
    if (kind === 'raw') {
      const r = inspectRaw(new Uint8Array(await readFile(file)), file);
      return { ...base, ok: true, found: [`Format: ${r.format}${r.model ? ` (${r.model})` : ''}`, ...r.found.map(([k, v]) => `${k}: ${v}`)], kept: r.kept, warnings: r.warnings };
    }
    if (kind === 'pdf') {
      const r = await cleanPdf(new Uint8Array(await readFile(file)));
      return { ...base, ok: true, found: [...r.fields.map(([k, v]) => `${k}: ${v}`), ...(r.hasXmp ? ['XMP metadata'] : []), `${r.pages} pages`] };
    }
    const { report } = await cleanVideo(await openAsBlob(file), 'all');
    return { ...base, ok: true, found: [...report.found, ...(report.location ? [`Location: ${report.location}`] : [])], warnings: report.warnings };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Clean one file and save the clean copy. The original is left alone unless inPlace is set. */
export async function cleanFile(file: string, opts: CleanOptions = {}): Promise<FileResult> {
  const kind = kindOf(file);
  const result: FileResult = { file, kind: kind ?? 'unsupported', ok: false, removed: [], found: [], kept: [], warnings: [] };
  try {
    if (!kind) throw new Error('Unsupported file type. Supported: JPG, PNG, WebP, AVIF, HEIC, MP4, MOV, PDF and RAW (CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF).');
    const out = outputPath(file, opts);
    let bytes: Uint8Array;
    result.sizeBefore = (await stat(file)).size;

    if (kind === 'image') {
      const input = new Uint8Array(await readFile(file));
      const before = await describeImage(input);
      const mode = (opts.mode ?? 'all') as Mode;
      const r = await strip(input, { mode });
      bytes = r.output;
      const after = await describeImage(bytes);
      result.found = before.found;
      result.removed = before.found.filter((f) => !after.found.includes(f));
      result.kept = after.found;
      if (mode === 'all' && after.ai.length) result.warnings.push(`AI signals left: ${after.ai.join('; ')}`);
    } else if (kind === 'raw') {
      const r = cleanRaw(new Uint8Array(await readFile(file)), file, { removeDates: !opts.keepDates });
      bytes = r.output;
      result.found = r.report.found.map(([k, v]) => `${k}: ${v}`);
      result.removed = r.report.removed;
      result.kept = r.report.kept;
      result.warnings = r.report.warnings;
    } else if (kind === 'pdf') {
      const r = await cleanPdf(new Uint8Array(await readFile(file)));
      bytes = r.output;
      result.found = r.fields.map(([k, v]) => `${k}: ${v}`);
      result.removed = r.removed;
    } else {
      const mode = opts.mode === 'gps' ? 'gps' : 'all';
      const { blob, report } = await cleanVideo(await openAsBlob(file), mode);
      bytes = new Uint8Array(await blob.arrayBuffer());
      result.found = [...report.found, ...(report.location ? [`Location: ${report.location}`] : [])];
      result.removed = report.removed;
      result.warnings = report.warnings;
    }

    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, bytes);
    result.output = out;
    result.sizeAfter = bytes.length;
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  return result;
}

/** Clean many files and folders. */
export async function cleanFiles(inputs: string[], opts: CleanOptions = {}): Promise<FileResult[]> {
  const files = await expand(inputs, opts.recursive);
  const results: FileResult[] = [];
  for (const f of files) results.push(await cleanFile(f, opts));
  return results;
}
