// Reads C2PA Content Credentials: JUMBF boxes holding CBOR/JSON assertions,
// a claim and a COSE signature. This *displays* what the manifest says — it
// does not cryptographically verify the signature.
import { ascii, concat, u16be, u32be, utf8 } from './bytes';
import type { ImageFormat, MetaBlock } from './types';

// ---------- CBOR (RFC 8949), just what C2PA uses ----------

const BREAK = Symbol('break');

export function decodeCbor(b: Uint8Array): unknown {
  let p = 0;
  const need = (n: number) => {
    if (p + n > b.length) throw new Error('CBOR: unexpected end');
  };
  const arg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return need(1), b[p++];
    if (info === 25) return need(2), (p += 2), u16be(b, p - 2);
    if (info === 26) return need(4), (p += 4), u32be(b, p - 4);
    if (info === 27) return need(8), (p += 8), u32be(b, p - 8) * 2 ** 32 + u32be(b, p - 4);
    if (info === 31) return -1;
    throw new Error('CBOR: bad length');
  };
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const item = (): unknown => {
    need(1);
    const ib = b[p++];
    const major = ib >> 5;
    const info = ib & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 31) return BREAK;
      if (info === 24) return need(1), p++, undefined;
      if (info === 25) {
        need(2);
        const h = u16be(b, p);
        p += 2;
        const exp = (h >> 10) & 31;
        const frac = h & 1023;
        const v = exp === 0 ? frac * 2 ** -24 : exp === 31 ? (frac ? NaN : Infinity) : (1 + frac / 1024) * 2 ** (exp - 15);
        return h & 0x8000 ? -v : v;
      }
      if (info === 26) return need(4), (p += 4), view.getFloat32(p - 4);
      if (info === 27) return need(8), (p += 8), view.getFloat64(p - 8);
      return info;
    }
    const n = arg(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2:
      case 3: {
        if (n === -1) {
          const parts: unknown[] = [];
          for (let x = item(); x !== BREAK; x = item()) parts.push(x);
          return major === 2 ? concat(parts as Uint8Array[]) : parts.join('');
        }
        need(n);
        const s = b.subarray(p, (p += n));
        return major === 2 ? s : utf8(s);
      }
      case 4: {
        const a: unknown[] = [];
        if (n === -1) for (let x = item(); x !== BREAK; x = item()) a.push(x);
        else for (let i = 0; i < n; i++) a.push(item());
        return a;
      }
      case 5: {
        const o: Record<string, unknown> = {};
        for (let i = 0; n === -1 || i < n; i++) {
          const k = item();
          if (k === BREAK) break;
          o[String(k)] = item();
        }
        return o;
      }
      case 6:
        return item(); // tags (e.g. COSE_Sign1 = 18) are not needed
    }
    throw new Error('CBOR: bad item');
  };
  return item();
}

// ---------- JUMBF ----------

export interface JBox {
  type: string;
  label?: string;
  children: JBox[];
  data?: Uint8Array;
}

function parseBoxes(b: Uint8Array, from: number, to: number, depth = 0): JBox[] {
  const out: JBox[] = [];
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
    const start = p + header;
    const end = p + size;
    if (type === 'jumb' && depth < 12) {
      const kids = parseBoxes(b, start, end, depth + 1);
      const jumd = kids.find((k) => k.type === 'jumd');
      let label: string | undefined;
      if (jumd?.data && jumd.data.length > 17 && jumd.data[16] & 0x02) {
        const s = jumd.data.subarray(17);
        const nul = s.indexOf(0);
        label = utf8(nul < 0 ? s : s.subarray(0, nul));
      }
      out.push({ type, label, children: kids.filter((k) => k.type !== 'jumd') });
    } else {
      out.push({ type, children: [], data: b.subarray(start, end) });
    }
    p = end;
  }
  return out;
}

/** Joins the C2PA blocks found by the stripper back into one JUMBF manifest store. */
export function jumbfFromBlocks(format: ImageFormat, blocks: MetaBlock[]): Uint8Array | null {
  const parts = blocks.filter((b) => b.category === 'c2pa' && b.payload?.length).map((b) => b.payload!);
  if (!parts.length) return null;

  if (format === 'jpeg') {
    // APP11 JPEG-XT: "JP" | En (box instance) | Z (sequence) | box bytes.
    // Continuation segments repeat the 8-byte LBox/TBox header, which is skipped.
    const groups = new Map<number, Array<{ z: number; data: Uint8Array }>>();
    for (const s of parts) {
      if (s.length < 16 || s[0] !== 0x4a || s[1] !== 0x50) continue;
      const en = u16be(s, 2);
      const z = u32be(s, 4);
      if (!groups.has(en)) groups.set(en, []);
      groups.get(en)!.push({ z, data: s });
    }
    for (const segs of groups.values()) {
      segs.sort((a, b) => a.z - b.z);
      const joined = concat(segs.map((s, i) => s.data.subarray(i === 0 ? 8 : 16)));
      const top = parseBoxes(joined, 0, joined.length)[0];
      if (top?.label === 'c2pa') return joined;
    }
    return null;
  }

  const first = parts[0];
  if (format === 'heif' || format === 'avif') {
    // uuid box payload: version+flags (4) | purpose\0 | [8-byte offset if "manifest"] | JUMBF
    const nul = first.indexOf(0, 4);
    if (nul < 0) return null;
    const purpose = ascii(first, 4, nul - 4);
    return first.subarray(nul + 1 + (purpose === 'manifest' ? 8 : 0));
  }
  return first; // PNG caBX, WebP C2PA: JUMBF as-is
}

// ---------- Summary ----------

export interface C2paAction {
  action: string;
  label: string;
  when?: string;
  softwareAgent?: string;
  sourceType?: string;
  description?: string;
}

export interface C2paManifest {
  label: string;
  generator?: string;
  title?: string;
  format?: string;
  signer?: string;
  issuer?: string;
  actions: C2paAction[];
  ingredients: Array<{ title?: string; format?: string; relationship?: string }>;
  aiGenerated: boolean;
  aiEdited: boolean;
  /** the credentials record that an invisible watermark was put into the pixels */
  watermarked: boolean;
  training: Array<{ use: string; allowed: string }>;
  authors: string[];
  thumbnail?: { type: string; data: Uint8Array };
  assertions: string[];
  claim?: unknown;
}

export interface C2paReport {
  active: C2paManifest;
  manifests: C2paManifest[];
}

const ACTION_LABELS: Record<string, string> = {
  'c2pa.created': 'Created',
  'c2pa.opened': 'Opened an existing file',
  'c2pa.edited': 'Edited',
  'c2pa.edited.metadata': 'Metadata edited',
  'c2pa.placed': 'Added another image',
  'c2pa.removed': 'Removed part of the image',
  'c2pa.converted': 'Converted to another format',
  'c2pa.transcoded': 'Re-encoded',
  'c2pa.repackaged': 'Repackaged',
  'c2pa.color_adjustments': 'Colours adjusted',
  'c2pa.cropped': 'Cropped',
  'c2pa.resized': 'Resized',
  'c2pa.orientation': 'Rotated or flipped',
  'c2pa.filtered': 'Filter applied',
  'c2pa.drawing': 'Drawn or painted on',
  'c2pa.watermarked': 'Invisible watermark added',
  'c2pa.watermarked.bound': 'Invisible watermark added',
  'c2pa.watermarked.unbound': 'Invisible watermark added',
  'c2pa.redacted': 'Redacted',
  'c2pa.published': 'Published',
  'c2pa.translated': 'Translated',
  'c2pa.unknown': 'Unknown edits',
};

const SOURCE_TYPES: Record<string, string> = {
  trainedAlgorithmicMedia: 'AI-generated',
  compositeWithTrainedAlgorithmicMedia: 'Edited with AI',
  algorithmicallyEnhanced: 'Enhanced by an algorithm',
  algorithmicMedia: 'Generated by an algorithm (not AI-trained)',
  compositeSynthetic: 'Composite including synthetic elements',
  digitalCapture: 'Captured with a camera',
  computationalCapture: 'Captured with computational photography',
  negativeFilm: 'Scanned from film negative',
  positiveFilm: 'Scanned from slide film',
  print: 'Scanned from a print',
  humanEdits: 'Edited by a person',
  minorHumanEdits: 'Minor edits by a person',
  compositeCapture: 'Composite of camera images',
  composite: 'Composite',
  digitalCreation: 'Created digitally by a person',
  dataDrivenMedia: 'Created from data',
  screenCapture: 'Screenshot',
  virtualRecording: 'Recorded in a virtual environment',
};

export const sourceTypeLabel = (uri?: string) => {
  if (!uri) return undefined;
  const key = uri.split('/').pop() ?? uri;
  return SOURCE_TYPES[key] ?? key;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function agentName(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return [str(o.name), str(o.version)].filter(Boolean).join(' ') || undefined;
  }
  return undefined;
}

function content(box: JBox): { kind: string; value: unknown } | undefined {
  for (const c of box.children) {
    if (!c.data) continue;
    try {
      if (c.type === 'cbor') return { kind: 'cbor', value: decodeCbor(c.data) };
      if (c.type === 'json') return { kind: 'json', value: JSON.parse(utf8(c.data)) };
    } catch {
      return undefined;
    }
  }
  const media = box.children.find((c) => c.type === 'bfdb')?.data;
  const file = box.children.find((c) => c.type === 'bidb')?.data;
  if (file) {
    const type = media ? utf8(media.subarray(1)).split('\0')[0] : 'image/jpeg';
    return { kind: 'file', value: { type, data: file } };
  }
  return undefined;
}

/** Subject (signer) and issuer organisation/common names from a DER certificate. */
function certNames(der: Uint8Array): { signer?: string; issuer?: string } {
  const read = (oid: number) => {
    const out: string[] = [];
    for (let i = 0; i + 7 < der.length; i++) {
      if (der[i] === 0x06 && der[i + 1] === 0x03 && der[i + 2] === 0x55 && der[i + 3] === 0x04 && der[i + 4] === oid) {
        const tag = der[i + 5];
        let len = der[i + 6];
        let at = i + 7;
        if (len === 0x81) len = der[at++];
        if ([0x0c, 0x13, 0x16, 0x14].includes(tag) && at + len <= der.length) out.push(utf8(der.subarray(at, at + len)));
      }
    }
    return out;
  };
  const o = read(0x0a);
  const cn = read(0x03);
  return { issuer: o[0] ?? cn[0], signer: o[1] ?? cn[1] ?? o[0] };
}

function summarize(m: JBox): C2paManifest {
  const out: C2paManifest = { label: m.label ?? '', actions: [], ingredients: [], aiGenerated: false, aiEdited: false, watermarked: false, training: [], authors: [], assertions: [] };
  const store = m.children.find((c) => c.label === 'c2pa.assertions');

  for (const a of store?.children ?? []) {
    const label = (a.label ?? '').replace(/__\d+$/, '');
    out.assertions.push(label);
    if (label.startsWith('c2pa.soft-binding')) out.watermarked = true;
    const c = content(a);
    if (!c) continue;
    const v = c.value as Record<string, unknown>;

    if (label.startsWith('c2pa.actions')) {
      for (const act of (v.actions as Array<Record<string, unknown>>) ?? []) {
        const name = str(act.action) ?? 'unknown';
        if (name.startsWith('c2pa.watermarked')) out.watermarked = true;
        const sourceType = str(act.digitalSourceType);
        if (sourceType?.endsWith('/trainedAlgorithmicMedia')) out.aiGenerated = true;
        if (sourceType && /compositeWithTrainedAlgorithmicMedia|compositeSynthetic/.test(sourceType)) out.aiEdited = true;
        out.actions.push({
          action: name,
          label: ACTION_LABELS[name] ?? name.replace(/^c2pa\./, ''),
          when: str(act.when),
          softwareAgent: agentName(act.softwareAgent),
          sourceType: sourceTypeLabel(sourceType),
          description: str(act.description),
        });
      }
    } else if (label.startsWith('c2pa.ingredient')) {
      out.ingredients.push({ title: str(v['dc:title']), format: str(v['dc:format']), relationship: str(v.relationship) });
    } else if (label.startsWith('c2pa.thumbnail') && c.kind === 'file') {
      out.thumbnail = c.value as { type: string; data: Uint8Array };
    } else if (label.endsWith('training-mining')) {
      const entries = (v.entries ?? {}) as Record<string, Record<string, unknown>>;
      for (const [use, e] of Object.entries(entries)) out.training.push({ use: use.replace(/^(c2pa|cawg)\./, ''), allowed: String(e?.use ?? '') });
    } else if (label === 'stds.schema-org.CreativeWork') {
      const authors = ([] as unknown[]).concat(v.author ?? []);
      for (const au of authors) {
        const name = typeof au === 'string' ? au : str((au as Record<string, unknown>)?.name);
        if (name) out.authors.push(name);
      }
    }
  }

  const claimBox = m.children.find((c) => c.label === 'c2pa.claim' || c.label === 'c2pa.claim.v2');
  const claim = claimBox && (content(claimBox)?.value as Record<string, unknown> | undefined);
  if (claim) {
    out.claim = claim;
    const info = claim.claim_generator_info;
    out.generator = agentName(Array.isArray(info) ? info[0] : info) ?? str(claim.claim_generator);
    out.title = str(claim['dc:title']);
    out.format = str(claim['dc:format']);
  }

  const sigBox = m.children.find((c) => c.label === 'c2pa.signature');
  const sig = sigBox && (content(sigBox)?.value as unknown[] | undefined);
  if (Array.isArray(sig)) {
    let chain: unknown;
    try {
      const prot = sig[0] instanceof Uint8Array && sig[0].length ? (decodeCbor(sig[0]) as Record<string, unknown>) : {};
      const unprot = (sig[1] ?? {}) as Record<string, unknown>;
      // 33 = x5chain in COSE; older C2PA files (2022) used the name "x5chain" instead
      chain = prot['33'] ?? prot.x5chain ?? unprot['33'] ?? unprot.x5chain;
    } catch {
      /* unreadable header */
    }
    const leaf = Array.isArray(chain) ? chain[0] : chain;
    if (leaf instanceof Uint8Array) Object.assign(out, certNames(leaf));
  }
  return out;
}

export function readC2pa(format: ImageFormat, blocks: MetaBlock[]): C2paReport | null {
  const jumbf = jumbfFromBlocks(format, blocks);
  if (!jumbf) return null;
  const store = parseBoxes(jumbf, 0, jumbf.length).find((b) => b.label === 'c2pa');
  const manifests = (store?.children ?? []).filter((c) => c.type === 'jumb').map(summarize);
  if (!manifests.length) return null;
  // The active manifest is the last one in the store; earlier ones are history.
  return { active: manifests[manifests.length - 1], manifests };
}
