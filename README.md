# Sponsor Scout

**Find brand sponsors whose customers already listen to your podcast.**

Live demo: https://sponsor-scout.naryzhnykh.workers.dev

Independent podcasters usually pitch sponsors by guesswork: they copy the ad roster of bigger shows or email whoever comes to mind. Sponsor Scout starts from the audience instead. It asks Qloo which brands the listeners of a given show over-index on, sets aside brands that sell attention rather than buy it (media, publishers, nonprofits), and lets an agent turn that evidence into a short, categorized shortlist with a reason and a pitch angle for each brand.

## How it works

```
show name ──► Qloo /search (podcast) ──► host picks the right show
                                             │
                                             ▼
                      ┌──────────── agent loop (Gemini, function calling) ────────────┐
                      │ get_audience_profile  → Qloo /v2/insights (urn:demographics)  │
                      │ get_brand_affinities  → Qloo /v2/insights (urn:entity:brand)  │
                      │                         + past sponsors as look-alike signals │
                      │ submit_shortlist      → picks are checked against Qloo data   │
                      └───────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
                 shortlist grouped by category, each card with Qloo evidence
```

1. **Pick the show.** The search box calls Qloo `/search` with `types=urn:entity:podcast`, and the host chooses the exact show. Many shows share words in their names, so the agent never guesses the entity.
2. **Read the audience.** `get_audience_profile` calls `/v2/insights` with `filter.type=urn:demographics` and `signal.interests.entities=<show>`. The answer is how the audience over- or under-indexes on age groups and gender compared with the average Qloo audience.
3. **Find brands the audience likes.** `get_brand_affinities` calls `/v2/insights` with `filter.type=urn:entity:brand`, the show as the signal, `take=50` and `feature.explainability=true`. If the host names past sponsors, they are resolved with `/search` (`types=urn:entity:brand`), added as extra signals to find look-alike advertisers, and excluded from the results with `filter.exclude.entities`. The tool drops brands whose Qloo `brand_type` is a media or nonprofit brand, and can narrow the list by industry.
4. **Write the shortlist.** The agent calls `submit_shortlist` with 6 to 10 picks: brand id, category, why, pitch angle. The server keeps only picks whose ids Qloo returned during this run, removes past sponsors and duplicates, and attaches the evidence itself: affinity, rank, brand type, business model, key markets and target age come from Qloo, never from the model.
5. **Show the run.** The page streams each agent step as it happens (server-sent events), then renders the shortlist. Each card can copy a short outreach note.

If the language model is unavailable (free-tier quota, regional restriction), the run still finishes: the shortlist becomes the plain Qloo ranking of likely advertisers, without written reasons, and the page says so.

### Example: request to result (redacted)

Input: the show *Syntax - Tasty Web Development Treats*, past sponsor *DigitalOcean*.

| Step | Request | What came back |
| --- | --- | --- |
| Audience | `GET /v2/insights?filter.type=urn:demographics&signal.interests.entities=<show>` | over-indexes on men and on ages 30–34; under-indexes on 55+ |
| Brands | `GET /v2/insights?filter.type=urn:entity:brand&signal.interests.entities=<show>,<DigitalOcean>&filter.exclude.entities=<DigitalOcean>&take=50&feature.explainability=true` | 50 brands; 17 media or nonprofit brands set aside |
| Shortlist | `submit_shortlist` | developer platforms (GitHub, GitLab, Docker, JetBrains), data and payments infrastructure (MongoDB, Stripe), privacy tools (ProtonMail, DuckDuckGo) |

Results change as Qloo data changes; the table describes one run on 2026-10-15.

## What makes it Qloo-powered

Without Qloo the model can only recall brands that sponsor famous shows. With Qloo the agent works from measured audience overlap: it sees which brands this specific audience over-indexes on, how strongly, and what Qloo knows about each brand (type, business model, markets, target age). Every brand on the shortlist is one Qloo returned for this show, and the numbers on each card are Qloo's.

## Run it yourself

Requirements: Node.js 20 or newer, a Qloo hackathon API key, a Google AI Studio API key (the free tier is enough), and a Cloudflare account for deployment.

```sh
git clone https://github.com/works-on-my-box/sponsor-scout.git
cd sponsor-scout
npm install
cp .dev.vars.example .dev.vars   # put your keys here; the file is git-ignored
npm run dev                       # http://localhost:8787
npm test
```

Deploy to Cloudflare Workers:

```sh
npx wrangler kv namespace create CACHE      # put the id into wrangler.jsonc
npx wrangler deploy
npx wrangler secret put QLOO_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

The API runs in a fixed US region (`placement` in `wrangler.jsonc`) because Gemini refuses requests from some Cloudflare locations.

## Design choices

- **Keys stay on the server.** The browser talks only to `/api/*`; the Qloo and Gemini keys live in Worker secrets.
- **Small requests, private cache.** Qloo answers are cached in Workers KV for seven days and finished runs for 24 hours, so repeated demos do not spend quota. Nothing from Qloo is stored in this repository; tests use synthetic data.
- **Bounded cost.** Gemini 3.5 Flash-Lite with a fallback to 3.1 Flash-Lite, at most seven model turns per run, and a rate limit of four runs per minute per visitor.

## Limitations

- Affinity describes an audience as a group. It is not a prediction about any listener, and it does not show that a brand buys podcast ads or would sponsor this show.
- Qloo knows only some podcasts. Small shows may not be found, and some brands (for example, newer developer tools) are not in Qloo yet; the page says which past sponsors it could not find.
- The reasons and pitch angles are written by a language model from Qloo evidence. They can be generic and should be checked before an email goes out.
- The agent sends Qloo only show and brand names, never personal data.

## License

MIT, see [LICENSE](LICENSE).
