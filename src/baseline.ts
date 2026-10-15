// The "without Qloo" baseline: the same model names likely sponsors from the show's name alone.
// The page shows it next to the Qloo-backed shortlist, so the difference Qloo makes is visible.
import type { Env } from './qloo';
import { generate, parseJsonAnswer } from './gemini';
import { clip } from './agent';

export interface Guess {
  brand: string;
  reason: string;
}

export interface Baseline {
  podcast: string;
  model: string;
  sponsors: Guess[];
}

const GUESS_SCHEMA = {
  type: 'object',
  properties: {
    sponsors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { brand: { type: 'string' }, reason: { type: 'string' } },
        required: ['brand', 'reason'],
      },
    },
  },
  required: ['sponsors'],
};

// Keeps up to n named guesses, each brand once.
export function cleanGuesses(data: unknown, n = 8): Guess[] {
  const list: any[] = Array.isArray((data as any)?.sponsors) ? (data as any).sponsors : [];
  const used = new Set<string>();
  const out: Guess[] = [];
  for (const g of list) {
    const brand = clip(g?.brand, 60);
    if (!brand || used.has(brand.toLowerCase())) continue;
    used.add(brand.toLowerCase());
    out.push({ brand, reason: clip(g?.reason, 200) });
    if (out.length === n) break;
  }
  return out;
}

// One model call, no tools and no Qloo data: what a host would get by asking a chatbot.
export async function guessSponsors(env: Env, podcastName: string): Promise<Baseline> {
  const prompt = `Name 8 brands likely to sponsor the podcast "${podcastName}": advertisers, not media companies or nonprofits. Give a one-line reason for each.`;
  const r = await generate(env, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json', responseSchema: GUESS_SCHEMA },
  });
  const sponsors = cleanGuesses(parseJsonAnswer(r.content));
  if (!sponsors.length) throw new Error(`${r.model}: no usable guesses`);
  return { podcast: podcastName, model: r.model, sponsors };
}
