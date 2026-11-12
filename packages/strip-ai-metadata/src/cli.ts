import { cleanFiles, expand, inspectFile, type CleanOptions } from '../../core/node';

const HELP = `strip-ai-metadata: remove EXIF, GPS, C2PA, AI prompts and other hidden metadata
from photos, videos, PDFs and camera RAW files. Runs locally; nothing is uploaded.

Usage
  strip-ai-metadata [options] <files or folders...>
  strip-ai-metadata inspect <files or folders...>

Options
  --mode <all|ai|gps|c2pa>  What to remove from images (default: all)
                              ai   = only AI tags, C2PA and prompts; keeps camera data
                              gps  = only the location (also works for videos)
                              c2pa = only Content Credentials
  --out <folder>            Save clean copies in this folder (default: next to originals)
  --in-place                Overwrite the originals (default: write name-clean.ext)
  --suffix <text>           Suffix for clean copies (default: -clean)
  --keep-dates              RAW files: keep the capture date
  -r, --recursive           Include sub-folders
  --json                    Print results as JSON
  -h, --help                Show this help

Supported: JPG, PNG, WebP, AVIF, HEIC, MP4, MOV, PDF, CR2, CR3, NEF, ARW, DNG, RAF, RW2, ORF, PEF
Web version: https://www.stripaimetadata.com`;

async function main(argv: string[]) {
  const opts: CleanOptions = {};
  const inputs: string[] = [];
  let json = false;
  let inspect = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return console.log(HELP);
    else if (a === '--mode') opts.mode = argv[++i] as CleanOptions['mode'];
    else if (a === '--out') opts.outDir = argv[++i];
    else if (a === '--in-place') opts.inPlace = true;
    else if (a === '--suffix') opts.suffix = argv[++i];
    else if (a === '--keep-dates') opts.keepDates = true;
    else if (a === '-r' || a === '--recursive') opts.recursive = true;
    else if (a === '--json') json = true;
    else if (a === 'inspect' && !inputs.length && !inspect) inspect = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}. Run with --help.`);
    else inputs.push(a);
  }
  if (!inputs.length) return console.log(HELP);
  if (opts.mode && !['all', 'ai', 'gps', 'c2pa'].includes(opts.mode)) throw new Error('--mode must be all, ai, gps or c2pa');

  const results = inspect ? await Promise.all((await expand(inputs, opts.recursive)).map(inspectFile)) : await cleanFiles(inputs, opts);
  if (json) return console.log(JSON.stringify(results, null, 2));
  if (!results.length) return console.log('No supported files found.');
  for (const r of results) {
    console.log(`\n${r.ok ? '✔' : '✘'} ${r.file}`);
    if (r.error) console.log(`  Error: ${r.error}`);
    if (inspect) {
      for (const f of r.found) console.log(`  • ${f}`);
      if (r.ok && !r.found.length) console.log('  No metadata found: clean');
    }
    else {
      if (r.removed.length) console.log(`  Removed: ${r.removed.join(', ')}`);
      else if (r.ok) console.log('  Nothing to remove: already clean');
      if (r.output) console.log(`  Saved: ${r.output}`);
    }
    for (const k of r.kept) console.log(`  Kept: ${k}`);
    for (const w of r.warnings) console.log(`  Warning: ${w}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  if (failed) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
