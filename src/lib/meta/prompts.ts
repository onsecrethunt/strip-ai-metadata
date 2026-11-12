// Reads AI generation settings (prompt, seed, model…) that image generators
// save inside PNG text chunks or the EXIF UserComment.

export interface PromptInfo {
  generator: string;
  prompt?: string;
  negative?: string;
  settings: Array<[string, string]>;
  resources: Array<[string, string]>;
}

type Json = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));

function tryJson(text: string): Json | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Automatic1111 / Forge "infotext": prompt, "Negative prompt: …", then "Steps: 20, Sampler: …". */
export function parseA1111(text: string): PromptInfo | null {
  const lines = text.replace(/\r/g, '').split('\n');
  let settingsAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Steps: ?\d+/.test(lines[i])) {
      settingsAt = i;
      break;
    }
  }
  if (settingsAt < 0 && !/Negative prompt:/.test(text)) return null;
  const head = lines.slice(0, settingsAt < 0 ? lines.length : settingsAt).join('\n');
  const negAt = head.search(/(^|\n)Negative prompt:/);
  const prompt = (negAt < 0 ? head : head.slice(0, negAt)).trim();
  const negative = negAt < 0 ? undefined : head.slice(negAt).replace(/^\n?Negative prompt:\s*/, '').trim();

  const settings: Array<[string, string]> = [];
  const resources: Array<[string, string]> = [];
  if (settingsAt >= 0) {
    // Same pattern A1111 itself uses; values may be quoted and contain commas.
    const re = /\s*(\w[\w \-/]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g;
    for (const m of lines.slice(settingsAt).join(', ').matchAll(re)) {
      const [key, value] = [m[1].trim(), m[2].trim().replace(/^"|"$/g, '')];
      if (!value) continue;
      if (/^(Model|Model hash|VAE|Lora hashes|TI hashes|Hashes)$/.test(key)) resources.push([key, value]);
      else settings.push([key, value]);
    }
  }
  for (const m of prompt.matchAll(/<lora:([^:>]+):?([\d.]*)>/g)) resources.push(['LoRA', m[2] ? `${m[1]} (${m[2]})` : m[1]]);
  return { generator: 'Stable Diffusion WebUI (A1111 / Forge)', prompt, negative, settings, resources };
}

/** ComfyUI "prompt" (API graph): follow sampler inputs back to the text encoders. */
export function parseComfy(promptJson: string): PromptInfo | null {
  const graph = tryJson(promptJson) as Record<string, { class_type?: string; inputs?: Json }> | undefined;
  if (!graph || !Object.values(graph).some((n) => n?.class_type)) return null;
  const node = (link: unknown) => (Array.isArray(link) ? graph[String(link[0])] : undefined);
  const textOf = (link: unknown, depth = 0): string | undefined => {
    const n = node(link);
    if (!n?.inputs || depth > 6) return undefined;
    for (const key of ['text', 'text_g', 'value', 'string', 'prompt']) {
      const v = n.inputs[key];
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return textOf(v, depth + 1);
    }
    // e.g. conditioning combiners: take the first conditioning input
    for (const v of Object.values(n.inputs)) if (Array.isArray(v)) {
      const t = textOf(v, depth + 1);
      if (t) return t;
    }
    return undefined;
  };

  const info: PromptInfo = { generator: 'ComfyUI', settings: [], resources: [] };
  // Classic graphs wire positive/negative straight into a KSampler. Newer ones
  // (e.g. FLUX) use SamplerCustomAdvanced + a guider node, and split noise,
  // sampler and scheduler into separate nodes.
  const nodes = Object.values(graph);
  const sampler = nodes.find((n) => n.inputs && ('positive' in n.inputs || 'guider' in n.inputs));
  if (sampler?.inputs) {
    const guider = 'guider' in sampler.inputs ? node(sampler.inputs.guider)?.inputs : sampler.inputs;
    info.prompt = textOf(guider?.positive ?? guider?.conditioning);
    info.negative = textOf(guider?.negative);
  }
  info.prompt ??= nodes
    .filter((n) => /TextEncode/.test(n.class_type ?? '') && typeof n.inputs?.text === 'string')
    .map((n) => n.inputs!.text as string)
    .sort((a, b) => b.length - a.length)[0];

  const SETTINGS: Array<[string, string]> = [['Seed', 'seed'], ['Seed', 'noise_seed'], ['Steps', 'steps'], ['CFG', 'cfg'], ['Guidance', 'guidance'], ['Sampler', 'sampler_name'], ['Scheduler', 'scheduler'], ['Denoise', 'denoise']];
  for (const [label, key] of SETTINGS) {
    const v = nodes.map((n) => n.inputs?.[key]).find((x) => x !== undefined && !Array.isArray(x));
    if (v !== undefined && !info.settings.some(([l]) => l === label)) info.settings.push([label, String(v)]);
  }
  for (const n of nodes) {
    const i = n.inputs ?? {};
    if (typeof i.ckpt_name === 'string') info.resources.push(['Checkpoint', i.ckpt_name]);
    if (typeof i.unet_name === 'string') info.resources.push(['Model', i.unet_name]);
    if (typeof i.lora_name === 'string') info.resources.push(['LoRA', `${i.lora_name}${i.strength_model !== undefined ? ` (${i.strength_model})` : ''}`]);
    if (typeof i.vae_name === 'string') info.resources.push(['VAE', i.vae_name]);
    if (/EmptyLatentImage|EmptySD3LatentImage/.test(n.class_type ?? '') && i.width) info.settings.push(['Size', `${i.width}×${i.height}`]);
  }
  return info;
}

function fromJson(generator: string, j: Json, promptKeys: string[], negKeys: string[]): PromptInfo {
  const pick = (keys: string[]) => keys.map((k) => s(j[k])).find(Boolean);
  const info: PromptInfo = { generator, prompt: pick(promptKeys), negative: pick(negKeys), settings: [], resources: [] };
  for (const [k, v] of Object.entries(j)) {
    if ([...promptKeys, ...negKeys].includes(k) || v === null || v === '') continue;
    if (/model|lora|vae|checkpoint/i.test(k)) info.resources.push([k, s(v)!.slice(0, 300)]);
    else if (typeof v !== 'object') info.settings.push([k, String(v)]);
  }
  return info;
}

/**
 * @param texts PNG text chunks as keyword → value, plus "UserComment" from EXIF.
 */
export function readPrompts(texts: Record<string, string>): PromptInfo | null {
  const params = texts.parameters ?? texts.UserComment;
  if (params) {
    const j = params.trim().startsWith('{') ? tryJson(params) : undefined;
    if (j) return fromJson(j.fooocus_scheme || j.version?.toString().includes('Fooocus') ? 'Fooocus' : 'AI generator', j, ['prompt', 'Prompt', 'full_prompt'], ['negative_prompt', 'Negative Prompt', 'full_negative_prompt']);
    const a = parseA1111(params);
    if (a) return a;
  }
  if (texts.prompt) {
    const c = parseComfy(texts.prompt);
    if (c) return c;
  }
  if (texts.invokeai_metadata) {
    const j = tryJson(texts.invokeai_metadata);
    if (j) {
      const info = fromJson('InvokeAI', j, ['positive_prompt'], ['negative_prompt']);
      const model = (j.model as Json | undefined)?.name;
      if (model) info.resources.unshift(['Model', String(model)]);
      return info;
    }
  }
  if (texts['sd-metadata']) {
    const j = tryJson(texts['sd-metadata']);
    const img = j?.image as Json | undefined;
    if (img) {
      const p = Array.isArray(img.prompt) ? (img.prompt as Json[]).map((x) => x.prompt).join(' ') : s(img.prompt);
      return { ...fromJson('InvokeAI', img, [], []), prompt: p };
    }
  }
  if (texts.Comment && /NovelAI/i.test(texts.Software ?? texts.Source ?? '')) {
    const j = tryJson(texts.Comment);
    if (j) return { ...fromJson('NovelAI', j, ['prompt'], ['uc']), prompt: s(j.prompt) ?? texts.Description };
  }
  if (texts.Dream) return { generator: 'InvokeAI (legacy)', prompt: texts.Dream, settings: [], resources: [] };
  const desc = texts.Description ?? texts.Comment;
  if (desc && /--(ar|v|stylize|chaos)\b|Job ID/i.test(desc)) {
    return { generator: 'Midjourney', prompt: desc.replace(/\s*Job ID:.*$/s, '').trim(), settings: [], resources: [] };
  }
  return null;
}
