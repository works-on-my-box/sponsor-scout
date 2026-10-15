// Unit tests for the page's brand matching (a plain JS module served from public/), synthetic names only.
import { describe, it, expect } from 'vitest';
import { brandKey, sharedKeys } from '../public/compare.js';

describe('brandKey', () => {
  it('ignores case, spacing, accents, a leading "the" and notes in brackets', () => {
    expect(brandKey('Hello Fresh')).toBe(brandKey('HelloFresh'));
    expect(brandKey('The Home Depot')).toBe(brandKey('Home Depot'));
    expect(brandKey('Nestlé')).toBe('nestle');
    expect(brandKey('Acme (US)')).toBe('acme');
  });
});

describe('sharedKeys', () => {
  it('finds the brands named in both lists, and only those', () => {
    expect([...sharedKeys(['Acme Tools', 'Widget Co', 'Gizmo'], ['ACME tools', 'Other', 'widget-co'])]).toEqual(['acmetools', 'widgetco']);
  });
  it('never matches names that reduce to nothing', () => {
    expect(sharedKeys(['', '(beta)'], ['', '(beta)']).size).toBe(0);
  });
});
