# strip-ai-metadata

[![strip-ai-metadata MCP server](https://glama.ai/mcp/servers/onsecrethunt/strip-ai-metadata/badges/score.svg)](https://glama.ai/mcp/servers/onsecrethunt/strip-ai-metadata) [![npm](https://img.shields.io/npm/v/strip-ai-metadata-mcp)](https://www.npmjs.com/package/strip-ai-metadata-mcp)

Remove hidden metadata from **photos, videos, PDFs and camera RAW files**: GPS location, camera and serial numbers, author names, dates, XMP/IPTC, **C2PA Content Credentials** and **AI prompts** (Stable Diffusion, ComfyUI, Midjourney, ChatGPT, Firefly).

- **Lossless.** Metadata is cut out or blanked in place, so image pixels, video streams and RAW sensor data are untouched.
- **Local.** Nothing is uploaded.
- **Use it three ways:** an MCP server for AI assistants, a CLI, or a Node library.

This is the engine behind the free browser tools at **[stripaimetadata.com](https://www.stripaimetadata.com)**.

| Package | What it is |
|---|---|
| [`strip-ai-metadata-mcp`](packages/strip-ai-metadata-mcp) | A free MCP server for Claude, Cursor and VS Code: "remove the location from the photos in my Downloads folder" |
| [`strip-ai-metadata`](packages/strip-ai-metadata) | CLI and Node library: `npx strip-ai-metadata photo.jpg video.mp4 report.pdf IMG_0001.CR3` |

## Quick start: Claude Desktop

```json
{
  "mcpServers": {
    "strip-ai-metadata": { "command": "npx", "args": ["-y", "strip-ai-metadata-mcp"] }
  }
}
```

There are more setups (Claude Code, Cursor, VS Code) in the [MCP README](packages/strip-ai-metadata-mcp/README.md) and at [stripaimetadata.com/mcp](https://www.stripaimetadata.com/mcp).

## Supported formats

| Kind | Formats | Removed |
|---|---|---|
| Photos | JPG, PNG, WebP, AVIF, HEIC | EXIF, GPS, XMP, IPTC, C2PA, PNG text chunks (prompts, ComfyUI workflows), comments, trailing data |
| Video | MP4, MOV, M4V, 3GP | GPS and GPS tracks, device, dates, C2PA, XMP, GoPro and DJI telemetry |
| PDF | PDF | Author, title, software, dates, XMP, page metadata, EXIF inside embedded photos, old revisions |
| RAW | CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF | GPS, body and lens serials, owner, copyright, dates, XMP, IPTC. Make, model and maker notes are kept so raw editors still read the file. |

## Guides

- [Remove EXIF data in Python without sideways photos (Pillow, tested)](https://www.stripaimetadata.com/blog/remove-exif-data-python-pillow)
- [Remove EXIF data in Node.js: sharp vs exif-be-gone (tested)](https://www.stripaimetadata.com/blog/remove-exif-data-nodejs-sharp)
- [Strip EXIF from images before upload in JavaScript (no library)](https://www.stripaimetadata.com/blog/strip-exif-before-upload-javascript)

## Layout

```
src/lib/meta/   image engine (JPEG, PNG, WebP, HEIC/AVIF parsing, lossless stripping, AI and C2PA detection)
src/lib/raw.ts  RAW engine (in-place blanking; same size, sensor data untouched)
src/lib/pdf.ts  PDF engine
src/lib/video.ts MP4/MOV engine (edits boxes in place, no re-encode)
packages/       npm packages that bundle the engine
scripts/        tests
```

## Develop

```bash
npm install
npm run build   # builds packages/*/dist
npm test        # RAW engine tests
```

MIT licensed.
