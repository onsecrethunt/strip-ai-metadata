#!/usr/bin/env node
// MCP server: lets Claude, Cursor, VS Code and other AI assistants clean metadata
// from files on this computer. Everything runs locally; files are never uploaded,
// and the assistant only sees file names and the report.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { cleanFiles, expand, inspectFile, type FileResult } from '../../core/node';

const VERSION = '1.0.0';

const server = new McpServer({ name: 'strip-ai-metadata', version: VERSION });

const summary = (results: FileResult[], verb: 'clean' | 'inspect') => {
  if (!results.length) return 'No supported files found. Supported: JPG, PNG, WebP, AVIF, HEIC, MP4, MOV, PDF and RAW (CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF).';
  return results
    .map((r) => {
      const lines = [`${r.ok ? 'OK' : 'FAILED'}: ${r.file}`];
      if (r.error) lines.push(`  error: ${r.error}`);
      if (verb === 'inspect' || !r.removed.length) for (const f of r.found) lines.push(`  found: ${f}`);
      if (verb === 'clean') {
        if (r.removed.length) lines.push(`  removed: ${r.removed.join('; ')}`);
        else if (r.ok) lines.push('  nothing to remove (already clean)');
        if (r.output) lines.push(`  saved clean copy: ${r.output}`);
      }
      for (const k of r.kept) lines.push(`  kept: ${k}`);
      for (const w of r.warnings) lines.push(`  warning: ${w}`);
      return lines.join('\n');
    })
    .join('\n\n');
};

server.registerTool(
  'clean_files',
  {
    title: 'Remove metadata from files',
    description:
      'Removes hidden metadata from photos (JPG, PNG, WebP, AVIF, HEIC), videos (MP4, MOV), PDFs and camera RAW files (CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF): GPS location, camera and serial numbers, owner and author names, dates, XMP/IPTC, C2PA Content Credentials and AI prompts. Works on files or folders on this computer. Originals are not changed: a clean copy is saved as name-clean.ext unless in_place is true. Runs locally; nothing is uploaded.',
    inputSchema: {
      paths: z.array(z.string()).min(1).describe('Absolute paths of files or folders to clean'),
      mode: z
        .enum(['all', 'ai', 'gps', 'c2pa'])
        .optional()
        .describe('Images: all = remove everything (default); ai = only AI tags, C2PA and prompts, keep camera data; gps = only location; c2pa = only Content Credentials. Videos support all and gps.'),
      output_dir: z.string().optional().describe('Folder to save clean copies in. Default: next to each original.'),
      in_place: z.boolean().optional().describe('Overwrite the originals. Only use when the user explicitly asks for it.'),
      keep_dates: z.boolean().optional().describe('RAW files: keep the capture date.'),
      recursive: z.boolean().optional().describe('Include sub-folders when a folder is given.'),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  async ({ paths, mode, output_dir, in_place, keep_dates, recursive }) => {
    const results = await cleanFiles(paths, { mode, outDir: output_dir, inPlace: in_place, keepDates: keep_dates, recursive });
    return { content: [{ type: 'text', text: summary(results, 'clean') }], isError: results.length > 0 && results.every((r) => !r.ok) };
  },
);

server.registerTool(
  'inspect_files',
  {
    title: 'Show hidden metadata in files',
    description:
      'Lists what photos, videos, PDFs and RAW files reveal without changing them: GPS location, camera, serial numbers, author, dates, C2PA Content Credentials, AI generator tags and AI prompts. Use it to check a file before sharing or to confirm a clean copy is clean.',
    inputSchema: {
      paths: z.array(z.string()).min(1).describe('Absolute paths of files or folders to inspect'),
      recursive: z.boolean().optional().describe('Include sub-folders when a folder is given.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ paths, recursive }) => {
    const files = await expand(paths, recursive);
    const results: FileResult[] = [];
    for (const f of files) results.push(await inspectFile(f));
    return { content: [{ type: 'text', text: summary(results, 'inspect') }] };
  },
);

await server.connect(new StdioServerTransport());
