import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReference, addReference, removeReference, updateReference, duplicateReference, moveReference,
  isValidDoiSyntax, isValidUrl, isValidYear, checkReferenceList, referenceDedupKey,
  formatReferenceApa, formatReferenceIeee, formatReferenceGost, buildBibliography,
  formatInTextApa, formatInTextNumeric, formatInText, referenceNumber,
  FORMATTING_PROFILES, JOURNAL_PRESETS,
  type Reference,
} from '../src/services/workspace/references';
import { normalizeDoi } from '../src/services/scientific-search/normalization';

// A fixed, clearly synthetic/test-only dataset (item 13) - never to be used as real production
// bibliographic evidence. Covers all 7 reference types with at least: 2 journal articles, 1
// conference paper, 1 book, 1 report, 1 website.
function testDataset(): Reference[] {
  return [
    {
      id: 'r1', type: 'journal_article',
      authors: ['Test Author A', 'Test Author B'],
      title: 'Synthetic test reference on AlTiN coatings (test data only)',
      containerTitle: 'Journal of Synthetic Test Data', year: 2021, volume: '10', issue: '2', pages: '100-110',
      doi: '10.1234/synthetic.test.0001',
    },
    {
      id: 'r2', type: 'journal_article',
      authors: ['Test Author C'],
      title: 'Second synthetic journal article (test data only)',
      containerTitle: 'Journal of Synthetic Test Data', year: 2022, volume: '11', issue: '1', pages: '1-9',
    },
    {
      id: 'r3', type: 'conference_paper',
      authors: ['Test Author D', 'Test Author E', 'Test Author F'],
      title: 'Synthetic conference paper (test data only)',
      containerTitle: 'Proceedings of the Synthetic Test Conference', year: 2020, pages: '55-60',
    },
    {
      id: 'r4', type: 'book',
      authors: ['Test Author G'],
      title: 'Synthetic test book (test data only)',
      containerTitle: 'Test Publishing House', year: 2019,
    },
    {
      id: 'r5', type: 'report',
      authors: ['Test Author H'],
      title: 'Synthetic technical report (test data only)',
      containerTitle: 'Test Institute', year: 2023,
    },
    {
      id: 'r6', type: 'website',
      authors: [],
      title: 'Synthetic web source (test data only)',
      url: 'https://example.test/synthetic-source', accessDate: '2024-01-01',
    },
  ];
}

// ---------- data model / CRUD (items 3-4) ----------

test('createReference: creates an empty reference with a unique id and the given type, no invented fields', () => {
  const a = createReference('journal_article');
  const b = createReference('journal_article');
  assert.notEqual(a.id, b.id);
  assert.equal(a.type, 'journal_article');
  assert.deepEqual(a.authors, []);
  assert.equal(a.title, undefined);
});

test('addReference/removeReference/updateReference/duplicateReference/moveReference: pure, immutable list operations', () => {
  let refs = addReference([], 'book');
  assert.equal(refs.length, 1);
  const id = refs[0].id;
  refs = updateReference(refs, id, { title: 'A title' });
  assert.equal(refs[0].title, 'A title');
  refs = duplicateReference(refs, id);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0].id, refs[1].id);
  assert.equal(refs[1].title, 'A title');
  const duplicateId = refs[1].id;
  refs = moveReference(refs, duplicateId, 'up');
  assert.equal(refs[0].id, duplicateId, 'moving the second entry up must swap it into first place');
  refs = removeReference(refs, duplicateId);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, id);
});

test('moveReference: no-ops at the boundaries instead of throwing or wrapping around', () => {
  const refs = [createReference('book'), createReference('book')];
  const atTop = moveReference(refs, refs[0].id, 'up');
  assert.deepEqual(atTop.map(r => r.id), refs.map(r => r.id));
  const atBottom = moveReference(refs, refs[1].id, 'down');
  assert.deepEqual(atBottom.map(r => r.id), refs.map(r => r.id));
});

// ---------- validation (item 4/7) ----------

test('isValidDoiSyntax: accepts well-formed DOIs, rejects malformed ones, never queries anything external', () => {
  assert.equal(isValidDoiSyntax('10.1234/synthetic.test.0001'), true);
  assert.equal(isValidDoiSyntax('not-a-doi'), false);
  assert.equal(isValidDoiSyntax('10.abc/xyz'), false);
  assert.equal(isValidDoiSyntax(''), false);
});

test('isValidUrl / isValidYear: basic sanity checks', () => {
  assert.equal(isValidUrl('https://example.test/page'), true);
  assert.equal(isValidUrl('not a url'), false);
  assert.equal(isValidYear(2021), true);
  assert.equal(isValidYear(1500), true);
  assert.equal(isValidYear(3000), false);
  assert.equal(isValidYear(NaN), false);
});

test('checkReferenceList: flags duplicate (same DOI on both), malformed DOI, invalid year, invalid URL, empty reference, missing title/authors', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'journal_article', authors: ['X'], title: 'Same Title', doi: '10.1234/aaa', year: 2020 },
    { id: 'b', type: 'journal_article', authors: ['Y'], title: 'Same Title', doi: '10.1234/aaa' },
    { id: 'c', type: 'journal_article', authors: [], doi: 'bad-doi', year: 4000, url: 'not a url' },
    { id: 'd', type: 'book', authors: [] },
  ];
  const { errors, warnings } = checkReferenceList(refs);
  const errorText = errors.map(e => e.message).join(' | ');
  assert.ok(errorText.includes('Дублирующийся источник') && errorText.includes('совпадает DOI'), 'a and b share the same DOI - flagged as duplicate via DOI, the highest-priority rule');
  assert.ok(errorText.includes('Некорректный формат DOI'));
  assert.ok(errorText.includes('Некорректный год'));
  assert.ok(errorText.includes('Некорректный URL'));
  assert.ok(errorText.includes('Пустой источник'));
  const warningText = warnings.map(w => w.message).join(' | ');
  assert.ok(warningText.includes('Не указано название'));
  assert.ok(warningText.includes('Не указаны авторы'));
});

// ---------- F13 (LOW): duplicate detection is DOI > title+year > title+first-author, never
// "same title alone" ----------

test('F13 referenceDedupKey: same title, different year -> genuinely different keys (NOT a duplicate) - the exact Codex regression ("Annual report" 2020 vs 2021)', () => {
  const a = referenceDedupKey({ doi: undefined, title: 'Annual report', year: 2020, authors: [] });
  const b = referenceDedupKey({ doi: undefined, title: 'Annual report', year: 2021, authors: [] });
  assert.ok(a && b);
  assert.notEqual(a!.key, b!.key);
});

test('F13 checkReferenceList: same title + different year across two real references produces NO duplicate error', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'report', authors: [], title: 'Annual report', year: 2020 },
    { id: 'b', type: 'report', authors: [], title: 'Annual report', year: 2021 },
  ];
  const { errors } = checkReferenceList(refs);
  assert.equal(errors.some(e => e.message.includes('Дублирующийся')), false);
});

test('F13 checkReferenceList: same title + same year -> duplicate', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'report', authors: [], title: 'Annual report', year: 2020 },
    { id: 'b', type: 'report', authors: [], title: 'Annual report', year: 2020 },
  ];
  const { errors } = checkReferenceList(refs);
  assert.ok(errors.some(e => e.referenceId === 'b' && e.message.includes('Дублирующийся источник') && e.message.includes('название и год')));
});

test('F13 checkReferenceList: same DOI (bare vs doi.org URL form) -> duplicate, even though the raw text differs', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'journal_article', authors: [], title: 'X', doi: '10.1234/test' },
    { id: 'b', type: 'journal_article', authors: [], title: 'Y (different title on purpose)', doi: 'https://doi.org/10.1234/TEST' },
  ];
  const { errors } = checkReferenceList(refs);
  assert.ok(errors.some(e => e.referenceId === 'b' && e.message.includes('совпадает DOI')), 'canonical DOI must match case-insensitively and regardless of URL wrapping');
});

test('F13 checkReferenceList: same title, no year on either, same first author -> duplicate (rule 3, the year-absent fallback)', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'report', authors: ['Smith'], title: 'Field survey' },
    { id: 'b', type: 'report', authors: ['Smith', 'Jones'], title: 'Field survey' },
  ];
  const { errors } = checkReferenceList(refs);
  assert.ok(errors.some(e => e.referenceId === 'b' && e.message.includes('название и первый автор')));
});

test('F13 checkReferenceList: same title, no year on either, DIFFERENT first author -> NOT a duplicate ("correct behavior" for a genuinely different pair of records)', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'report', authors: ['Smith'], title: 'Field survey' },
    { id: 'b', type: 'report', authors: ['Jones'], title: 'Field survey' },
  ];
  const { errors } = checkReferenceList(refs);
  assert.equal(errors.some(e => e.message.includes('Дублирующийся')), false);
});

test('F13 checkReferenceList: title alone (no year, no author on either side) is never enough to call two references duplicates', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'website', authors: [], title: 'Untitled series' },
    { id: 'b', type: 'website', authors: [], title: 'Untitled series' },
  ];
  const { errors } = checkReferenceList(refs);
  assert.equal(errors.some(e => e.message.includes('Дублирующийся')), false);
});

test('F13 checkReferenceList: case and whitespace differences in title/DOI still normalize to the same duplicate key', () => {
  const refs: Reference[] = [
    { id: 'a', type: 'journal_article', authors: [], title: '  Field   Survey  ', year: 2020 },
    { id: 'b', type: 'journal_article', authors: [], title: 'FIELD SURVEY', year: 2020 },
  ];
  const { errors } = checkReferenceList(refs);
  assert.ok(errors.some(e => e.referenceId === 'b' && e.message.includes('Дублирующийся')));
});

// ---------- F19 (LOW): manual DOI normalization reuses the shared implementation ----------

test('F19 isValidDoiSyntax: also accepts doi: prefix and doi.org/dx.doi.org URL forms (not only the bare canonical form)', () => {
  assert.equal(isValidDoiSyntax('doi:10.1234/test'), true);
  assert.equal(isValidDoiSyntax('https://doi.org/10.1234/test'), true);
  assert.equal(isValidDoiSyntax('http://doi.org/10.1234/test'), true);
  assert.equal(isValidDoiSyntax('https://dx.doi.org/10.1234/test'), true);
  assert.equal(isValidDoiSyntax('http://dx.doi.org/10.1234/test'), true);
  assert.equal(isValidDoiSyntax('not a doi at all'), false);
});

test('F19: normalizeDoi (the shared implementation references.ts and the manual editor both use) reduces every accepted form to the same canonical DOI', () => {
  const forms = ['10.1234/test', 'doi:10.1234/test', 'https://doi.org/10.1234/test', 'http://doi.org/10.1234/test', 'https://dx.doi.org/10.1234/test', 'http://dx.doi.org/10.1234/test', '  10.1234/TEST  '];
  for (const form of forms) assert.equal(normalizeDoi(form), '10.1234/test', `"${form}" must normalize to the canonical DOI`);
  assert.equal(normalizeDoi('not a doi'), null);
});

test('checkReferenceList: cited-but-absent and present-but-uncited are reported only when citedIds is explicitly supplied', () => {
  const refs = testDataset().slice(0, 2);
  const untracked = checkReferenceList(refs);
  assert.equal(untracked.warnings.some(w => w.message.includes('не процитирован')), false, 'must not guess citation usage when it was never tracked');

  const tracked = checkReferenceList(refs, [refs[0].id, 'missing-id']);
  assert.ok(tracked.warnings.some(w => w.message.includes('отсутствует в списке источников')));
  assert.ok(tracked.warnings.some(w => w.referenceId === refs[1].id && w.message.includes('не процитирован')));
});

test('checkReferenceList: a website with no authors is not flagged for missing authors (item 3: not all fields are mandatory)', () => {
  const { warnings } = checkReferenceList([{ id: 'w', type: 'website', authors: [], title: 'A site' }]);
  assert.equal(warnings.some(w => w.message.includes('Не указаны авторы')), false);
});

// ---------- citation formatting: APA / IEEE / GOST-style (item 5) ----------

test('formatReferenceApa: journal article with all fields, using only real data', () => {
  const text = formatReferenceApa(testDataset()[0]);
  assert.ok(text.includes('Test Author A'));
  assert.ok(text.includes('(2021)'));
  assert.ok(text.includes('Synthetic test reference on AlTiN coatings'));
  assert.ok(text.includes('10(2)'));
  assert.ok(text.includes('100-110'));
  assert.ok(text.includes('https://doi.org/10.1234/synthetic.test.0001'));
  assert.ok(!/undefined/i.test(text));
});

test('formatReferenceIeee: journal article uses IEEE punctuation and bracketed numbering', () => {
  const text = formatReferenceIeee(testDataset()[0], 1);
  assert.ok(text.startsWith('[1] '));
  assert.ok(text.includes('"Synthetic test reference on AlTiN coatings'));
  assert.ok(text.includes('vol. 10'));
  assert.ok(text.includes('no. 2'));
  assert.ok(text.includes('pp. 100-110'));
  assert.ok(text.includes('doi: 10.1234/synthetic.test.0001'));
  assert.ok(!/undefined/i.test(text));
});

test('formatReferenceGost: uses the "//" convention and is explicitly named a simplified GOST-style, never certified', () => {
  const text = formatReferenceGost(testDataset()[0], 1);
  assert.ok(text.startsWith('1. '));
  assert.ok(text.includes('// Journal of Synthetic Test Data'));
  assert.ok(text.includes('2021'));
  assert.ok(!/undefined/i.test(text));
});

test('multiple authors: APA uses "&" before the last author, IEEE uses "and"', () => {
  const apa = formatReferenceApa(testDataset()[2]);
  assert.ok(apa.includes('Test Author D, Test Author E, & Test Author F'));
  const ieee = formatReferenceIeee(testDataset()[2], 3);
  assert.ok(ieee.includes('Test Author D, Test Author E, and Test Author F'));
});

test('missing optional fields never produce "undefined" or stray/doubled punctuation', () => {
  const minimal: Reference = { id: 'm', type: 'journal_article', authors: ['Solo Author'], title: 'Minimal reference' };
  for (const text of [formatReferenceApa(minimal), formatReferenceIeee(minimal, 1), formatReferenceGost(minimal, 1)]) {
    assert.ok(!/undefined/i.test(text));
    assert.ok(!/,\s*,/.test(text));
    assert.ok(!/\.\s*\./.test(text));
  }
});

test('missing required fields (no title, no authors) still format without fabricating a value', () => {
  const bare: Reference = { id: 'bare', type: 'report', authors: [] };
  for (const text of [formatReferenceApa(bare), formatReferenceIeee(bare, 1), formatReferenceGost(bare, 1)]) {
    assert.ok(!/undefined/i.test(text));
  }
});

test('buildBibliography: APA is alphabetized by first author, IEEE/GOST keep list order and number sequentially', () => {
  const refs = testDataset();
  const apa = buildBibliography(refs, 'apa');
  assert.equal(apa.numbered, false);
  const ieee = buildBibliography(refs, 'ieee');
  assert.equal(ieee.numbered, true);
  assert.ok(ieee.entries[0].text.startsWith('[1]'));
  assert.ok(ieee.entries[5].text.startsWith('[6]'));
  const gost = buildBibliography(refs, 'gost');
  assert.ok(gost.entries[0].text.startsWith('1.'));
});

test('numbering stability: reordering the reference list predictably renumbers IEEE/GOST bibliographies', () => {
  const refs = testDataset();
  const reordered = moveReference(refs, refs[2].id, 'up');
  const before = buildBibliography(refs, 'ieee').entries.map(e => e.reference.id);
  const after = buildBibliography(reordered, 'ieee').entries.map(e => e.reference.id);
  assert.notDeepEqual(before, after);
  assert.equal(after[1], refs[2].id);
  const numbers = buildBibliography(reordered, 'ieee').entries.map(e => e.text.match(/^\[(\d+)\]/)?.[1]);
  assert.deepEqual(numbers, ['1', '2', '3', '4', '5', '6']);
});

// ---------- in-text citations (item 6) ----------

test('formatInTextApa: (Author, Year) for a single author, "&" for two, "et al." for 3+', () => {
  assert.equal(formatInTextApa(testDataset()[1]), '(Test Author C, 2022)');
  assert.equal(formatInTextApa(testDataset()[0]), '(Test Author A & Test Author B, 2021)');
  assert.equal(formatInTextApa(testDataset()[2]), '(Test Author D et al., 2020)');
});

test('formatInTextApa: safe fallback when author or year is missing - never invents either', () => {
  assert.equal(formatInTextApa({ id: 'x', type: 'journal_article', authors: [], title: 't' }), '(источник не указан)');
  assert.equal(formatInTextApa({ id: 'x', type: 'journal_article', authors: ['Only Author'], title: 't' }), '(Only Author, б.г.)');
  assert.equal(formatInTextApa({ id: 'x', type: 'journal_article', authors: [], year: 2020, title: 't' }), '(2020)');
});

test('formatInTextNumeric / formatInText: IEEE and GOST-style use [N] based on live list position', () => {
  const refs = testDataset();
  assert.equal(formatInTextNumeric(3), '[3]');
  assert.equal(formatInText(refs, refs[2].id, 'ieee'), '[3]');
  assert.equal(formatInText(refs, refs[2].id, 'gost'), '[3]');
  assert.equal(formatInText(refs, 'not-in-list', 'ieee'), '(источник не указан)');
});

test('referenceNumber: null (never a fabricated number) for a reference not in the list', () => {
  assert.equal(referenceNumber(testDataset(), 'missing'), null);
});

// ---------- document profiles / journal preset registry (items 9-10) ----------

test('FORMATTING_PROFILES: exactly the 3 V1 profiles, each with real spacing/margin/font settings', () => {
  assert.deepEqual(Object.keys(FORMATTING_PROFILES).sort(), ['conference_paper', 'generic_article', 'thesis_report']);
  for (const profile of Object.values(FORMATTING_PROFILES)) {
    assert.ok(profile.bodyFontSizePt > 0);
    assert.ok(profile.lineSpacing > 0);
    assert.ok(!/journal|elsevier|springer/i.test(profile.description), 'V1 profiles must not claim compliance with a specific journal');
  }
});

test('JOURNAL_PRESETS: registry interface exists but ships empty in V1 (no hardcoded publisher templates)', () => {
  assert.deepEqual(JOURNAL_PRESETS, []);
});
