// Minimal Gemini REST client with a model fallback chain for the free tier.
import type { Env } from './qloo';

// Free-tier limits checked on 2026-10-15: both Flash-Lite models allow 15 RPM and 500 requests/day each.
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: unknown };
  thoughtSignature?: string;
  thought?: boolean;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export class GeminiUnavailable extends Error {}

export interface GenerateResult {
  model: string;
  modelIndex: number;
  content: GeminiContent;
}

export async function generate(env: Env, body: Record<string, unknown>, startAt = 0, onlyModel = false): Promise<GenerateResult> {
  let last = '';
  const end = onlyModel ? startAt + 1 : MODELS.length;
  for (let i = startAt; i < end; i++) {
    const model = MODELS[i];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      last = `${model}: HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      // Gemini refuses some regions outright; treat that like an outage so the run falls back to the Qloo ranking.
      if (res.status === 400 && /location is not supported/i.test(text)) throw new GeminiUnavailable(`${model}: region not supported`);
      throw new Error(`Gemini ${model} HTTP ${res.status}: ${text}`);
    }
    const data: any = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      last = `${model}: empty answer (${data?.candidates?.[0]?.finishReason ?? 'no candidate'})`;
      continue;
    }
    return { model, modelIndex: i, content: { role: 'model', parts } };
  }
  throw new GeminiUnavailable(last || 'no model available');
}

// Parses a JSON-mode answer (responseMimeType application/json); thought parts are skipped.
export function parseJsonAnswer(content: GeminiContent): unknown {
  return JSON.parse(content.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(''));
}
