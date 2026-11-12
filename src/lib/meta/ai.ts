import { searchable } from './bytes';
import type { AiSignal, MetaBlock } from './types';

// Generators whose name in metadata is a strong sign of an AI-made image.
const GENERATORS: Array<[RegExp, string]> = [
  [/midjourney/i, 'Midjourney'],
  [/dall[\s·.-]?e/i, 'DALL·E'],
  [/chatgpt|gpt-4o|gpt-image|openai/i, 'OpenAI / ChatGPT'],
  [/firefly/i, 'Adobe Firefly'],
  [/stable[\s_-]?diffusion|stability\.?ai|sdxl/i, 'Stable Diffusion'],
  [/comfyui/i, 'ComfyUI'],
  [/novelai/i, 'NovelAI'],
  [/invokeai/i, 'InvokeAI'],
  [/\bimagen[\s-]?\d|\bgemini\b|nano[\s-]?banana/i, 'Google Imagen / Gemini'],
  [/bing image creator|microsoft designer|designer\.microsoft/i, 'Microsoft Designer / Bing'],
  [/leonardo\.?ai/i, 'Leonardo.Ai'],
  [/ideogram/i, 'Ideogram'],
  [/black forest labs|\bflux(\.1)?\b/i, 'FLUX'],
  [/meta ai|imagine with meta/i, 'Meta AI'],
  [/\bgrok\b|\bx\.ai\b/i, 'Grok'],
  [/recraft/i, 'Recraft'],
  [/runway(ml)?/i, 'Runway'],
  [/krea\.ai|\bkrea\b/i, 'Krea'],
  [/generative fill|generative expand/i, 'Photoshop Generative Fill'],
];

const SOURCE_TYPES: Array<[string, string]> = [
  ['compositeWithTrainedAlgorithmicMedia', 'Marked as edited with AI (IPTC: composite with trained algorithmic media)'],
  ['trainedAlgorithmicMedia', 'Marked as AI-generated (IPTC: trained algorithmic media)'],
  ['compositeSynthetic', 'Marked as a synthetic composite (IPTC)'],
  ['algorithmicMedia', 'Marked as algorithmically generated (IPTC)'],
];

const PROMPT_KEYS = /^(parameters|prompt|workflow|invokeai_metadata|invokeai_graph|sd-metadata|Dream|generation_data)\b/;

// Names that can only mean an AI image tool. Used to decide what the "AI only"
// mode deletes, so it must not match ordinary words in captions (unlike the
// looser GENERATORS list above, which only produces "mentions" in reports).
const AI_TOOL_NAMES =
  /\bmidjourney\b|\bdall[\s·.-]?e\b|\bchatgpt\b|\bopenai\b|adobe firefly|\bfirefly image\b|stable[\s_-]?diffusion|\bstability\.?ai\b|\bsdxl\b|\bcomfyui\b|\bnovelai\b|\binvokeai\b|\bfooocus\b|\bautomatic1111\b|bing image creator|microsoft designer|\bleonardo\.ai\b|\bideogram\b|black forest labs|imagine with meta|generative fill|generative expand|made with google ai/i;

/**
 * True when a metadata block clearly marks the image as AI-made: an AI source
 * type, saved generation settings, or the name of an AI image tool.
 */
export function isAiText(text: string): boolean {
  if (!text) return false;
  if (PROMPT_KEYS.test(text)) return true;
  if (SOURCE_TYPES.some(([key]) => text.includes(key))) return true;
  if (/Steps: ?\d+.*Sampler:/s.test(text) || /Negative prompt:/.test(text) || /"class_type"/.test(text)) return true;
  if (/Job ID: ?[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) return true; // Midjourney
  return AI_TOOL_NAMES.test(text);
}

export function detectAi(blocks: MetaBlock[], xmp?: string): AiSignal[] {
  const out: AiSignal[] = [];
  const seen = new Set<string>();
  const push = (s: AiSignal) => {
    if (seen.has(s.label)) return;
    seen.add(s.label);
    out.push(s);
  };

  const texts = blocks.map((b) => ({ b, s: b.text ?? (b.payload ? searchable(b.payload) : '') }));
  if (xmp) texts.push({ b: { category: 'xmp' } as MetaBlock, s: xmp });
  const all = texts.map((t) => t.s).join('\n');

  // IPTC Digital Source Type — what Meta/Instagram, Google and others read.
  for (const [key, label] of SOURCE_TYPES) {
    if (all.includes(key)) {
      const where = texts.find((t) => t.s.includes(key))?.b.category === 'c2pa' ? 'C2PA manifest' : 'XMP / IPTC';
      push({ strength: 'declared', label, detail: `Found in ${where}. Platforms such as Instagram, Facebook and Threads use this to show an “AI info” label.` });
      break;
    }
  }

  if (blocks.some((b) => b.category === 'c2pa')) {
    const c2pa = texts.filter((t) => t.b.category === 'c2pa').map((t) => t.s).join('\n');
    const actions = [...new Set((c2pa.match(/c2pa\.(created|edited|opened|placed|converted|drawing|color_adjustments|filtered|cropped|resized)/g) ?? []))];
    push({
      strength: 'declared',
      label: 'C2PA Content Credentials present',
      detail: `A signed provenance record${actions.length ? ` (actions: ${actions.join(', ')})` : ''}. Used by Adobe, OpenAI, Google, Microsoft, LinkedIn and Meta to track how an image was made.`,
    });
  }

  // The manifest itself can declare that a watermark was embedded in the pixels
  if (/c2pa\.watermarked|c2pa\.soft-binding/.test(all)) {
    push({
      strength: 'declared',
      label: 'Invisible watermark recorded',
      detail: 'The Content Credentials say an invisible watermark was added to the pixels. Removing metadata does not remove it.',
    });
  }

  // Stable Diffusion WebUI (A1111 / Forge) parameters
  if (/Steps: ?\d+.*Sampler:/s.test(all) || /Negative prompt:/.test(all)) {
    push({ strength: 'declared', label: 'Stable Diffusion generation parameters', detail: 'Prompt, seed, sampler and model settings saved by Automatic1111 / Forge.' });
  }
  const pngKeys = new Set(blocks.map((b) => b.key).filter(Boolean));
  if ((pngKeys.has('prompt') || pngKeys.has('workflow')) && /class_type/.test(all)) {
    push({ strength: 'declared', label: 'ComfyUI workflow', detail: 'The full node graph and prompt used to generate the image.' });
  }
  if (pngKeys.has('invokeai_metadata') || pngKeys.has('sd-metadata') || pngKeys.has('Dream')) {
    push({ strength: 'declared', label: 'InvokeAI generation data', detail: 'Prompt and settings saved by InvokeAI.' });
  }

  for (const [re, name] of GENERATORS) {
    const hit = texts.find((t) => re.test(t.s));
    if (!hit) continue;
    const m = hit.s.match(re);
    const at = m?.index ?? 0;
    const snippet = hit.s.slice(Math.max(0, at - 40), at + 60).replace(/[^\x20-\x7e]+/g, ' ').trim();
    push({ strength: 'mention', label: `Mentions ${name}`, detail: `“…${snippet}…”` });
  }

  return out;
}
