import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSafetyWarnings, checkUnsupportedNoveltyClaims, checkNoAddedSignificanceClaims, type ScientificWriterInput } from '../src/services/workspace/scientific-writer';
import { MEAN_FREE_PATH_MODEL_NOTE, calculateMeanFreePath } from '../src/services/workspace/engineering-calculators';
import { handleGenerate } from '../src/services/workspace/scientific-writer-handler';
import { UNVERIFIED_CLAIMS_WARNING } from '../src/services/rag/prompt';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const input = (over: Partial<ScientificWriterInput> = {}): ScientificWriterInput => ({ documentType: 'article', mode: 'draft', targetLanguage: 'ru', title: 'Покрытия TiN', ...over });

// ---------- D1 ----------
test('D1: the AI answer block carries the exact unverified-claims warning, inside the answer article', () => {
  assert.equal(UNVERIFIED_CLAIMS_WARNING, 'Ссылки на источники найдены, но соответствие отдельных утверждений содержимому источников автоматически не проверено.');
  const src = read('src/components/local-library/ask.tsx');
  const start = src.indexOf("result.status === 'answered'");
  const article = src.slice(start, src.indexOf('</article>', start));
  assert.ok(article.includes('{UNVERIFIED_CLAIMS_WARNING}'), 'warning must be rendered inside the answered-article block');
  assert.ok(article.indexOf('UNVERIFIED_CLAIMS_WARNING') < article.indexOf('answer.claims.map'), 'warning must come before the claims');
  assert.ok(src.includes('Открыть PDF') && src.includes('result.citations.map'), 'sources and PDF links are kept');
  assert.ok(!/подтвержден[ао]? публикацией/.test(src));
});

// ---------- D2 ----------
const flagged = (text: string, i = input()) => checkUnsupportedNoveltyClaims(i, text).found;
test('D2: Russian categorical phrases are flagged', () => {
  assert.equal(flagged('Метод впервые решает проблему износа.').length, 1);
  assert.equal(flagged('Это революционный подход.').length, 1);
  assert.equal(flagged('Получено беспрецедентное значение твёрдости.').length, 1);
  assert.equal(flagged('Подтверждена высокая эффективность метода.').length, 1);
  assert.equal(flagged('Результаты подтверждают высокую эффективность метода.').length, 1);
});
test('D2: English categorical phrases are flagged', () => {
  assert.equal(flagged('This is the first-ever demonstration.').length, 1);
  assert.equal(flagged('A revolutionary coating.').length, 1);
  assert.equal(flagged('Unprecedented hardness was reached.').length, 1);
  assert.equal(flagged('We propose a novel approach to deposition.').length, 1);
  assert.equal(flagged('The method shows proven superior performance.').length, 1);
  assert.equal(flagged('The coating demonstrated high efficiency in tests.').length, 1);
});

test('D2: neutral scientific text gets no novelty warning', () => {
  for (const text of [
    'Покрытие TiN осаждали магнетронным распылением при давлении 0.5 Па. Толщина составила 2.1 мкм.',
    'The first sample was annealed at 300 °C. Table 1 lists the results of the second stage.',
    'Ранее такой подход применяли в работе [1]; в нашей работе он не является новым.',
    'The novel coronavirus pandemic changed laboratory schedules.',
    'Эффективность метода оценивали по скорости осаждения; высокая шероховатость не наблюдалась.',
    'Результаты не подтверждают высокую эффективность.',
    'Это не впервые описано в литературе.',
  ]) assert.deepEqual(flagged(text), [], text);
});

test('D2: wording the author supplied themselves is not flagged; wording the model added is', () => {
  assert.deepEqual(flagged('Метод впервые применён к стали.', input({ results: 'Метод впервые применён к стали' })), []);
  assert.equal(flagged('Метод впервые применён к стали.', input({ results: 'Применён метод' })).length, 1);
  assert.deepEqual(flagged('A novel approach was used.', input({ mode: 'rewrite', sourceText: 'A novel approach was used.' })), []);
});

test('D2: buildSafetyWarnings reports the markers as a verification request, keeps older checks, never rewrites the text', () => {
  const text = 'Твёрдость достигла 45 ГПа (Smith et al., 2019, DOI 10.1234/x). Метод революционный и впервые решает проблему.';
  const copy = text;
  const warnings = buildSafetyWarnings(input({ results: 'Твёрдость 32 ГПа' }), text, null);
  assert.equal(text, copy);
  const novelty = warnings.find(w => w.includes('новизне или превосходстве'));
  assert.ok(novelty && novelty.includes('революцион') && novelty.includes('впервые') && /убедитесь|подтверждены/.test(novelty));
  assert.ok(!/ложн|неверн/i.test(novelty!), 'must not declare the claim false');
  assert.ok(warnings.some(w => w.includes('45 ГПа')), 'invented-number check still works');
  assert.ok(warnings.some(w => w.includes('DOI')), 'DOI check still works');
  assert.ok(warnings.some(w => w.includes('цитирования')), 'citation-marker check still works');
  assert.ok(!buildSafetyWarnings(input({ results: 'Толщина 2.1 мкм' }), 'Толщина покрытия составила 2.1 мкм.', null).some(w => w.includes('новизне')));
  assert.equal(checkNoAddedSignificanceClaims('a', 'p < 0.05 достоверно').ok, false, 'p-value / significance check still works');
});

// ---------- D6 ----------
test('D6: the model note is shown with the result and states the physical limits', () => {
  for (const part of ['кинетической теории газа', 'эффективным диаметром столкновений', 'применима', 'со стенками', 'геометрия камеры']) assert.ok(MEAN_FREE_PATH_MODEL_NOTE.includes(part), part);
  assert.ok(!/\d+\s*(?:Па|мбар|Торр)/.test(MEAN_FREE_PATH_MODEL_NOTE), 'no arbitrary pressure threshold');
  const src = read('src/components/engineering-calculators.tsx');
  assert.ok(src.includes('{MEAN_FREE_PATH_MODEL_NOTE}'));
  assert.ok(src.indexOf('{MEAN_FREE_PATH_MODEL_NOTE}') < src.indexOf('Заполните параметры'), 'note is part of the result block');
});

test('D6: the calculation itself is unchanged (Ar, 1 Pa, 20 C = 7.8804e-3 m; 1e-9 mbar still computed)', () => {
  assert.ok(Math.abs(calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'argon' }).meanFreePathM - 0.007880440178372266) < 1e-15);
  assert.ok(Math.abs(calculateMeanFreePath({ pressure: 1e-9, pressureUnit: 'mbar', temperatureC: 20, gas: 'argon' }).meanFreePathM - 78804.40178372266) < 1e-6);
});

// ---------- D2 final correction: polarity / instruction / word forms, through the real handleGenerate() ----------
const NOVELTY = 'новизне или превосходстве';
async function generate(over: Record<string, unknown>, answer: string): Promise<{ text: string; warnings: string[]; novelty: string | undefined }> {
  const provider = { id: 'synthetic', configured: () => true, generate: async () => ({ text: answer }) };
  const res = await handleGenerate({ documentType: 'article', mode: 'draft', targetLanguage: 'ru', title: 'Покрытия TiN', ...over }, provider as never);
  assert.equal(res.status, 200);
  const warnings = res.body.warnings as string[];
  assert.equal(res.body.generatedText, answer, 'generated text must be returned untouched');
  return { text: res.body.generatedText as string, warnings, novelty: warnings.find(w => w.includes(NOVELTY)) };
}

test('D2-final #1: source "не впервые", answer "впервые" -> WARNING', async () => {
  const r = await generate({ results: 'Метод не впервые применён к стали' }, 'Метод впервые применён к стали.');
  assert.ok(r.novelty && r.novelty.includes('впервые'));
});
test('D2-final #2: instruction "не используйте слово впервые", answer "впервые" -> WARNING', async () => {
  const r = await generate({ additionalRequirements: 'Не используйте слово впервые.' }, 'Метод впервые применён к стали.');
  assert.ok(r.novelty);
  const r2 = await generate({ additionalRequirements: 'Avoid the word revolutionary.' }, 'A revolutionary method.');
  assert.ok(r2.novelty);
});
test('D2-final #3: "не только революционный" -> WARNING', async () => {
  const r = await generate({}, 'Это не только революционный метод, но и эффективный.');
  assert.ok(r.novelty && r.novelty.includes('революцион'));
});
test('D2-final #4: "not only revolutionary" -> WARNING', async () => {
  const r = await generate({ targetLanguage: 'en' }, 'It is not only revolutionary but also efficient.');
  assert.ok(r.novelty && r.novelty.includes('revolutionary'));
});
test('D2-final #5: source "революционный", answer "революционным" -> NO NEW WARNING', async () => {
  const r = await generate({ goal: 'Предложен революционный метод' }, 'Метод является революционным.');
  assert.equal(r.novelty, undefined);
});
test('D2-final #6: source positive "впервые", answer keeps the claim -> NO NEW WARNING (also rewrite mode with sourceText)', async () => {
  assert.equal((await generate({ results: 'Метод впервые применён к стали' }, 'Метод впервые применён к стали.')).novelty, undefined);
  assert.equal((await generate({ mode: 'rewrite', sourceText: 'Метод впервые применён к стали.' }, 'Метод был впервые применён к стали.')).novelty, undefined);
});
test('D2-final #7: neutral source and neutral answer -> NO WARNING at all', async () => {
  const r = await generate({ results: 'Толщина покрытия 2.1 мкм' }, 'Толщина покрытия составила 2.1 мкм.');
  assert.deepEqual(r.warnings, []);
});
test('D2-final #8: "не впервые" in the answer -> NO NOVELTY WARNING', async () => {
  assert.equal((await generate({}, 'Метод не впервые описан в литературе.')).novelty, undefined);
  assert.equal((await generate({}, 'Метод не является революционным.')).novelty, undefined);
});
test('D2-final #9: "novel coronavirus" -> NO NOVELTY WARNING', async () => {
  assert.equal((await generate({ targetLanguage: 'en' }, 'The novel coronavirus pandemic changed schedules.')).novelty, undefined);
});
test('D2-final #10: every earlier RU/EN novelty and superiority marker is still reported', async () => {
  for (const [lang, text] of [
    ['ru', 'Метод впервые решает задачу.'], ['ru', 'Это революционный подход.'], ['ru', 'Достигнуто беспрецедентное значение.'], ['ru', 'Подтверждена высокая эффективность метода.'],
    ['en', 'This is a first-ever demonstration.'], ['en', 'A revolutionary coating.'], ['en', 'Unprecedented hardness was reached.'], ['en', 'We propose a novel approach.'], ['en', 'The method shows proven superior performance.'], ['en', 'Done for the first time.'],
  ] as const) {
    assert.ok((await generate({ targetLanguage: lang }, text)).novelty, text);
  }
});
test('D2-final: other checks (numbers, DOI, citations) and a negated source claim of ANOTHER category do not interfere', async () => {
  const r = await generate({ results: 'Метод не впервые применён' }, 'Метод революционный; твёрдость 45 ГПа (Smith et al., 2019, 10.1234/x).');
  assert.ok(r.novelty && r.novelty.includes('революцион'));
  assert.ok(r.warnings.some(w => w.includes('45 ГПа')) && r.warnings.some(w => w.includes('DOI')) && r.warnings.some(w => w.includes('цитирования')));
});
