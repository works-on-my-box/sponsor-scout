// Unit tests on synthetic data only: Qloo responses must not be stored in this repository.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapBrand, isLikelyAdvertiser, BrandHit } from '../src/qloo';
import { describeAudience, validatePicks, fallbackPicks, applyFocusCheck, focusCheckRequest, withoutPicked } from '../src/agent';
import { parseJsonAnswer } from '../src/gemini';
import { cleanGuesses } from '../src/baseline';
import worker, { parseInput } from '../src/index';

const raw = (name: string, id: string, affinity: number, brandType: string[], model: string[] = ['B2C']) => ({
  name,
  entity_id: id,
  popularity: 0.5,
  query: { affinity, explainability: { 'signal.interests.entities': [{ entity_id: 'P1', score: 1 }] } },
  properties: { brand_type: brandType, business_model: model, industries: ['Technology', 'Gadgets'], key_markets: ['Global'], audience_identity: 'Tinkerers.' },
});

const brands: BrandHit[] = [
  mapBrand(raw('Daily Gazette', 'B1', 0.99, ['Media Brand'], ['Advertising'])),
  mapBrand(raw('Acme Tools', 'B2', 0.97, ['Corporate Brand'])),
  mapBrand(raw('Open Charity', 'B3', 0.95, ['Nonprofit Brand'], ['Nonprofit'])),
  mapBrand(raw('Widget Co', 'B4', 0.93, ['Service Brand'], ['Subscription'])),
];

describe('mapBrand', () => {
  it('keeps the fields the agent reasons about', () => {
    const b = brands[1];
    expect(b).toMatchObject({ id: 'B2', name: 'Acme Tools', affinity: 0.97, brandType: ['Corporate Brand'], keyMarkets: ['Global'] });
    expect(b.drivers).toEqual({ P1: 1 });
  });
  it('survives missing properties', () => {
    expect(mapBrand({ name: 'X', entity_id: 'X1' })).toMatchObject({ affinity: 0, industries: [], site: '' });
  });
});

describe('isLikelyAdvertiser', () => {
  it('drops media brands and nonprofits', () => {
    expect(brands.filter(isLikelyAdvertiser).map((b) => b.id)).toEqual(['B2', 'B4']);
  });
});

describe('describeAudience', () => {
  it('lists over- and under-indexing groups, strongest first', () => {
    const a = describeAudience({ age: { '30_to_34': 0.44, '55_and_older': -0.47, '25_to_29': 0.05 }, gender: { male: 0.76, female: -0.76 } });
    expect(a.skews).toEqual(['male +0.76', '30–34 +0.44', 'female −0.76', '55+ −0.47']);
    expect(a.summary).toContain('over-indexes on male, 30–34');
  });
  it('says so when there is no skew', () => {
    expect(describeAudience({ age: {}, gender: {} }).summary).toMatch(/no strong/);
  });
});

describe('validatePicks', () => {
  const seen = new Map(brands.map((b, i) => [b.id, { brand: b, rank: i + 1, of: brands.length, list: 'audience' as const, signals: ['audience'] }]));
  it('keeps only brands Qloo returned, once each, and never past sponsors', () => {
    const { picks, dropped } = validatePicks(
      [
        { brand_id: 'B2', category: 'Tools', why: 'w', pitch_angle: 'p' },
        { brand_id: 'B2', category: 'Tools', why: 'dup', pitch_angle: 'p' },
        { brand_id: 'INVENTED', category: 'Tools', why: 'w', pitch_angle: 'p' },
        { brand_id: 'B4', category: '', why: 'w', pitch_angle: 'p' },
      ],
      { seen, past: { ids: ['B4'], found: ['Widget Co'], missing: [] } },
    );
    expect(picks.map((p) => p.brandId)).toEqual(['B2']);
    expect(dropped).toBe(3);
    expect(picks[0].evidence).toMatchObject({ affinity: 0.97, rank: 2, of: 4 });
  });
  it('fills a missing category', () => {
    const { picks } = validatePicks([{ brand_id: 'B2', why: 'w', pitch_angle: 'p' }], { seen });
    expect(picks[0].category).toBe('Other');
  });
});

describe('withoutPicked', () => {
  it('drops a "left out" brand that is also on the shortlist', () => {
    const picks = fallbackPicks(brands, 5);
    const skipped = [
      { brand: 'acme tools', reason: 'Included under Gadgets instead.' },
      { brand: 'Other Co', reason: 'Too small.' },
    ];
    expect(withoutPicked(skipped, picks).map((s) => s.brand)).toEqual(['Other Co']);
  });
});

describe('fallbackPicks', () => {
  it('ranks advertisers by Qloo order with real ranks', () => {
    const picks = fallbackPicks(brands, 5);
    expect(picks.map((p) => [p.brand, p.evidence.rank])).toEqual([
      ['Acme Tools', 2],
      ['Widget Co', 4],
    ]);
    expect(picks[0].category).toBe('Gadgets');
  });
});

describe('parseInput', () => {
  it('requires a podcast id from search', () => {
    expect(parseInput({ podcastName: 'x' })).toHaveProperty('error');
  });
  it('trims and caps the optional fields', () => {
    const r = parseInput({ podcastId: 'F51DE9CB-BC83-4505-8252-29B9E99E6198', podcastName: ' Show ', pastSponsors: ['a', ' b ', 'c', 'd', 5], focus: 'x'.repeat(500) });
    expect(r).toMatchObject({ podcastName: 'Show', pastSponsors: ['a', 'b', 'c'] });
    expect((r as { focus: string }).focus.length).toBe(200);
  });
});

describe('applyFocusCheck', () => {
  const seen = new Map(brands.map((b, i) => [b.id, { brand: b, rank: i + 1, of: brands.length, list: 'audience' as const, signals: ['audience'] }]));
  const { picks } = validatePicks(['B1', 'B2', 'B3', 'B4'].map((id) => ({ brand_id: id, category: 'C', why: 'w', pitch_angle: 'p' })), { seen });
  const verdict = (brand_id: unknown, excluded_kind: string, main_business = 'stuff') => ({ brand_id, main_business, excluded_kind });
  it('drops picks of an excluded kind and tells the host why', () => {
    const answer = { focus_excludes: ['tool makers'], brands: [verdict('B2', 'Tool Makers', 'hand tools'), verdict('B2', 'tool makers', 'again'), verdict('INVENTED', 'tool makers'), verdict('B4', ''), 'junk', null] };
    const r = applyFocusCheck(picks, answer, 'skip tools');
    expect(r.picks.map((p) => p.brandId)).toEqual(['B1', 'B3', 'B4']);
    expect(r.removed).toEqual([{ brand: 'Acme Tools', reason: 'hand tools' }]);
    expect(r.notes).toEqual(['Removed Acme Tools: your focus says “skip tools”.']);
  });
  it('ignores verdicts that name a kind the check did not list as excluded', () => {
    expect(applyFocusCheck(picks, { focus_excludes: ['crypto'], brands: [verdict('B1', 'payments')] }, 'no crypto').picks).toBe(picks);
    expect(applyFocusCheck(picks, { focus_excludes: [], brands: [verdict('B1', 'payments')] }, 'prefer tools').picks).toBe(picks);
  });
  it('keeps the result but says so when fewer than 3 picks are left', () => {
    const r = applyFocusCheck(picks, { focus_excludes: ['news', 'gadgets'], brands: [verdict('B1', 'news'), verdict('B4', 'gadgets')] }, 'no news or gadgets');
    expect(r.picks.map((p) => p.brandId)).toEqual(['B2', 'B3']);
    expect(r.notes).toEqual(['Removed Daily Gazette, Widget Co: your focus says “no news or gadgets”.', 'Picks left after applying your focus: 2 of 4. Try a broader focus for a longer list.']);
  });
  it('changes nothing when the answer is malformed', () => {
    for (const a of [undefined, {}, 'B2', { focus_excludes: 'tools', brands: [verdict('B2', 'tools')] }]) expect(applyFocusCheck(picks, a, 'x')).toEqual({ picks, removed: [], notes: [] });
  });
  it('asks once, without tools, for JSON at temperature 0, with the focus and the pick ids', () => {
    const req = focusCheckRequest('skip payments', picks) as Record<string, any>;
    expect(req.tools).toBeUndefined();
    expect(req.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json' });
    expect(req.generationConfig.responseSchema.propertyOrdering).toEqual(['focus_excludes', 'brands']);
    const text: string = req.contents[0].parts[0].text;
    expect(text).toContain('"skip payments"');
    for (const id of ['B1', 'B2', 'B3', 'B4']) expect(text).toContain(`"brand_id":"${id}"`);
  });
});

describe('parseJsonAnswer', () => {
  it('joins the text parts and skips thoughts', () => {
    expect(parseJsonAnswer({ role: 'model', parts: [{ text: 'thinking', thought: true }, { text: '{"a":' }, { text: '1}' }] })).toEqual({ a: 1 });
  });
  it('throws on text that is not JSON', () => {
    expect(() => parseJsonAnswer({ role: 'model', parts: [{ text: 'Sure! Here is' }] })).toThrow();
  });
});

describe('cleanGuesses', () => {
  it('keeps up to eight named brands, each once', () => {
    const sponsors = [{ brand: ' Acme ', reason: ' r ' }, { brand: 'ACME', reason: 'dup' }, { brand: '', reason: 'x' }, { reason: 'no brand' }];
    for (let i = 0; i < 10; i++) sponsors.push({ brand: `Brand ${i}`, reason: 'r' });
    const g = cleanGuesses({ sponsors });
    expect(g).toHaveLength(8);
    expect(g[0]).toEqual({ brand: 'Acme', reason: 'r' });
    expect(g[1].brand).toBe('Brand 0');
  });
  it('survives a malformed answer', () => {
    expect(cleanGuesses(null)).toEqual([]);
    expect(cleanGuesses({ sponsors: 'none' })).toEqual([]);
  });
});

describe('POST /api/baseline', () => {
  const kv = () => {
    const store = new Map<string, string>();
    return { store, get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null), put: async (k: string, v: string, _opts?: unknown) => void store.set(k, v) };
  };
  const call = (env: unknown, body: unknown) =>
    worker.fetch(new Request('http://local/api/baseline', { method: 'POST', body: JSON.stringify(body) }), env as any, {} as ExecutionContext);
  afterEach(() => vi.restoreAllMocks());

  it('asks the model once, without tools, for JSON, and caches the answer for a day', async () => {
    const answer = { sponsors: [{ brand: 'Acme Tools', reason: 'Tinkerers like it.' }] };
    const gemini = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })));
    const cache = kv();
    const put = vi.spyOn(cache, 'put');
    const env = { GEMINI_API_KEY: 'k', CACHE: cache };
    const res = await call(env, { podcastName: ' My Show ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ podcast: 'My Show', sponsors: answer.sponsors });
    const sent = JSON.parse(String(gemini.mock.calls[0][1]?.body));
    expect(sent.tools).toBeUndefined();
    expect(sent.generationConfig.responseMimeType).toBe('application/json');
    expect(sent.generationConfig.responseSchema.properties.sponsors.type).toBe('array');
    expect(put.mock.calls[0][0]).toBe('base:my show');
    expect(put.mock.calls[0][2]).toEqual({ expirationTtl: 24 * 3600 });
    expect((await call(env, { podcastName: 'MY SHOW' })).status).toBe(200);
    expect(gemini).toHaveBeenCalledTimes(1);
  });

  it('says so clearly when the model is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gemini = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 429 }));
    const res = await call({ GEMINI_API_KEY: 'k' }, { podcastName: 'My Show' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/not available right now/);
    expect(gemini).toHaveBeenCalledTimes(2); // both models in the fallback chain
  });

  it('needs a podcast name', async () => {
    expect((await call({}, {})).status).toBe(400);
  });
});
