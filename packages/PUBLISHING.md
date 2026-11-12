# Publishing the npm packages and the MCP listings

Do the steps in this order. **Deploy the website only after step 2.** The /mcp page and the comparison page tell people to run `npx strip-ai-metadata-mcp`, so the package has to exist first.

## 1. Build and test

```bash
node packages/build.mjs
node packages/strip-ai-metadata/dist/cli.js inspect test-files/chatgpt.png
node packages/strip-ai-metadata-mcp/test-mcp.mjs test-files/exiftool-GPS.jpg
npm run test:raw
```

## 2. Publish to npm (your account)

```bash
npm login
cd packages/strip-ai-metadata && npm publish
cd ../strip-ai-metadata-mcp && npm publish
```

## 3. GitHub repo (best backlink)

1. Create a public repo, for example `strip-ai-metadata`.
2. Push the `packages/` folder, plus the engine (`src/lib/meta`, `src/lib/raw.ts`, `src/lib/pdf.ts`, `src/lib/video.ts`).
3. Add `"repository": {"type": "git", "url": "https://github.com/<you>/strip-ai-metadata"}` to both `package.json` files.
4. Bump the version to 1.0.1 and publish again, so npm shows the repo link.
5. Add these topics on GitHub: `mcp`, `mcp-server`, `exif`, `metadata`, `c2pa`, `privacy`.

## 4. Official MCP Registry (registry.modelcontextprotocol.io)

The name `com.stripaimetadata/strip-ai-metadata` is verified through your domain.

1. Install `mcp-publisher` (see github.com/modelcontextprotocol/registry, "Publishing").
2. In `packages/strip-ai-metadata-mcp`, run `mcp-publisher login http --domain stripaimetadata.com`. It tells you which file to host at `https://www.stripaimetadata.com/.well-known/mcp-registry-auth`. Put that file in `public/.well-known/` and deploy.
3. Run `mcp-publisher publish` from that folder. If the schema URL in `server.json` is out of date, run `mcp-publisher init` and copy the values across.

## 5. Directories (free listings and links)

Submit `strip-ai-metadata-mcp` with the GitHub URL and https://www.stripaimetadata.com/mcp to:

- smithery.ai
- glama.ai/mcp/servers (picks up GitHub repos; claim it)
- mcp.so
- pulsemcp.com
- mcpservers.org
- a pull request to github.com/punkpeye/awesome-mcp-servers (category: "Image & Media" or "Security & Privacy")
- a pull request to github.com/modelcontextprotocol/servers (community list)
- odel.app, mcpcensus.com, syncdev.com (the directories that list the competitor)
