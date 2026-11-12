# strip-ai-metadata

Remove hidden metadata from **photos, videos, PDFs and camera RAW files**: GPS location, camera and serial numbers, author names, dates, XMP/IPTC, **C2PA Content Credentials** and **AI prompts** (Stable Diffusion, ComfyUI, Midjourney, ChatGPT, Firefly). It's a CLI and a Node library.

- **Lossless.** Metadata is cut out of the file, so image pixels, video streams and RAW sensor data are untouched.
- **Keeps photos upright.** The orientation is kept, so phone photos don't turn sideways the way they do with Pillow or sharp.
- **Local.** Nothing is uploaded.
- **Targeted modes.** Remove everything, only AI data, only GPS, or only C2PA.

This is the same engine that runs the free browser tools at [stripaimetadata.com](https://www.stripaimetadata.com).

## CLI

```bash
npx strip-ai-metadata photo.jpg video.mp4 report.pdf IMG_0001.CR3
npx strip-ai-metadata --mode ai -r ~/Pictures/exports        # only AI tags, keep camera data
npx strip-ai-metadata --mode gps --out clean/ holiday/       # only the location
npx strip-ai-metadata inspect image.png                      # show what a file reveals
```

Clean copies are saved as `name-clean.ext` next to the originals. Use `--out <folder>` to save them elsewhere, or `--in-place` to overwrite the originals.

| Option | |
|---|---|
| `--mode all\|ai\|gps\|c2pa` | What to remove from images (default `all`). Videos support `all` and `gps`. |
| `--out <folder>` | Where to save clean copies |
| `--in-place` | Overwrite the originals |
| `--suffix <text>` | Suffix for clean copies (default `-clean`) |
| `--keep-dates` | RAW files: keep the capture date |
| `-r`, `--recursive` | Include sub-folders |
| `--json` | Print the results as JSON |

## Library

```js
import { cleanFile, cleanFiles, inspectFile, strip } from 'strip-ai-metadata';

// Files on disk
const result = await cleanFile('IMG_2041.HEIC', { mode: 'all' });
console.log(result.removed, result.output);

// Bytes in memory (JPG, PNG, WebP, AVIF, HEIC), for example an upload in an Express handler
const { output, ai } = await strip(new Uint8Array(buffer), { mode: 'all' });
```

| Function | |
|---|---|
| `cleanFile(path, options)` | Cleans one file and saves a clean copy. Returns what was found, removed and kept. |
| `cleanFiles(paths, options)` | Cleans files and folders. |
| `inspectFile(path)` | Reads what a file reveals without changing it. |
| `strip(bytes, options)` | Cleans image bytes in memory. |
| `cleanRaw(bytes, name, options)` | Cleans RAW bytes in memory (same size, sensor data untouched). |
| `cleanPdf(bytes)`, `cleanVideo(blob)` | PDF and MP4/MOV in memory. |

## Supported formats

| Kind | Formats | Removed |
|---|---|---|
| Photos | JPG, PNG, WebP, AVIF, HEIC | EXIF, GPS, XMP, IPTC, C2PA, PNG text chunks (prompts, ComfyUI workflows), comments, trailing data |
| Video | MP4, MOV, M4V, 3GP | GPS and GPS tracks, device, dates, C2PA, XMP, telemetry tracks (GoPro, DJI) |
| PDF | PDF | Author, title, software, dates, XMP, page metadata, EXIF inside embedded photos, old revisions |
| RAW | CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF | GPS, body and lens serials, owner, copyright, dates, XMP, IPTC. Make, model and maker notes are kept so raw editors still read the file. Nikon's maker-note serial is kept because Nikon needs it to decode colours. |

## Use it from an AI assistant

[`strip-ai-metadata-mcp`](https://www.npmjs.com/package/strip-ai-metadata-mcp) is a free MCP server for Claude, Cursor and VS Code that uses this library.

MIT licensed.
