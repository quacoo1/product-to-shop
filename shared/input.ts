import type { ProductInput, RequestedSelection } from './types.js';

export const inputLinks = (text: string) => [...text.matchAll(/https?:\/\/[^\s<>]+/gi)];
export function quantityErrors(selection: RequestedSelection): string[] {
  return (selection.quantityChecks ?? []).filter(c => c.expected !== c.actual).map(c =>
    `Quantity mismatch for ${c.scope === 'product' ? 'the whole product' : selection.color || 'the size list'}: expected ${c.expected}, but sizes list ${c.actual} units. Correct the input before CSV export.`);
}

// Notes belong to the preceding link, up to the next share message/link.
export function parseProductInput(text: string): ProductInput[] {
  if (text.length > 200000) throw new Error('The pasted input is too long.');
  const links = inputLinks(text);
  if (!links.length || links.length > 50) throw new Error('Paste between 1 and 50 product links.');
  const entries: ProductInput[] = [];
  links.forEach((link, index) => {
    const url = link[0].replace(/[.,;)]+$/, '');
    const tail = text.slice(link.index! + link[0].length, links[index + 1]?.index ?? text.length)
      .replace(/Check out this item I found on[^\r\n]*/gi, '').trim();
    const groups: RequestedSelection[] = [];
    const notes: string[] = [];
    const totals: number[] = [];
    for (const raw of tail.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^\d+$/.test(line)) { notes.push(line); totals.push(Number(line)); continue; }
      // Both "White (uk 14,16)" and "Brown uk (16,16)" are accepted.
      const match = /^(.*?)\(\s*(?:uk\s*)?([\d\s,]+)\s*\)\s*$/i.exec(line);
      if (!match) throw new Error(`Could not read the size note "${line}". Use e.g. White (UK 10,12).`);
      const prefix = match[1].replace(/\buk\s*$/i, '').trim();
      const count = /\d+\s*$/.exec(prefix);
      const color = prefix.replace(/\s*\d+\s*$/, '').trim();
      const sizes = match[2].split(/[\s,]+/).filter(Boolean);
      if (!sizes.length || sizes.some(size => !/^\d{1,2}$/.test(size))) throw new Error(`Invalid sizes in "${line}".`);
      groups.push({ ...(color ? { color } : {}), sizes: sizes.map(size => `UK ${Number(size)}`), notes: [line],
        ...(count ? { quantityChecks: [{ scope: 'colour', expected: Number(count[0]), actual: sizes.length }] } : {}) });
    }
    if (!groups.length && notes.length) throw new Error(`Add sizes in brackets after ${url}.`);
    if (!groups.length) entries.push({ url });
    else for (const group of groups) {
      const checks = [...(group.quantityChecks ?? []), ...totals.map(expected => ({ scope: 'product' as const, expected, actual: groups.reduce((n, g) => n + g.sizes.length, 0) }))];
      if (checks.some(c => !Number.isSafeInteger(c.expected) || c.expected < 1)) throw new Error('Quantities must be positive whole numbers.');
      entries.push({ url, selection: { ...group, notes: [...notes, ...group.notes], ...(checks.length ? { quantityChecks: checks } : {}) } });
    }
  });
  if (entries.length > 50) throw new Error('Use at most 50 product and colour groups per batch.');
  return entries;
}
