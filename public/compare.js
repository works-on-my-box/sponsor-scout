// Brand-name matching for the "without Qloo" comparison; pure, so it is unit-tested.

// "The Home Depot" and "Home Depot", "Hello Fresh" and "HelloFresh" get the same key.
export function brandKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Keys of the brands that appear in both lists.
export function sharedKeys(a, b) {
  const right = new Set(b.map(brandKey));
  return new Set(a.map(brandKey).filter((k) => k && right.has(k)));
}
