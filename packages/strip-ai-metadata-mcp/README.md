# strip-ai-metadata-mcp

A **free, local MCP server** that lets Claude, Cursor, VS Code and other AI assistants remove hidden metadata from your files. It removes GPS location, camera and serial numbers, author names, dates, XMP/IPTC, **C2PA Content Credentials** and **AI prompts** from photos, videos, PDFs and camera RAW files.

- **Runs on your computer.** Files are never uploaded. Your assistant only sees file names and the report.
- **No API key, no account, no monthly limit.**
- **Originals are never changed.** A clean copy is saved as `name-clean.ext`.
- **Lossless.** Image pixels, video and audio streams and RAW sensor data are not re-encoded.

| Kind | Formats |
|---|---|
| Photos | JPG, PNG, WebP, AVIF, HEIC |
| Video | MP4, MOV, M4V, 3GP |
| Documents | PDF |
| Camera RAW | CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF |

## Ask in plain words

> "Remove the location from the photos in my Downloads folder"
>
> "Strip the author and dates from report.pdf before I send it"
>
> "Check this PNG for AI metadata, then remove only the AI tags and keep the camera data"
>
> "Clean all the RAW files in ~/Pictures/shoot but keep the capture dates"

## Setup

You need Node.js 20 or newer.

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "strip-ai-metadata": {
      "command": "npx",
      "args": ["-y", "strip-ai-metadata-mcp"]
    }
  }
}
```

On Windows, if it doesn't start, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "strip-ai-metadata-mcp"]`.

### Claude Code

```bash
claude mcp add strip-ai-metadata -- npx -y strip-ai-metadata-mcp
```

### Cursor

In `~/.cursor/mcp.json`, add the same `mcpServers` block as for Claude Desktop.

### VS Code

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "strip-ai-metadata": { "command": "npx", "args": ["-y", "strip-ai-metadata-mcp"] }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `clean_files` | Cleans files or folders and saves clean copies. Options: `mode` (`all`, `ai`, `gps`, `c2pa`), `output_dir`, `in_place`, `keep_dates` (RAW), `recursive`. |
| `inspect_files` | Shows what files reveal without changing them: GPS, camera, serials, author, dates, C2PA, AI tags and prompts. |

### Modes (images)

- `all` (default): removes everything.
- `ai`: removes only AI-related data (C2PA, the IPTC AI source type, prompts, AI tool names) and keeps camera data. Useful for real photos that get a wrong "AI info" label after a small edit.
- `gps`: removes only the location.
- `c2pa`: removes only Content Credentials.

## What it can't do

Metadata removal can't remove invisible watermarks stored in the pixels, such as Google SynthID. If you publish realistic AI-generated images, platforms and some laws expect you to disclose it.

## Also available

- The **web tools** at [stripaimetadata.com](https://www.stripaimetadata.com) run in your browser, with no upload and no limits.
- The **CLI and library**: [`strip-ai-metadata`](https://www.npmjs.com/package/strip-ai-metadata).

MIT licensed.
