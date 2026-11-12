// node packages/build.mjs: bundles the website's metadata engine into the two npm packages.
import { build } from 'esbuild';
import { copyFileSync, chmodSync } from 'node:fs';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@cantoo/pdf-lib', '@modelcontextprotocol/sdk', 'zod'],
  logLevel: 'warning',
  legalComments: 'none',
};

await build({ ...common, entryPoints: ['packages/strip-ai-metadata/src/index.ts'], outfile: 'packages/strip-ai-metadata/dist/index.js' });
await build({ ...common, entryPoints: ['packages/strip-ai-metadata/src/cli.ts'], outfile: 'packages/strip-ai-metadata/dist/cli.js', banner: { js: '#!/usr/bin/env node' } });
await build({ ...common, entryPoints: ['packages/strip-ai-metadata-mcp/src/server.ts'], outfile: 'packages/strip-ai-metadata-mcp/dist/server.js' });

for (const pkg of ['strip-ai-metadata', 'strip-ai-metadata-mcp']) {
  copyFileSync('packages/LICENSE', `packages/${pkg}/LICENSE`);
}
try {
  chmodSync('packages/strip-ai-metadata/dist/cli.js', 0o755);
  chmodSync('packages/strip-ai-metadata-mcp/dist/server.js', 0o755);
} catch {}
console.log('Built packages/strip-ai-metadata and packages/strip-ai-metadata-mcp');
