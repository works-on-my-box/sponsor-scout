// The sponsor-scouting agent: Gemini plans and writes, Qloo supplies the evidence.
// Every brand in the final shortlist must come from a Qloo result seen during the run;
// scores and ranks shown to the user are copied from Qloo, never from the model.
import {
  Env,
  BrandHit,
  AudienceProfile,
  audienceProfile,
  brandAffinities,
  searchBrands,
  isLikelyAdvertiser,
} from './qloo';
import { generate, parseJsonAnswer, GeminiContent, GeminiPart, GeminiUnavailable } from './gemini';

export interface ScoutInput {
  podcastId: string;
  podcastName: string;
  pastSponsors: string[];
  focus: string;
}

export interface Evidence {
  affinity: number;
  rank: number;
  of: number;
  // 'audience': rank among brands this show's audience over-indexes on; 'look-alike': rank in the list blended with past sponsors.
  list: 'audience' | 'look-alike';
  signals: string[];
  brandType: string[];
  businessModel: string[];
  industries: string[];
  keyMarkets: string[];
  targetAge: string[];
  site: string;
}

export interface SponsorPick {
  brandId: string;
  brand: string;
  category: string;
  why: string;
  pitchAngle: string;
  evidence: Evidence;
}

export interface ScoutResult {
  podcast: { id: string; name: string };
  audience: { summary: string; skews: string[] };
  picks: SponsorPick[];
  skipped: { brand: string; reason: string }[];
  mode: 'agent' | 'fallback';
  model?: string;
  notes: string[];
  // Set when a check that should have run did not (the result is shown but not cached).
  incomplete?: boolean;
}

export interface Step {
  tool: string;
  label: string;
  detail: string;
}

export type Emit = (event: 'step' | 'status', data: Step | { message: string }) => Promise<void> | void;

const AGE_LABELS: Record<string, string> = {
  '24_and_younger': 'under 25',
  '25_to_29': '25–29',
  '30_to_34': '30–34',
  '35_to_44': '35–44',
  '45_to_54': '45–54',
  '55_and_older': '55+',
};

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

export function describeAudience(p: AudienceProfile): { summary: string; skews: string[] } {
  const entries: [string, number][] = [
    ...Object.entries(p.age).map(([k, v]) => [AGE_LABELS[k] ?? k, Number(v)] as [string, number]),
    ...Object.entries(p.gender).map(([k, v]) => [k, Number(v)] as [string, number]),
  ].filter(([, v]) => Number.isFinite(v));
  const over = entries.filter(([, v]) => v >= 0.1).sort((a, b) => b[1] - a[1]);
  const under = entries.filter(([, v]) => v <= -0.1).sort((a, b) => a[1] - b[1]);
  const skews = [...over, ...under].map(([k, v]) => `${k} ${signed(v)}`);
  const parts: string[] = [];
  if (over.length) parts.push(`over-indexes on ${over.map(([k]) => k).join(', ')}`);
  if (under.length) parts.push(`under-indexes on ${under.map(([k]) => k).join(', ')}`);
  const summary = parts.length ? `Compared with the average Qloo audience, this show ${parts.join(' and ')}.` : 'Qloo shows no strong age or gender skew for this show.';
  return { summary, skews };
}

// Compact view of a brand for the model: enough to reason, small enough for the free tier.
function brandForModel(b: BrandHit, rank: number) {
  return {
    rank,
    brand_id: b.id,
    name: b.name,
    affinity: Math.round(b.affinity * 1000) / 1000,
    brand_type: b.brandType.slice(0, 2),
    business_model: b.businessModel.slice(0, 3),
    industries: b.industries.slice(0, 3),
    key_markets: b.keyMarkets.slice(0, 3),
    target_age: b.targetAge.slice(0, 3),
    audience_identity: b.audienceIdentity.slice(0, 140),
  };
}

const SYSTEM = `You are Sponsor Scout, an agent that builds a sponsor shortlist for one podcast from Qloo taste data.
Work in this order:
1. Call get_audience_profile once.
2. Call get_brand_affinities at least once. Past sponsors named by the host are added as look-alike signals and removed from the results automatically. If the host's focus names a category, you may call it again with industry_contains to dig into that category.
3. Call submit_shortlist with 6 to 10 picks.
Rules:
- Pick only brands returned by get_brand_affinities and copy their brand_id exactly.
- Leave out media brands, publishers and nonprofits: they sell attention or do not buy ads. advertisers_only=true does this for you.
- Prefer brands whose key markets and target age fit the audience profile and the host's focus. Respect any exclusions in the focus.
- "why": at most two sentences linking the brand to this audience with the evidence you saw (affinity, audience identity, markets, age). No invented facts or numbers, no claims about the brand's past sponsorships.
- "pitch_angle": one sentence on what the host could offer this brand in an ad read or a segment.
- Group picks into 2 to 4 short category names, such as "Developer tools" or "Privacy & security".
- Affinity is an aggregate signal about an audience, not a fact about any listener. Never call it a probability or a guarantee, and do not restate it as a percentage: the page already shows the score next to your text.
- Write in plain English.`;

const TOOLS = [
  {
    name: 'get_audience_profile',
    description: "Qloo demographics for the show's audience: age and gender over- and under-indexing compared with the average Qloo audience.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_brand_affinities',
    description:
      "Brands the show's audience over-indexes on, ranked by Qloo affinity (0 to 1). Optionally blend in extra taste signals (like_brands) and filter by industry.",
    parameters: {
      type: 'object',
      properties: {
        like_brands: { type: 'array', items: { type: 'string' }, description: "Brand names to add as extra taste signals, e.g. the show's past sponsors." },
        exclude_brands: { type: 'array', items: { type: 'string' }, description: 'Brand names to leave out, e.g. current sponsors.' },
        industry_contains: { type: 'string', description: "Keep only brands whose industries mention this word, e.g. 'Software' or 'Food'." },
        advertisers_only: { type: 'boolean', description: 'Drop media brands and nonprofits. Default true.' },
      },
    },
  },
  {
    name: 'submit_shortlist',
    description: 'Finish the run with the final sponsor shortlist.',
    parameters: {
      type: 'object',
      properties: {
        audience_summary: { type: 'string', description: 'One or two sentences on who listens, based on get_audience_profile.' },
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              brand_id: { type: 'string' },
              category: { type: 'string' },
              why: { type: 'string' },
              pitch_angle: { type: 'string' },
            },
            required: ['brand_id', 'category', 'why', 'pitch_angle'],
          },
        },
        skipped: {
          type: 'array',
          description: 'Up to four high-affinity brands you left out on purpose, with the reason.',
          items: {
            type: 'object',
            properties: { brand_name: { type: 'string' }, reason: { type: 'string' } },
            required: ['brand_name', 'reason'],
          },
        },
      },
      required: ['audience_summary', 'picks'],
    },
  },
];

interface Seen {
  brand: BrandHit;
  rank: number;
  of: number;
  list: 'audience' | 'look-alike';
  signals: string[];
}

interface RunState {
  seen: Map<string, Seen>;
  past?: { ids: string[]; found: string[]; missing: string[] };
  incomplete?: boolean;
  audience?: { summary: string; skews: string[] };
  podcastOnly?: BrandHit[];
  notes: string[];
}

function toEvidence(s: Seen): Evidence {
  const b = s.brand;
  return {
    affinity: Math.round(b.affinity * 1000) / 1000,
    rank: s.rank,
    of: s.of,
    list: s.list,
    signals: s.signals,
    brandType: b.brandType,
    businessModel: b.businessModel,
    industries: b.industries,
    keyMarkets: b.keyMarkets,
    targetAge: b.targetAge,
    site: b.site,
  };
}

export const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// Keeps only picks that point at brands Qloo actually returned in this run; drops duplicates.
export function validatePicks(raw: unknown, state: Pick<RunState, 'seen' | 'past'>): { picks: SponsorPick[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const banned = new Set(state.past?.ids ?? []);
  const picks: SponsorPick[] = [];
  const used = new Set<string>();
  let dropped = 0;
  for (const r of list as any[]) {
    const id = clip(r?.brand_id, 64);
    const seen = state.seen.get(id);
    if (!seen || used.has(id) || banned.has(id)) {
      dropped++;
      continue;
    }
    used.add(id);
    picks.push({
      brandId: id,
      brand: seen.brand.name,
      category: clip(r?.category, 40) || 'Other',
      why: clip(r?.why, 400),
      pitchAngle: clip(r?.pitch_angle, 240),
      evidence: toEvidence(seen),
    });
    if (picks.length === 10) break;
  }
  return { picks, dropped };
}

// Drops the picks the focus check says the host's focus excludes. A verdict counts only if it names a kind
// the check itself listed as excluded and points at a pick on the shortlist.
export function applyFocusCheck(picks: SponsorPick[], answer: unknown, focus: string) {
  const a = answer as any;
  const kinds = new Set((Array.isArray(a?.focus_excludes) ? a.focus_excludes : []).map((k: unknown) => clip(k, 80).toLowerCase()).filter(Boolean));
  const reasons = new Map<string, string>();
  for (const b of (Array.isArray(a?.brands) ? a.brands : []) as any[]) {
    const id = clip(b?.brand_id, 64);
    if (kinds.has(clip(b?.excluded_kind, 80).toLowerCase()) && !reasons.has(id) && picks.some((p) => p.brandId === id)) reasons.set(id, clip(b?.main_business, 80));
  }
  const removed = picks.filter((p) => reasons.has(p.brandId)).map((p) => ({ brand: p.brand, reason: reasons.get(p.brandId) ?? '' }));
  if (!removed.length) return { picks, removed, notes: [] as string[] };
  const kept = picks.filter((p) => !reasons.has(p.brandId));
  const notes = [`Removed ${removed.map((r) => r.brand).join(', ')}: your focus says “${focus}”.`];
  if (kept.length < 3) notes.push(`Picks left after applying your focus: ${kept.length} of ${picks.length}. Try a broader focus for a longer list.`);
  return { picks: kept, removed, notes };
}

// Per-brand verdicts, each grounded in what the brand sells: a plain "list the violators" answer over-flagged
// unrelated brands in tests. propertyOrdering makes the model write the grounding before the verdict.
const FOCUS_SCHEMA = {
  type: 'object',
  properties: {
    focus_excludes: { type: 'array', items: { type: 'string' } },
    brands: {
      type: 'array',
      items: {
        type: 'object',
        properties: { brand_id: { type: 'string' }, main_business: { type: 'string' }, excluded_kind: { type: 'string' } },
        required: ['brand_id', 'main_business', 'excluded_kind'],
        propertyOrdering: ['brand_id', 'main_business', 'excluded_kind'],
      },
    },
  },
  required: ['focus_excludes', 'brands'],
  propertyOrdering: ['focus_excludes', 'brands'],
};

// The focus check: one call, no tools, JSON output, temperature 0.
export const focusCheckRequest = (focus: string, picks: SponsorPick[]) => ({
  contents: [
    {
      role: 'user',
      parts: [
        {
          text: `A podcast host wants sponsor ideas and wrote this focus: "${focus}".
1. focus_excludes: the kinds of brands the focus explicitly asks to leave out, a few words each. "skip payments" leaves out payments companies, "no crypto" leaves out crypto companies, "avoid gambling" leaves out betting brands. Words such as "only", "prefer" or "more" say what the host wants more of and leave nothing out. Empty if the focus asks to leave nothing out.
2. brands: for every brand below, main_business in a few words (from the facts given and common knowledge), then excluded_kind: the item of focus_excludes that this main business is, copied exactly, or "" if it is none of them. A brand that is merely unrelated to the focus gets "".
Brands: ${JSON.stringify(picks.map((p) => ({ brand_id: p.brandId, name: p.brand, industries: p.evidence.industries.slice(0, 4), brand_type: p.evidence.brandType.slice(0, 2) })))}`,
        },
      ],
    },
  ],
  generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: FOCUS_SCHEMA },
});

// The agent sometimes keeps brands the host's focus rules out, so one tool-free call double-checks the picks.
// If that call fails, the picks stay as they are and no note is added.
async function respectFocus(env: Env, focus: string, picks: SponsorPick[], startAt: number, state: RunState, emit: Emit): Promise<SponsorPick[]> {
  let answer: unknown;
  try {
    answer = parseJsonAnswer((await generate(env, focusCheckRequest(focus, picks), startAt)).content);
  } catch (e) {
    console.error('focus check skipped', e instanceof Error ? e.message : e);
    state.incomplete = true;
    state.notes.push('The list could not be double-checked against your focus this time. Review it before you use it.');
    return picks;
  }
  const checked = applyFocusCheck(picks, answer, focus);
  state.notes.push(...checked.notes);
  const removed = checked.removed.map((r) => (r.reason ? `${r.brand} (${r.reason})` : r.brand));
  await emit('step', { tool: 'check_focus', label: 'Checked the picks against your focus', detail: removed.length ? `removed ${removed.join(', ')}` : 'nothing to remove' });
  return checked.picks;
}

// Deterministic shortlist used when the language model is unavailable: Qloo ranking plus brand facts.
export function fallbackPicks(brands: BrandHit[], n = 8): SponsorPick[] {
  const ads = brands.filter(isLikelyAdvertiser);
  return ads.slice(0, n).map((b) => ({
    brandId: b.id,
    brand: b.name,
    category: b.industries.find((i) => !/^technology$/i.test(i)) ?? b.industries[0] ?? 'Other',
    why: b.audienceIdentity ? `Qloo describes ${b.name}'s audience as: ${b.audienceIdentity}` : `${b.name} ranks high on Qloo affinity with this show's audience.`,
    pitchAngle: '',
    evidence: {
      affinity: Math.round(b.affinity * 1000) / 1000,
      rank: brands.indexOf(b) + 1,
      of: brands.length,
      list: 'audience',
      signals: ['audience'],
      brandType: b.brandType,
      businessModel: b.businessModel,
      industries: b.industries,
      keyMarkets: b.keyMarkets,
      targetAge: b.targetAge,
      site: b.site,
    },
  }));
}

function merge(a: { ids: string[]; found: string[]; missing: string[] }, b: { ids: string[]; found: string[]; missing: string[] }) {
  const ids = [...new Set([...a.ids, ...b.ids])];
  return { ids, found: [...new Set([...a.found, ...b.found])], missing: [...new Set([...a.missing, ...b.missing])] };
}

async function resolveBrands(env: Env, names: unknown): Promise<{ ids: string[]; found: string[]; missing: string[] }> {
  const list = (Array.isArray(names) ? names : []).map((n) => clip(n, 60)).filter(Boolean).slice(0, 4);
  const ids: string[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  for (const name of list) {
    const hit = (await searchBrands(env, name))[0];
    if (hit) {
      ids.push(hit.id);
      found.push(hit.name);
    } else missing.push(name);
  }
  return { ids, found, missing };
}

async function runTool(env: Env, input: ScoutInput, state: RunState, name: string, args: Record<string, unknown>, emit: Emit): Promise<unknown> {
  if (name === 'get_audience_profile') {
    const profile = await audienceProfile(env, input.podcastId);
    state.audience = describeAudience(profile);
    await emit('step', { tool: name, label: 'Read the audience profile', detail: state.audience.skews.join(' · ') || 'no strong skew' });
    return { ...state.audience, raw: profile };
  }
  if (name === 'get_brand_affinities') {
    // Past sponsors named by the host always act as look-alike signals and never come back as results.
    state.past ??= await resolveBrands(env, input.pastSponsors);
    const extraLike = await resolveBrands(env, args.like_brands);
    const extraExclude = await resolveBrands(env, args.exclude_brands);
    const like = merge(state.past, extraLike);
    const exclude = merge(state.past, extraExclude);
    // The audience-only ranking is the evidence shown to users, so fetch it once even if the model starts with look-alikes.
    if (!state.podcastOnly) {
      state.podcastOnly = await brandAffinities(env, { podcastId: input.podcastId, take: 50 });
      state.podcastOnly.forEach((b, i) => state.seen.set(b.id, { brand: b, rank: i + 1, of: state.podcastOnly!.length, list: 'audience', signals: ['audience'] }));
    }
    const brands = (
      like.ids.length || exclude.ids.length
        ? await brandAffinities(env, { podcastId: input.podcastId, likeBrandIds: like.ids, excludeIds: exclude.ids, take: 50 })
        : state.podcastOnly
    ).filter((b) => !exclude.ids.includes(b.id));
    const signals = ['audience', ...like.found.map((n) => `like ${n}`)];
    const advertisersOnly = args.advertisers_only !== false;
    const word = clip(args.industry_contains, 40).toLowerCase();
    let kept = advertisersOnly ? brands.filter(isLikelyAdvertiser) : brands;
    const setAside = brands.length - kept.length;
    if (word) kept = kept.filter((b) => b.industries.some((i) => i.toLowerCase().includes(word)));
    brands.forEach((b, i) => {
      const prev = state.seen.get(b.id);
      if (!prev) state.seen.set(b.id, { brand: b, rank: i + 1, of: brands.length, list: like.ids.length ? 'look-alike' : 'audience', signals });
      else for (const sig of signals) if (!prev.signals.includes(sig)) prev.signals.push(sig);
    });
    const label = like.found.length ? `Found look-alikes of ${like.found.join(', ')}` : 'Pulled brand affinities from Qloo';
    const bits = [`${brands.length} brands`];
    if (advertisersOnly) bits.push(`${setAside} media or nonprofit set aside`);
    if (word) bits.push(`${kept.length} in "${word}"`);
    if (like.missing.length) bits.push(`not in Qloo: ${like.missing.join(', ')}`);
    await emit('step', { tool: name, label, detail: bits.join(' · ') });
    return {
      signals,
      not_found_in_qloo: [...like.missing, ...exclude.missing],
      returned: brands.length,
      kept: kept.length,
      brands: kept.slice(0, 25).map((b) => brandForModel(b, brands.indexOf(b) + 1)),
    };
  }
  return { error: `unknown tool ${name}` };
}

export async function runScout(env: Env, input: ScoutInput, emit: Emit): Promise<ScoutResult> {
  const state: RunState = { seen: new Map(), notes: [] };
  const podcast = { id: input.podcastId, name: input.podcastName };
  const userText = [
    `Podcast: ${input.podcastName} (Qloo id ${input.podcastId}).`,
    input.pastSponsors.length ? `Past or current sponsors named by the host: ${input.pastSponsors.join(', ')}.` : 'The host named no past sponsors.',
    input.focus ? `Host's focus: ${input.focus}` : 'The host gave no extra focus.',
  ].join('\n');
  const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: userText }] }];
  let modelIndex = 0;
  let model = '';
  try {
    for (let turn = 0; turn < 7; turn++) {
      const r = await generate(
        env,
        {
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          tools: [{ functionDeclarations: TOOLS }],
          toolConfig: { functionCallingConfig: { mode: 'ANY' } },
          generationConfig: { temperature: 0.4 },
        },
        modelIndex,
        turn > 0, // once a conversation has started, stay on the same model: thought signatures are model-specific
      );
      modelIndex = r.modelIndex;
      model = r.model;
      contents.push(r.content);
      const calls = r.content.parts.filter((p) => !!p.functionCall);
      if (!calls.length) {
        contents.push({ role: 'user', parts: [{ text: 'Use the tools. Finish with submit_shortlist.' }] });
        continue;
      }
      const responses: GeminiPart[] = [];
      for (const c of calls) {
        const fc = c.functionCall!;
        const args = (fc.args ?? {}) as Record<string, unknown>;
        if (fc.name === 'submit_shortlist') {
          const { picks, dropped } = validatePicks(args.picks, state);
          if (dropped) state.notes.push(`${dropped} pick(s) from the model were dropped because Qloo did not return them in this run.`);
          if (picks.length >= 3) {
            await emit('step', { tool: fc.name, label: 'Wrote the shortlist', detail: `${picks.length} sponsors in ${new Set(picks.map((p) => p.category)).size} categories` });
            const final = input.focus ? await respectFocus(env, input.focus, picks, modelIndex, state, emit) : picks;
            const skipped = (Array.isArray(args.skipped) ? args.skipped : [])
              .slice(0, 4)
              .map((s: any) => ({ brand: clip(s?.brand_name, 60), reason: clip(s?.reason, 200) }))
              .filter((s) => s.brand && s.reason);
            return {
              podcast,
              audience: state.audience ?? { summary: clip(args.audience_summary, 400), skews: [] },
              picks: final,
              skipped,
              mode: 'agent',
              model,
              notes: state.notes,
              incomplete: state.incomplete,
            };
          }
          responses.push({ functionResponse: { name: fc.name, id: fc.id, response: { error: 'Fewer than 3 picks matched brands returned by get_brand_affinities. Use brand_id values from those results.' } } });
          continue;
        }
        const out = await runTool(env, input, state, fc.name, args, emit);
        responses.push({ functionResponse: { name: fc.name, id: fc.id, response: { result: out } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    state.notes.push('The agent did not finish within its step budget, so the list below is the plain Qloo ranking.');
  } catch (e) {
    if (!(e instanceof GeminiUnavailable)) throw e;
    state.notes.push('The language model is over its free quota right now, so the list below is the plain Qloo ranking without written reasons.');
  }
  return fallback(env, input, state, emit);
}


async function fallback(env: Env, input: ScoutInput, state: RunState, emit: Emit): Promise<ScoutResult> {
  if (!state.audience) state.audience = describeAudience(await audienceProfile(env, input.podcastId));
  state.past ??= await resolveBrands(env, input.pastSponsors);
  const banned = new Set(state.past.ids);
  const brands = (state.podcastOnly ?? (await brandAffinities(env, { podcastId: input.podcastId, take: 50 }))).filter((b) => !banned.has(b.id));
  await emit('step', { tool: 'fallback', label: 'Ranked brands without the language model', detail: `${brands.length} brands from Qloo, media and nonprofits set aside` });
  return {
    podcast: { id: input.podcastId, name: input.podcastName },
    audience: state.audience,
    picks: fallbackPicks(brands),
    skipped: [],
    mode: 'fallback',
    notes: state.notes,
  };
}
