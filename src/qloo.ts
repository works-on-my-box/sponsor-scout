// Thin client for the Qloo Insights API (hackathon gateway) plus compact mappers.
// Responses are cached privately in Workers KV; nothing from Qloo is stored in the repository.

export interface Env {
  QLOO_API_KEY: string;
  QLOO_BASE_URL?: string;
  GEMINI_API_KEY: string;
  CACHE?: KVNamespace;
  LIMITER?: RateLimit;
  ASSETS: Fetcher;
}

const DEFAULT_BASE = 'https://hackathon.api.qloo.com';
const QLOO_TTL_SECONDS = 7 * 24 * 3600;

export class QlooError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

export async function qlooGet(env: Env, path: string, params: Params): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  const cacheKey = `qloo:${path}?${query}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, 'json');
    if (hit) return hit;
  }
  const url = `${env.QLOO_BASE_URL || DEFAULT_BASE}${path}?${query}`;
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, { headers: { 'x-api-key': env.QLOO_API_KEY, accept: 'application/json' } });
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  if (!res || !res.ok) throw new QlooError(res?.status ?? 0, `Qloo ${path} returned HTTP ${res?.status}`);
  const data = await res.json();
  if (env.CACHE) await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: QLOO_TTL_SECONDS });
  return data;
}

export interface PodcastHit {
  id: string;
  name: string;
  popularity: number;
  tags: string[];
}

export interface BrandHit {
  id: string;
  name: string;
  affinity: number;
  popularity: number;
  brandType: string[];
  businessModel: string[];
  industries: string[];
  targetAge: string[];
  targetGender: string[];
  keyMarkets: string[];
  audienceIdentity: string;
  site: string;
  // Share of the recommendation explained by each input signal (Qloo explainability), keyed by entity id.
  drivers: Record<string, number>;
}

export interface AudienceProfile {
  age: Record<string, number>;
  gender: Record<string, number>;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function mapPodcast(e: any): PodcastHit {
  return {
    id: String(e?.entity_id ?? ''),
    name: String(e?.name ?? ''),
    popularity: num(e?.popularity),
    tags: (Array.isArray(e?.tags) ? e.tags : []).map((t: any) => String(t?.name ?? '')).filter(Boolean).slice(0, 8),
  };
}

export function mapBrand(e: any): BrandHit {
  const p = e?.properties ?? {};
  return {
    id: String(e?.entity_id ?? ''),
    name: String(e?.name ?? ''),
    affinity: num(e?.query?.affinity),
    popularity: num(e?.popularity),
    brandType: arr(p.brand_type),
    businessModel: arr(p.business_model),
    industries: arr(p.industries),
    targetAge: arr(p.target_age_group),
    targetGender: arr(p.target_gender),
    keyMarkets: arr(p.key_markets),
    audienceIdentity: typeof p.audience_identity === 'string' ? p.audience_identity.slice(0, 220) : '',
    site: typeof p.official_site === 'string' ? p.official_site : '',
    drivers: Object.fromEntries(
      (Array.isArray(e?.query?.explainability?.['signal.interests.entities']) ? e.query.explainability['signal.interests.entities'] : [])
        .filter((x: any) => x?.entity_id)
        .map((x: any): [string, number] => [String(x.entity_id), num(x.score)]),
    ),
  };
}

// Brands that sell ad inventory or do not buy ads compete with the podcast rather than sponsor it.
export function isLikelyAdvertiser(b: BrandHit): boolean {
  const types = b.brandType.join(' ').toLowerCase();
  const models = b.businessModel.join(' ').toLowerCase();
  if (/media brand|nonprofit/.test(types)) return false;
  if (/nonprofit/.test(models)) return false;
  return true;
}

export async function searchPodcasts(env: Env, name: string): Promise<PodcastHit[]> {
  const d = await qlooGet(env, '/search', { query: name, types: 'urn:entity:podcast', take: 6 });
  return (Array.isArray(d?.results) ? d.results : []).map(mapPodcast).filter((p: PodcastHit) => p.id && p.name);
}

export async function searchBrands(env: Env, name: string): Promise<{ id: string; name: string }[]> {
  const d = await qlooGet(env, '/search', { query: name, types: 'urn:entity:brand', take: 3 });
  return (Array.isArray(d?.results) ? d.results : [])
    .map((e: any) => ({ id: String(e?.entity_id ?? ''), name: String(e?.name ?? '') }))
    .filter((b: { id: string }) => b.id);
}

export async function audienceProfile(env: Env, podcastId: string): Promise<AudienceProfile> {
  const d = await qlooGet(env, '/v2/insights', { 'filter.type': 'urn:demographics', 'signal.interests.entities': podcastId });
  const q = d?.results?.demographics?.[0]?.query ?? {};
  return { age: q.age ?? {}, gender: q.gender ?? {} };
}

export interface AffinityQuery {
  podcastId: string;
  likeBrandIds?: string[];
  excludeIds?: string[];
  take?: number;
}

export async function brandAffinities(env: Env, q: AffinityQuery): Promise<BrandHit[]> {
  const signal = [q.podcastId, ...(q.likeBrandIds ?? [])].filter(Boolean).join(',');
  const d = await qlooGet(env, '/v2/insights', {
    'filter.type': 'urn:entity:brand',
    'signal.interests.entities': signal,
    'filter.exclude.entities': q.excludeIds?.length ? q.excludeIds.join(',') : undefined,
    take: Math.min(Math.max(q.take ?? 50, 5), 50),
    'feature.explainability': true,
  });
  return (Array.isArray(d?.results?.entities) ? d.results.entities : []).map(mapBrand).filter((b: BrandHit) => b.id && b.name);
}
