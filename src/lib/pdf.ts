// PDF metadata: the document information dictionary (title, author, software,
// dates), the XMP metadata stream, per-page metadata and app-private data.
// Saving rewrites the file from scratch, which also drops old revisions that
// incremental saves leave behind. Photos embedded as JPEG are cleaned too,
// because they often still carry their own EXIF/GPS.
import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { strip } from './meta';

export interface PdfReport {
  pages: number;
  fields: Array<[string, string]>;
  hasXmp: boolean;
  removed: string[];
  output: Uint8Array;
}

const PRIVATE_KEYS = ['Metadata', 'PieceInfo', 'LastModified'];

export async function cleanPdf(bytes: Uint8Array): Promise<PdfReport> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) throw new Error('This PDF is password-protected. Remove the password first, then try again.');
    throw new Error('This file could not be read as a PDF.');
  }

  const fields: Array<[string, string]> = [];
  const add = (label: string, v: string | Date | undefined) => {
    if (v instanceof Date) {
      if (!isNaN(+v)) fields.push([label, v.toLocaleString()]);
    } else if (v) fields.push([label, v]);
  };
  add('Title', doc.getTitle());
  add('Author', doc.getAuthor());
  add('Subject', doc.getSubject());
  add('Keywords', doc.getKeywords());
  add('Created with', doc.getCreator());
  add('PDF producer', doc.getProducer());
  add('Created', doc.getCreationDate());
  add('Modified', doc.getModificationDate());

  const ctx = doc.context;
  const removed: string[] = [];
  const drop = (dict: PDFDict, key: string) => {
    const v = dict.get(PDFName.of(key));
    if (!v) return false;
    if (v instanceof PDFRef) ctx.delete(v);
    dict.delete(PDFName.of(key));
    return true;
  };

  const info = ctx.trailerInfo.Info;
  if (info) {
    if (info instanceof PDFRef) ctx.delete(info);
    ctx.trailerInfo.Info = undefined;
    removed.push('Document info (title, author, software, dates)');
  }
  const hasXmp = !!doc.catalog.get(PDFName.of('Metadata'));
  if (drop(doc.catalog, 'Metadata')) removed.push('XMP metadata');
  if (drop(doc.catalog, 'PieceInfo')) removed.push('App-private data');
  let pageBits = 0;
  for (const page of doc.getPages()) for (const key of PRIVATE_KEYS) if (drop(page.node, key)) pageBits++;
  if (pageBits) removed.push(`Page-level metadata (${pageBits})`);

  let photos = 0;
  const DCT = PDFName.of('DCTDecode');
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    let changed = false;
    for (const key of PRIVATE_KEYS) changed = drop(obj.dict, key) || changed;
    const filter = obj.dict.get(PDFName.of('Filter'));
    const isJpeg = filter === DCT || (filter instanceof PDFArray && filter.size() === 1 && filter.get(0) === DCT);
    if (isJpeg) {
      try {
        const r = await strip(obj.contents, { keepOrientation: false, keepColorProfile: true });
        if (r.outputSize < r.inputSize) {
          ctx.assign(ref, PDFRawStream.of(obj.dict, r.output));
          changed = true;
        }
      } catch {
        /* not a readable JPEG: leave it as it is */
      }
    }
    if (changed) photos++;
  }
  if (photos) removed.push(`Metadata inside ${photos} embedded photo${photos > 1 ? 's' : ''} (EXIF, GPS…)`);
  // Delete objects nothing points to any more (e.g. private app data that was
  // only referenced from a removed PieceInfo) — the writer would keep them.
  const reachable = new Set<string>();
  const walk = (v: unknown) => {
    if (v instanceof PDFRef) {
      if (reachable.has(v.toString())) return;
      reachable.add(v.toString());
      walk(ctx.lookup(v));
    } else if (v instanceof PDFDict) for (const [, x] of v.entries()) walk(x);
    else if (v instanceof PDFArray) for (let i = 0; i < v.size(); i++) walk(v.get(i));
    else if (v instanceof PDFRawStream) walk(v.dict);
  };
  walk(ctx.trailerInfo.Root);
  let orphans = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      ctx.delete(ref);
      orphans++;
    }
  }
  if (orphans) removed.push(`Leftover hidden data (${orphans} unused object${orphans > 1 ? 's' : ''})`);

  if (ctx.trailerInfo.ID) {
    ctx.trailerInfo.ID = undefined;
    removed.push('Document ID');
  }

  const output = await doc.save({ updateFieldAppearances: false });
  return { pages: doc.getPageCount(), fields, hasXmp, removed, output };
}
