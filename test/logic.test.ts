// Unit tests on synthetic data only: Qloo responses must not be stored in this repository.
import { describe, it, expect } from 'vitest';
import { mapBrand, isLikelyAdvertiser, BrandHit } from '../src/qloo';
import { describeAudience, validatePicks, fallbackPicks } from '../src/agent';
import { parseInput } from '../src/index';

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
