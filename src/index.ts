// Worker entry: static UI from ./public, JSON and server-sent-event API under /api.
import { Env, searchPodcasts, QlooError } from './qloo';
import { runScout, ScoutInput, ScoutResult, Step } from './agent';

const RESULT_TTL_SECONDS = 24 * 3600;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export function parseInput(body: any): ScoutInput | { error: string } {
  const podcastId = typeof body?.podcastId === 'string' ? body.podcastId.trim() : '';
  if (!/^[0-9A-Fa-f-]{36}$/.test(podcastId)) return { error: 'Pick a podcast from the search results first.' };
  const podcastName = typeof body?.podcastName === 'string' ? body.podcastName.trim().slice(0, 120) : '';
  const pastSponsors = (Array.isArray(body?.pastSponsors) ? body.pastSponsors : [])
    .filter((x: unknown) => typeof x === 'string')
    .map((x: string) => x.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 3);
  const focus = typeof body?.focus === 'string' ? body.focus.trim().slice(0, 200) : '';
  return { podcastId, podcastName: podcastName || 'this podcast', pastSponsors, focus };
}

async function cacheKey(input: ScoutInput): Promise<string> {
  const norm = JSON.stringify([input.podcastId, input.pastSponsors.map((s) => s.toLowerCase()).sort(), input.focus.toLowerCase()]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return 'run:' + [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function publicMessage(e: unknown): string {
  if (e instanceof QlooError) return e.status === 429 ? 'Qloo is rate-limiting requests right now. Try again in a minute.' : 'Qloo did not answer. Try again in a minute.';
  return 'Something went wrong on our side. Try again in a minute.';
}

function scout(req: Request, env: Env, ctx: ExecutionContext, body: unknown): Response {
  const input = parseInput(body);
  if ('error' in input) return json(input, 400);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  ctx.waitUntil(
    (async () => {
      try {
        const key = await cacheKey(input);
        const cached = env.CACHE ? await env.CACHE.get<{ steps: Step[]; result: ScoutResult }>(key, 'json') : null;
        if (cached) {
          await send('status', { message: 'Same request in the last 24 hours: replaying the saved run.' });
          for (const s of cached.steps) await send('step', s);
          await send('result', cached.result);
          return;
        }
        const steps: Step[] = [];
        const result = await runScout(env, input, async (event, data) => {
          if (event === 'step') steps.push(data as Step);
          await send(event, data);
        });
        await send('result', result);
        if (env.CACHE && result.mode === 'agent') await env.CACHE.put(key, JSON.stringify({ steps, result }), { expirationTtl: RESULT_TTL_SECONDS });
      } catch (e) {
        console.error('scout failed', e instanceof Error ? e.message : e);
        await send('error', { message: publicMessage(e) });
      } finally {
        await writer.close();
      }
    })(),
  );
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/health') return json({ ok: true });
    if (url.pathname === '/api/podcasts' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
      if (q.length < 2) return json({ results: [] });
      try {
        return json({ results: await searchPodcasts(env, q) });
      } catch (e) {
        return json({ error: publicMessage(e) }, 502);
      }
    }
    if (url.pathname === '/api/scout' && req.method === 'POST') {
      // Each run spends free-tier model quota, so keep one visitor from draining it.
      const ip = req.headers.get('cf-connecting-ip') ?? 'local';
      if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success)
        return json({ error: 'Too many runs from your address. Wait a minute and try again.' }, 429);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Send JSON.' }, 400);
      }
      return scout(req, env, ctx, body);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
