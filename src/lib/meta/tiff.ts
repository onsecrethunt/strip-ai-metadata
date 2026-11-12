// Just enough TIFF/EXIF reading to label blocks and preserve orientation.
// Full tag decoding for the viewer is done by exifr.

export interface TiffSummary {
  orientation: number;
  hasGps: boolean;
  hasThumbnail: boolean;
  software?: string;
  make?: string;
  model?: string;
}

export function readTiff(t: Uint8Array): TiffSummary {
  const out: TiffSummary = { orientation: 1, hasGps: false, hasThumbnail: false };
  if (t.length < 8) return out;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return out;
  const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) =>
    le
      ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + ((t[o + 3] << 24) >>> 0)
      : ((t[o] << 24) >>> 0) + ((t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]);
  const str = (entry: number) => {
    const count = u32(entry + 4);
    const off = count <= 4 ? entry + 8 : u32(entry + 8);
    if (off + count > t.length) return undefined;
    let s = '';
    for (let i = 0; i < count && t[off + i]; i++) s += String.fromCharCode(t[off + i]);
    return s.trim() || undefined;
  };

  const ifd0 = u32(4);
  if (ifd0 + 2 > t.length) return out;
  const n = u16(ifd0);
  for (let i = 0; i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e);
    if (tag === 0x0112) out.orientation = u16(e + 8) || 1;
    else if (tag === 0x8825) {
      const gps = u32(e + 8);
      out.hasGps = gps + 2 <= t.length && u16(gps) > 0;
    } else if (tag === 0x0131) out.software = str(e);
    else if (tag === 0x010f) out.make = str(e);
    else if (tag === 0x0110) out.model = str(e);
  }
  const next = ifd0 + 2 + n * 12;
  if (next + 4 <= t.length) out.hasThumbnail = u32(next) !== 0;
  if (out.orientation < 1 || out.orientation > 8) out.orientation = 1;
  return out;
}

/** A tiny big-endian TIFF containing only the Orientation tag. */
export function orientationOnlyTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at 8
    0x00, 0x01, // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}

export function describeTiff(s: TiffSummary): string[] {
  const notes: string[] = [];
  if (s.make || s.model) notes.push(`Camera: ${[s.make, s.model].filter(Boolean).join(' ')}`);
  if (s.software) notes.push(`Software: ${s.software}`);
  if (s.hasGps) notes.push('Contains GPS location');
  if (s.hasThumbnail) notes.push('Contains a thumbnail preview');
  return notes;
}
