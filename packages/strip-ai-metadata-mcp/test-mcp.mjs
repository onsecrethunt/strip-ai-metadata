// node packages/test-mcp.mjs <file...>: starts the built MCP server over stdio and calls its tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const files = process.argv.slice(2).map((f) => path.resolve(f));
const out = mkdtempSync(path.join(tmpdir(), 'mcp-test-'));
const transport = new StdioClientTransport({ command: process.execPath, args: ['packages/strip-ai-metadata-mcp/dist/server.js'] });
const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const inspect = await client.callTool({ name: 'inspect_files', arguments: { paths: files } });
console.log('\n--- inspect_files\n' + inspect.content[0].text);
const clean = await client.callTool({ name: 'clean_files', arguments: { paths: files, output_dir: out } });
console.log('\n--- clean_files\n' + clean.content[0].text);
await client.close();
