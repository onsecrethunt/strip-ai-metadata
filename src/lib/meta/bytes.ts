export const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
export const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
export const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
export const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);

export function writeU32be(b: Uint8Array, o: number, v: number) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

export function writeU32le(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

export function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = o; i < o + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function startsWith(b: Uint8Array, o: number, text: string): boolean {
  if (o + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[o + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Latin-1 view with NUL bytes dropped, so UTF-16 text is searchable too. */
export function searchable(b: Uint8Array, max = 4_000_000): string {
  const n = Math.min(b.length, max);
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let i = 0; i < n; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(b.subarray(i, Math.min(n, i + CHUNK)))));
  }
  return parts.join('').replace(/\0/g, '');
}

export const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);
export const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

let crcTable: Uint32Array | undefined;
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zlib-wrapped deflate, as used by PNG zTXt/iTXt/iCCP. */
export async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
