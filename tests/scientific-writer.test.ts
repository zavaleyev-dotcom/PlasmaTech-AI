import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_TYPES, WRITER_MODES, DOCUMENT_STRUCTURES, PROTECTED_TECHNICAL_TERMS,
  validateInput, buildEvidenceReport, buildLocalScaffold, buildGenerationPrompt,
  checkPreservation, summarizeChanges, checkNoInventedNumbers, checkNoFabricatedScholarlyArtifacts, buildSafetyWarnings, NOT_ENOUGH_DATA,
  type ScientificWriterInput,
} from '../src/services/workspace/scientific-writer';

function draftInput(overrides: Partial<ScientificWriterInput> = {}): ScientificWriterInput {
  return {
    documentType: 'article', mode: 'draft', targetLanguage: 'en',
    title: 'Влияние давления азота на твёрдость покрытий TiN',
    researchField: 'Физика плазмы, PVD-покрытия',
    goal: 'Изучить влияние давления азота на твёрдость покрытий TiN',
    researchObject: 'Образцы стали AISI 316 с покрытием TiN',
    methods: 'Магнетронное распыление, измерение твёрдости по Виккерсу',
    results: 'Твёрдость возрастает с 1800 до 2400 HV при увеличении давления с 0.3 до 0.5 Па',
    conclusions: 'Давление азота 0.5 Па даёт максимальную твёрдость покрытия',
    keywords: 'TiN, PVD, твёрдость, давление азота',
    ...overrides,
  };
}

// ---------- document type selection / structure ----------

test('document types: all 6 required types are present, each with a defined section structure', () => {
  assert.deepEqual(DOCUMENT_TYPES, ['article', 'conference_abstract', 'annotation', 'introduction', 'grant_proposal', 'technical_report']);
  for (const type of DOCUMENT_TYPES) assert.ok(DOCUMENT_STRUCTURES[type].length > 0, `${type} must have at least one section`);
});

test('article section structure: includes all 8 required IMRaD-style sections in order', () => {
  const headings = DOCUMENT_STRUCTURES.article.map(s => s.heading);
  assert.deepEqual(headings, ['Title', 'Abstract', 'Keywords', 'Introduction', 'Materials and Methods', 'Results', 'Discussion', 'Conclusion']);
});

// ---------- missing evidence behavior (item 4/5) ----------

test('missing evidence behavior: a section with no relevant user data shows "Недостаточно данных", never invented content', () => {
  const input = draftInput({ results: undefined, conclusions: undefined });
  const evidence = buildEvidenceReport(input);
  assert.ok(evidence.missing.includes('Основные результаты'));
  const scaffold = buildLocalScaffold(input, evidence);
  const results = scaffold.find(s => s.heading === 'Results')!;
  const discussion = scaffold.find(s => s.heading === 'Discussion')!;
  const conclusion = scaffold.find(s => s.heading === 'Conclusion')!;
  assert.equal(results.text, NOT_ENOUGH_DATA);
  assert.equal(conclusion.text, NOT_ENOUGH_DATA);
  // Discussion needs results OR conclusions - both missing here, so it must also be flagged
  assert.equal(discussion.text, NOT_ENOUGH_DATA);
});

test('evidence report distinguishes provided vs missing fields exactly, and the scaffold only ever quotes PROVIDED values verbatim', () => {
  const input = draftInput();
  const evidence = buildEvidenceReport(input);
  assert.deepEqual(evidence.missing, []);
  assert.equal(evidence.provided.length, 8);
  const scaffold = buildLocalScaffold(input, evidence);
  const abstract = scaffold.find(s => s.heading === 'Abstract')!;
  assert.ok(abstract.text.includes('Твёрдость возрастает с 1800 до 2400 HV'), 'the scaffold must reuse the user\'s own words verbatim, not paraphrase');
});

// ---------- no invented citations / DOI (item 4) ----------

test('no invented citations/DOI: neither the local scaffold nor the generation prompt ever contains a DOI-like pattern or a "References" section unless the user supplied one', () => {
  const input = draftInput();
  const evidence = buildEvidenceReport(input);
  const scaffold = buildLocalScaffold(input, evidence);
  const scaffoldText = scaffold.map(s => s.text).join('\n');
  assert.ok(!/\b10\.\d{4,9}\/\S+/.test(scaffoldText), 'scaffold must never contain a DOI pattern');
  assert.ok(!/references|литература|библиография/i.test(scaffoldText));
  const prompt = buildGenerationPrompt(input, evidence);
  assert.ok(!/\b10\.\d{4,9}\/\S+/.test(prompt.system + prompt.user), 'prompt must never contain a DOI pattern');
  assert.ok(prompt.system.includes('DOI'), 'the system prompt must explicitly forbid inventing DOIs/citations');
  assert.ok(prompt.system.toLowerCase().includes('придумывать'));
});

// ---------- preservation of numeric values / technical abbreviations (item 6/7) ----------

test('checkPreservation: flags a missing number as unpreserved, and reports success only when every number survives', () => {
  const original = 'Толщина покрытия составила 350 нм при давлении 0.5 Па и температуре 300°C.';
  const goodEdit = 'Толщина покрытия достигла 350 нм при давлении 0.5 Па и температуре 300°C, что соответствует норме.';
  const badEdit = 'Толщина покрытия достигла 400 нм при давлении 0.5 Па.'; // 350 and 300 silently changed/dropped
  assert.equal(checkPreservation(original, goodEdit).ok, true);
  const bad = checkPreservation(original, badEdit);
  assert.equal(bad.ok, false);
  assert.ok(bad.missingNumbers.includes('350 нм'), `expected a "350 нм" entry, got: ${bad.missingNumbers.join(', ')}`);
  assert.ok(bad.missingNumbers.includes('300°C'), `expected a "300°C" entry, got: ${bad.missingNumbers.join(', ')}`);
});

test('checkPreservation: protected technical abbreviations (PVD, ta-C, ICP/RF, ...) must survive verbatim, RU translation or not', () => {
  const original = 'The PVD process used ta-C coatings with ICP/RF assistance.';
  const preservedTranslation = 'В процессе PVD использовались покрытия ta-C с поддержкой ICP/RF.';
  const brokenTranslation = 'В процессе физического осаждения использовались алмазоподобные покрытия.'; // abbreviations translated away
  assert.equal(checkPreservation(original, preservedTranslation).ok, true);
  const broken = checkPreservation(original, brokenTranslation);
  assert.equal(broken.ok, false);
  assert.ok(broken.missingTerms.includes('PVD'));
  assert.ok(broken.missingTerms.includes('ta-C'));
});

// ---------- RU -> EN / EN -> RU translation mode ----------

test('translate_ru_en: the prompt states the correct direction and lists every protected term to preserve', () => {
  const input: ScientificWriterInput = { documentType: 'article', mode: 'translate_ru_en', targetLanguage: 'en', sourceText: 'Осаждение PVD покрытия ta-C проводилось при давлении 0.5 Па.' };
  const evidence = buildEvidenceReport(input);
  const prompt = buildGenerationPrompt(input, evidence);
  assert.ok(prompt.system.includes('с русского на английский'));
  for (const term of PROTECTED_TECHNICAL_TERMS) assert.ok(prompt.system.includes(term), `system prompt must list protected term: ${term}`);
  assert.ok(prompt.user.includes('Осаждение PVD покрытия ta-C'));
});

test('translate_en_ru: the prompt states the correct (opposite) direction', () => {
  const input: ScientificWriterInput = { documentType: 'article', mode: 'translate_en_ru', targetLanguage: 'ru', sourceText: 'PVD deposition of ta-C coating at 0.5 Pa.' };
  const prompt = buildGenerationPrompt(input, buildEvidenceReport(input));
  assert.ok(prompt.system.includes('с английского на русский'));
});

// ---------- rewrite mode ----------

test('rewrite mode: requires sourceText, and the prompt forwards it verbatim without fabricating missing-field lists (which do not apply here)', () => {
  assert.throws(() => validateInput({ documentType: 'article', mode: 'rewrite', targetLanguage: 'en' }), /Исходный текст/);
  const input: ScientificWriterInput = { documentType: 'article', mode: 'rewrite', targetLanguage: 'en', sourceText: 'The coating thickness was measured as 350 nm.' };
  const prompt = buildGenerationPrompt(input, buildEvidenceReport(input));
  assert.ok(prompt.user.includes('The coating thickness was measured as 350 nm.'));
  assert.ok(prompt.system.includes('Не меняй числовые значения'));
});

test('summarizeChanges: reports an honest sentence-level count, never a semantic claim, and reports "no changes" when nothing differs', () => {
  const original = 'Первое предложение. Второе предложение.';
  assert.deepEqual(summarizeChanges(original, original), ['Существенных изменений не обнаружено.']);
  const edited = 'Первое предложение. Третье предложение.';
  const changes = summarizeChanges(original, edited);
  assert.ok(changes.some(c => c.includes('Удалено')));
  assert.ok(changes.some(c => c.includes('Добавлено')));
});

// ---------- invalid mode/type rejection ----------

test('validateInput: rejects an invalid document type, mode, or target language', () => {
  assert.throws(() => validateInput({ documentType: 'bogus' as never, mode: 'draft', targetLanguage: 'en', title: 'X' }), /Тип документа/);
  assert.throws(() => validateInput({ documentType: 'article', mode: 'bogus' as never, targetLanguage: 'en', title: 'X' }), /Режим работы/);
  assert.throws(() => validateInput({ documentType: 'article', mode: 'draft', targetLanguage: 'bogus' as never, title: 'X' }), /Целевой язык/);
  for (const mode of WRITER_MODES) assert.ok(WRITER_MODES.includes(mode));
});

// ---------- empty / oversized input ----------

test('validateInput: rejects a completely empty draft request (no field filled in at all)', () => {
  assert.throws(() => validateInput({ documentType: 'article', mode: 'draft', targetLanguage: 'en' }), /Заполните хотя бы одно поле/);
});

test('validateInput: rejects an oversized single field and an oversized total request', () => {
  assert.throws(() => validateInput(draftInput({ methods: 'a'.repeat(20_001) })), /слишком длинный/);
  const hugeInput = draftInput({
    goal: 'a'.repeat(19_000), researchObject: 'b'.repeat(19_000), methods: 'c'.repeat(19_000),
    results: 'd'.repeat(19_000), conclusions: 'e'.repeat(19_000),
  });
  assert.throws(() => validateInput(hugeInput), /Суммарный объём/);
});

// ---------- Unicode / special characters / chemical formulas / numbers stay intact ----------

test('validateInput accepts RU/EN Unicode, chemical formulas, and numeric/unit tokens without rejecting or mangling them', () => {
  const input = draftInput({ results: 'Al₂O₃ и TiN, толщина 350±10 нм, davление 0.5×10⁻³ Па, температура 300°C — всё в норме.' });
  assert.doesNotThrow(() => validateInput(input));
  const evidence = buildEvidenceReport(input);
  assert.equal(evidence.fields.find(f => f.key === 'results')!.value, input.results);
});

// ---------- invented-number safeguard (item 5/6) ----------

test('checkNoInventedNumbers: flags a generated number that traces back to nothing the user supplied', () => {
  const input = draftInput({ results: 'Твёрдость возросла до 2400 HV.' });
  const clean = checkNoInventedNumbers(input, 'Итоговая твёрдость составила 2400 HV, что подтверждает гипотезу.');
  assert.equal(clean.ok, true);
  const withInvented = checkNoInventedNumbers(input, 'Итоговая твёрдость составила 5000 HV.');
  assert.equal(withInvented.ok, false);
  assert.ok(withInvented.invented.includes('5000 HV'), `expected a "5000 HV" entry, got: ${withInvented.invented.join(', ')}`);
});

test('checkNoInventedNumbers: small structural numbers (list/section numbering) are excluded to avoid false positives', () => {
  const input = draftInput({ results: 'Результат зафиксирован.' });
  const check = checkNoInventedNumbers(input, '1. Введение.\n2. Материалы и методы.');
  assert.equal(check.ok, true);
});

test('checkNoInventedNumbers: a small number is NOT automatically excluded just because it is <=20 - only a real list-marker shape is (F03 regression: the old blanket 0-20 exclusion let a genuinely invented small value slip through)', () => {
  const input = draftInput({ results: 'Покрытие нанесено без данных о твёрдости.' });
  const check = checkNoInventedNumbers(input, 'Твёрдость составила 15 ГПа.');
  assert.equal(check.ok, false);
  assert.ok(check.invented.includes('15 ГПа'), `expected a "15 ГПа" entry, got: ${check.invented.join(', ')}`);
});

// ---------- scholarly-artifact safeguard (item 5) ----------

test('checkNoFabricatedScholarlyArtifacts: flags a DOI-like string, an author-year citation marker, and a references heading', () => {
  assert.equal(checkNoFabricatedScholarlyArtifacts('Plain text with no citations at all.').ok, true);
  assert.equal(checkNoFabricatedScholarlyArtifacts('See doi:10.1000/xyz123 for details.').doiFound, true);
  assert.equal(checkNoFabricatedScholarlyArtifacts('As shown previously (Smith, 2019).').citationMarkersFound, true);
  assert.equal(checkNoFabricatedScholarlyArtifacts('Conclusion.\n\nReferences\n[1] ...').referenceSectionFound, true);
});

// ---------- combined safety warnings ----------

test('buildSafetyWarnings: returns an empty array only when every safeguard passes, and a populated array otherwise', () => {
  const input = draftInput({ results: 'Твёрдость 2400 HV.' });
  assert.deepEqual(buildSafetyWarnings(input, 'Твёрдость составила 2400 HV.', null), []);
  const withProblem = buildSafetyWarnings(input, 'Твёрдость составила 9999 HV (doi:10.1000/fake).', null);
  assert.ok(withProblem.length >= 2);
});

// ---------- F03 (HIGH) explicit regression set: number+unit safeguards must be exact, not substring ----------

test('F03: 5 µm -> 15 nm must warn (different number AND different unit, not just a substring of "15")', () => {
  const result = checkPreservation('Толщина покрытия 5 µm.', 'Толщина покрытия 15 nm.');
  assert.equal(result.ok, false);
  assert.ok(result.missingNumbers.includes('5 µm'), `expected "5 µm" missing, got: ${result.missingNumbers.join(', ')}`);
});

test('F03: 10 °C -> 10 K must warn (same bare number, different unit)', () => {
  const result = checkPreservation('Отжиг при 10 °C.', 'Отжиг при 10 K.');
  assert.equal(result.ok, false);
  assert.ok(result.missingNumbers.includes('10 °C'), `expected "10 °C" missing, got: ${result.missingNumbers.join(', ')}`);
});

test('F03: 5 -> 15 (no units at all) must warn - "5" must never match as a substring of "15"', () => {
  const result = checkPreservation('Образцов: 5.', 'Образцов: 15.');
  assert.equal(result.ok, false);
  assert.ok(result.missingNumbers.includes('5'), `expected "5" missing, got: ${result.missingNumbers.join(', ')}`);
});

test('F03: an invented "15 GPa" hardness claim (draft mode, no source at all) is flagged, not excluded just because 15 is small', () => {
  const input = draftInput({ results: 'Покрытие получено без измерения твёрдости.' });
  const check = checkNoInventedNumbers(input, 'Твёрдость составила 15 GPa.');
  assert.equal(check.ok, false);
  assert.ok(check.invented.includes('15 GPa'));
});

test('F03: 400 °C is preserved when it genuinely survives verbatim', () => {
  const result = checkPreservation('Процесс при 400 °C.', 'Процесс проводился при температуре 400 °C, без изменений.');
  assert.equal(result.ok, true);
  assert.ok(result.preservedNumbers.includes('400 °C'));
});

test('F03: 60 min is preserved when it genuinely survives verbatim', () => {
  const result = checkPreservation('Длительность процесса 60 min.', 'Процесс длился 60 min в описанных условиях.');
  assert.equal(result.ok, true);
  assert.ok(result.preservedNumbers.includes('60 min'));
});

test('F03: 2.5 µm is preserved when it genuinely survives verbatim (decimal point, not comma)', () => {
  const result = checkPreservation('Толщина составила 2.5 µm.', 'Итоговая толщина покрытия - 2.5 µm.');
  assert.equal(result.ok, true);
  assert.ok(result.preservedNumbers.includes('2.5 µm'));
});

test('F03: a fully Cyrillic scientific sentence with no space before the unit ("5мкм") is still tokenized correctly', () => {
  const result = checkPreservation('Толщина покрытия 5мкм при 10мин обработки.', 'Толщина стала 15мкм при 10мин обработки.');
  assert.equal(result.ok, false);
  assert.ok(result.missingNumbers.includes('5мкм'), `expected "5мкм" missing, got: ${result.missingNumbers.join(', ')}`);
  assert.ok(result.preservedNumbers.includes('10мин'), `expected "10мин" preserved, got: ${result.preservedNumbers.join(', ')}`);
});

test('F03: dates and plain list numbering are never broken by the new tokenizer', () => {
  const result = checkPreservation('Испытания проведены в 2024 году, этап 3.', 'В 2024 году были проведены испытания, этап 3 завершён.');
  assert.equal(result.ok, true);
});

test('F03: a protected term is never matched as a substring of an unrelated word (Unicode-aware word boundary, not plain .includes())', () => {
  // "RF" (radio-frequency) must not be considered "preserved" just because the edited text
  // happens to contain the unrelated word "performance", which contains "RF" as a substring.
  const result = checkPreservation('Обработка в режиме RF плазмы.', 'Обработка показала хорошую performance по сравнению с базовым режимом.');
  assert.equal(result.ok, false);
  assert.ok(result.missingTerms.includes('RF'));
});
