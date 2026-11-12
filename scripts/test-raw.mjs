// npm run test:raw — builds synthetic RAW files (CR2-style TIFF, CR3, RAF-style JPEG
// container, Nikon NEF) full of identifying metadata, cleans them, and checks the result
// with exifr and with a byte-level comparison.
import exifr from 'exifr';
import { cleanRaw, inspectRaw } from '../src/lib/raw.ts';

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// ---- tiny TIFF writer (little-endian) ------------------------------------
const TYPES = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7 };
function tiff(build) {
  // build(ifd) returns IFD0 entries; nested IFDs are { ifd: [...] } values
  const buf = new Uint8Array(1 << 16);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  let end = 8;
  const alloc = (n) => {
    const at = end;
    end += n + (n & 1);
    return at;
  };
  function writeIfd(entries, nextPtrAt) {
    entries.sort((a, b) => a[0] - b[0]);
    const at = alloc(2 + entries.length * 12 + 4);
    dv.setUint16(at, entries.length, true);
    entries.forEach(([tag, type, value], i) => {
      const e = at + 2 + i * 12;
      dv.setUint16(e, tag, true);
      if (value && value.ifd) {
        const n = value.ifd.length;
        dv.setUint16(e + 2, value.undefined ? TYPES.UNDEFINED : TYPES.LONG, true);
        dv.setUint32(e + 4, value.undefined ? 2 + n * 12 + 4 : 1, true);
        dv.setUint32(e + 8, writeIfd(value.ifd), true);
        return;
      }
      dv.setUint16(e + 2, type, true);
      let bytes;
      if (type === TYPES.ASCII) bytes = new TextEncoder().encode(value + '\0');
      else if (type === TYPES.UNDEFINED || type === TYPES.BYTE) bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
      else if (type === TYPES.SHORT) bytes = new Uint8Array(new Uint16Array(value).buffer);
      else if (type === TYPES.LONG) bytes = new Uint8Array(new Uint32Array(value).buffer);
      else if (type === TYPES.RATIONAL) bytes = new Uint8Array(new Uint32Array(value.flat()).buffer);
      const unit = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }[type];
      dv.setUint32(e + 4, bytes.length / unit, true);
      if (bytes.length <= 4) buf.set(bytes, e + 8);
      else {
        const d = alloc(bytes.length);
        buf.set(bytes, d);
        dv.setUint32(e + 8, d, true);
      }
    });
    return at;
  }
  const ifd0 = writeIfd(build());
  dv.setUint32(4, ifd0, true);
  return buf.slice(0, end);
}

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.5N" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Jane Private"/></rdf:RDF></x:xmpmeta>${' '.repeat(200)}<?xpacket end="w"?>`;

const gps = () => ({
  ifd: [
    [1, TYPES.ASCII, 'N'],
    [2, TYPES.RATIONAL, [[48, 1], [51, 1], [2940, 100]]],
    [3, TYPES.ASCII, 'E'],
    [4, TYPES.RATIONAL, [[2, 1], [17, 1], [4000, 100]]],
    [6, TYPES.RATIONAL, [[35, 1]]],
  ],
});
const SENSOR = Uint8Array.from({ length: 4000 }, (_, i) => (i * 7919) & 0xff);

function cr2Like({ make = 'Canon', makerNote }) {
  return tiff(() => [
    [0x010f, TYPES.ASCII, make],
    [0x0110, TYPES.ASCII, `${make} Test Body`],
    [0x0132, TYPES.ASCII, '2026:05:01 10:11:12'],
    [0x013b, TYPES.ASCII, 'Jane Private'],
    [0x8298, TYPES.ASCII, '(c) Jane Private'],
    [0x02bc, TYPES.UNDEFINED, XMP],
    [0x0111, TYPES.UNDEFINED, SENSOR], // stand-in for the sensor data
    [0x8825, 0, gps()],
    [
      0x8769,
      0,
      {
        ifd: [
          [0x829a, TYPES.RATIONAL, [[1, 250]]],
          [0x9003, TYPES.ASCII, '2026:05:01 10:11:12'],
          [0x9004, TYPES.ASCII, '2026:05:01 10:11:12'],
          [0xa430, TYPES.ASCII, 'Jane Private'],
          [0xa431, TYPES.ASCII, '123456789012'],
          [0xa435, TYPES.ASCII, 'LENS998877'],
          [0xa434, TYPES.ASCII, 'EF 50mm f/1.8'],
          ...(makerNote ? [[0x927c, 0, makerNote]] : []),
        ],
      },
    ],
  ]);
}

function sensorIntact(a, b) {
  const find = (buf) => {
    for (let i = 0; i < buf.length - 64; i++) if (buf[i] === SENSOR[0] && buf.subarray(i, i + 64).every((v, k) => v === SENSOR[k])) return i;
    return -1;
  };
  const i = find(a);
  return i >= 0 && b.subarray(i, i + SENSOR.length).every((v, k) => v === a[i + k]);
}

async function checkTiff(name, input, { expectSerialGone = true } = {}) {
  console.log(`\n== ${name}`);
  const before = await exifr.parse(input, { tiff: true, exif: true, gps: true, xmp: true, makerNote: false, mergeOutput: true });
  console.log('   exifr keys:', Object.keys(before ?? {}).join(','));
  ok(before?.latitude && before?.DateTimeOriginal, `exifr reads GPS + date in the original (${before?.latitude?.toFixed?.(4)})`);
  const info = inspectRaw(input, name);
  ok(info.found.some(([k]) => k === 'GPS location'), `inspect finds GPS: ${JSON.stringify(info.found.find(([k]) => k === 'GPS location'))}`);
  const { output, report } = cleanRaw(input, name);
  console.log('   format:', report.format, '| removed:', report.removed.join('; '));
  console.log('   kept:', report.kept.join(' | '));
  if (report.warnings.length) console.log('   warnings:', report.warnings);
  ok(output.length === input.length, 'same file size');
  ok(sensorIntact(input, output), 'sensor data byte-identical');
  const after = await exifr.parse(output, { tiff: true, exif: true, gps: true, xmp: true, mergeOutput: true });
  ok(after && after.Make && after.Model, `camera make/model kept (${after?.Make} ${after?.Model})`);
  ok(after?.ExposureTime === 1 / 250 || after?.ExposureTime === 0.004, 'exposure kept');
  ok(!after?.latitude && !after?.GPSLatitude, 'GPS gone');
  ok(!after?.Artist && !after?.Copyright && !after?.OwnerName && !after?.CameraOwnerName, 'owner/artist/copyright gone');
  if (expectSerialGone) ok(!after?.BodySerialNumber && !after?.LensSerialNumber, 'serials gone');
  ok(!after?.DateTimeOriginal, 'date taken gone');
  ok(!/Jane Private|48,51/.test(new TextDecoder('latin1').decode(output)), 'no personal strings left anywhere in the file');
  ok(report.warnings.length === 0, 'no warnings');
  const keepDates = cleanRaw(input, name, { removeDates: false });
  const kd = await exifr.parse(keepDates.output, { exif: true, mergeOutput: true });
  ok(kd?.DateTimeOriginal, 'removeDates:false keeps the date');
}

// 1. CR2-style TIFF with a Canon maker note (serial as LONG, owner, internal serial)
const canonMN = { undefined: true, ifd: [[0x0009, TYPES.ASCII, 'Jane Private Studio'], [0x000c, TYPES.LONG, [3141592653]], [0x0096, TYPES.ASCII, 'XY1234567'], [0x0095, TYPES.ASCII, 'EF50mm f/1.8 STM']] };
const cr2 = cr2Like({ makerNote: canonMN });
cr2.set([0x43, 0x52, 2, 0], 8); // "CR" marker like a real CR2 (bytes 8-11 are inside IFD0 padding? keep harmless)
await checkTiff('test.cr2', cr2Like({ makerNote: canonMN }));
{
  const { report } = cleanRaw(cr2Like({ makerNote: canonMN }), 'x.cr2');
  ok(report.found.some(([k, v]) => k === 'Camera serial number'), 'Canon maker-note serial found');
  ok(report.removed.includes('Internal serial number'), 'Canon internal serial removed');
}

// 2. Nikon: maker note must be left alone
{
  const nikonMN = new Uint8Array(64);
  nikonMN.set(new TextEncoder().encode('Nikon\0\x02\x10\0\0II*\0\x08\0\0\0'));
  const nef = cr2Like({ make: 'NIKON CORPORATION', makerNote: undefined });
  await checkTiff('test.nef', nef);
  const { report } = cleanRaw(nef, 'test.nef');
  ok(report.format.startsWith('Nikon'), `detected as ${report.format}`);
}

// 3. CR3: ftyp crx + moov with CMT1..CMT4 TIFF boxes
{
  const box = (type, payload) => {
    const b = new Uint8Array(8 + payload.length);
    new DataView(b.buffer).setUint32(0, b.length);
    b.set(new TextEncoder().encode(type), 4);
    b.set(payload, 8);
    return b;
  };
  const cat = (...p) => {
    const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of p) (out.set(x, o), (o += x.length));
    return out;
  };
  const cmt1 = tiff(() => [[0x010f, TYPES.ASCII, 'Canon'], [0x0110, TYPES.ASCII, 'Canon EOS R5'], [0x013b, TYPES.ASCII, 'Jane Private'], [0x0132, TYPES.ASCII, '2026:05:01 10:11:12']]);
  const cmt2 = tiff(() => [[0x9003, TYPES.ASCII, '2026:05:01 10:11:12'], [0xa431, TYPES.ASCII, '0123456789'], [0x829a, TYPES.RATIONAL, [[1, 250]]]]);
  const cmt3 = tiff(() => [[0x0009, TYPES.ASCII, 'Jane Private'], [0x000c, TYPES.LONG, [3141592653]]]);
  const cmt4 = tiff(() => gps().ifd);
  const uuid = cat(Uint8Array.from([0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48]), box('CMT1', cmt1), box('CMT2', cmt2), box('CMT3', cmt3), box('CMT4', cmt4));
  const file = cat(box('ftyp', new TextEncoder().encode('crx \0\0\0\x01crx isom')), box('moov', box('uuid', uuid)), box('mdat', SENSOR));
  console.log('\n== test.cr3');
  const { output, report } = cleanRaw(file, 'test.cr3');
  console.log('   format:', report.format, '| removed:', report.removed.join('; '), '| found:', JSON.stringify(report.found));
  ok(report.format === 'Canon CR3', 'detected CR3');
  ok(['GPS location', 'Camera serial number', 'Artist / owner', 'Camera owner name', 'Capture and edit dates'].every((x) => report.removed.includes(x)), 'GPS, serials, owner, dates removed');
  ok(output.length === file.length && sensorIntact(file, output), 'size and sensor data unchanged');
  ok(!/Jane Private/.test(new TextDecoder('latin1').decode(output)), 'no personal strings left');
  ok(/Canon EOS R5/.test(new TextDecoder('latin1').decode(output)), 'model kept');
  ok(report.warnings.length === 0, 'no warnings ' + report.warnings.join(';'));
}

// 4. RAF-style: Fuji header + embedded JPEG with APP1 EXIF (GPS + serial)
{
  const exif = cr2Like({ make: 'FUJIFILM' });
  const app1 = new Uint8Array(4 + 6 + exif.length);
  app1.set([0xff, 0xe1, ((app1.length - 2) >> 8) & 0xff, (app1.length - 2) & 0xff]);
  app1.set(new TextEncoder().encode('Exif\0\0'), 4);
  app1.set(exif, 10);
  const head = new Uint8Array(160);
  head.set(new TextEncoder().encode('FUJIFILMCCD-RAW 0201FF383501'));
  const file = new Uint8Array(head.length + 2 + app1.length + SENSOR.length);
  file.set(head);
  file.set([0xff, 0xd8], head.length);
  file.set(app1, head.length + 2);
  file.set(SENSOR, head.length + 2 + app1.length);
  console.log('\n== test.raf');
  const { output, report } = cleanRaw(file, 'test.raf');
  console.log('   format:', report.format, '| removed:', report.removed.join('; '));
  ok(report.format === 'Fujifilm RAF', 'detected RAF');
  ok(report.removed.includes('GPS location') && report.removed.includes('Camera serial number'), 'embedded EXIF cleaned');
  ok(!/Jane Private/.test(new TextDecoder('latin1').decode(output)), 'no personal strings left');
  ok(sensorIntact(file, output), 'sensor data unchanged');
}

// 5. Not a RAW
try {
  cleanRaw(new TextEncoder().encode('hello world, not a raw file'), 'x.txt');
  ok(false, 'rejects non-RAW');
} catch (e) {
  ok(/not a supported RAW/.test(e.message), 'rejects non-RAW');
}

// RAW_SAMPLES_DIR=folder npm run test:raw also saves a synthetic CR2 for manual browser testing
if (process.env.RAW_SAMPLES_DIR) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${process.env.RAW_SAMPLES_DIR}/synthetic-test.cr2`, cr2Like({ makerNote: canonMN }));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
