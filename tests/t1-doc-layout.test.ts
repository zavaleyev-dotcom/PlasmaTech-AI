import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  STALE_RESULTS_MESSAGE, defaultTeaForm, defaultTeaProject, isCalculationStale, calculationRequestFrom, parseTeaProject, type CalculatedFrom, type TeaFormState, type TeaProjectContent,
} from '../src/services/workspace/tea-project-store';
import { renderGenericDocx, type GenericDocumentViewModel } from '../src/services/workspace/document-export';
import { exportTechDoc, parseTechnicalProcessDocument } from '../src/services/workspace/techdoc-export';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

// ---------- T1: results belong to the inputs they were calculated from ----------
const form = (equipment: string): TeaFormState => ({
  ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment }, opex: { ...defaultTeaForm().opex, labor: '100000' }, currentAnnualCost: '900000', newAnnualCost: '600000',
});
const sourceOf = (p: TeaProjectContent): CalculatedFrom => ({ formA: p.formA, formB: p.formB, compareB: p.compareB, currency: p.currency, scenariosEnabled: p.scenariosEnabled, scenarioForms: p.scenarioForms, handoff: p.handoff });
/** A project that has just been calculated: variant A, variant B and all three scenarios are on. */
function calculated(): TeaProjectContent {
  const p = defaultTeaProject();
  p.formA = form('5000000'); p.formB = form('3000000'); p.compareB = true; p.scenariosEnabled = true;
  p.scenarioForms = { base: form('5000000'), conservative: form('5500000'), optimistic: form('4800000') };
  const from = sourceOf(p);
  return { ...p, calculation: calculationRequestFrom(from), calculatedFrom: from };
}
const edit = (p: TeaProjectContent, patch: Partial<TeaProjectContent>): TeaProjectContent => ({ ...p, ...patch });

test('T1: right after a calculation the results are current; every kind of edit makes them stale', () => {
  const c = calculated();
  assert.equal(isCalculationStale(c), false);
  const cases: Array<[string, TeaProjectContent]> = [
    ['CAPEX of A (5 000 000 -> 9 000 000)', edit(c, { formA: { ...c.formA, capex: { ...c.formA.capex, equipment: '9000000' } } })],
    ['OPEX of A', edit(c, { formA: { ...c.formA, opex: { ...c.formA.opex, labor: '1' } } })],
    ['capacity of A', edit(c, { formA: { ...c.formA, capacity: { ...c.formA.capacity, cycleTimeMinutes: '5' } } })],
    ['OPEX period of A', edit(c, { formA: { ...c.formA, opexPeriod: 'month' } })],
    ['depreciation of A', edit(c, { formA: { ...c.formA, depreciationYears: '3' } })],
    ['economic effect of A', edit(c, { formA: { ...c.formA, newAnnualCost: '1' } })],
    ['CAPEX of B', edit(c, { formB: { ...c.formB, capex: { ...c.formB.capex, equipment: '1' } } })],
    ['OPEX period of B', edit(c, { formB: { ...c.formB, opexPeriod: 'month' } })],
    ['capacity of B', edit(c, { formB: { ...c.formB, capacity: { ...c.formB.capacity, unitsPerCycle: '99' } } })],
    ['base scenario', edit(c, { scenarioForms: { ...c.scenarioForms, base: { ...c.scenarioForms.base, opex: { ...c.scenarioForms.base.opex, labor: '7' } } } })],
    ['conservative scenario', edit(c, { scenarioForms: { ...c.scenarioForms, conservative: form('1') } })],
    ['optimistic scenario', edit(c, { scenarioForms: { ...c.scenarioForms, optimistic: { ...c.scenarioForms.optimistic, opexPeriod: 'month' } } })],
    ['currency', edit(c, { currency: 'USD' })],
    ['variant B switched off', edit(c, { compareB: false })],
    ['scenarios switched off', edit(c, { scenariosEnabled: false })],
  ];
  for (const [name, project] of cases) assert.equal(isCalculationStale(project), true, name);
});

test('T1: editing a value and returning the original makes the saved result current again only on a full match; reload keeps it stale', () => {
  const c = calculated();
  const changed = edit(c, { formA: { ...c.formA, capex: { ...c.formA.capex, equipment: '9000000' } } });
  assert.equal(isCalculationStale(changed), true);
  const back = edit(changed, { formA: { ...changed.formA, capex: { ...changed.formA.capex, equipment: '5000000' } } });
  assert.equal(isCalculationStale(back), false, 'original values restored -> the same inputs -> current');
  const nearly = edit(changed, { formA: { ...changed.formA, capex: { ...changed.formA.capex, equipment: '5000000.0' } } });
  assert.equal(isCalculationStale(nearly), true, 'not a full match of the snapshot -> still stale');
  // reload with changed but not recalculated data: the saved project, read again, is still stale
  const reloaded = parseTeaProject(JSON.parse(JSON.stringify(changed)));
  assert.ok(reloaded);
  assert.equal(isCalculationStale(reloaded as TeaProjectContent), true);
  assert.equal(isCalculationStale(parseTeaProject(JSON.parse(JSON.stringify(c))) as TeaProjectContent), false);
});

test('T1: the screen shows results and the report download only for a current calculation, with the agreed message instead', () => {
  assert.equal(STALE_RESULTS_MESSAGE.startsWith('Исходные данные изменены — выполните расчёт повторно.'), true);
  const src = read('src/components/techno-economic-assessment.tsx');
  assert.ok(src.includes('{STALE_RESULTS_MESSAGE}'));
  for (const gate of ['{resultA && !stale && <section', '{resultB && !stale && <section', '{comparisonRows && !stale && <section', '{scenariosShown && !stale && SCENARIO_KEYS', '{scenarioComparisonRows && !stale && <section']) assert.ok(src.includes(gate), gate);
  // the report download lives inside the variant A results block, which is itself gated
  const block = src.slice(src.indexOf('{resultA && !stale && <section'), src.indexOf('{resultB && !stale && <section'));
  assert.ok(block.includes('<ReportDownload'), 'download is inside the gated block');
  assert.ok(!/\{resultA && <section/.test(src));
});

// ---------- document layout (DOCX) ----------
async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml')!.async('string');
}
const paragraphs = (xml: string): string[] => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string): string => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map(t => t.replace(/<[^>]+>/g, '')).join('');

function sample(rows = 40): GenericDocumentViewModel {
  return {
    title: 'Тест', metadata: [{ label: 'Процесс', value: 'P' }],
    sections: [{ heading: '1. Раздел', paragraphs: ['текст'] }],
    tables: [{ heading: 'Таблица 4.1. Исходные данные', columns: ['Показатель', 'Значение'], rows: Array.from({ length: rows }, (_, i) => [`строка ${i + 1}`, `${i + 1}`]) }],
    traceability: [{ label: 'Версия', value: '1' }, { label: 'Дата', value: '2026' }], traceabilityHeading: 'Traceability', footer: 'Подвал документа',
  };
}

test('D-C2: a table heading and the section headings are kept with what follows them (DOCX keepNext)', async () => {
  const xml = await documentXml(await renderGenericDocx(sample(), { layout: 'portrait' }));
  const ps = paragraphs(xml);
  const heading = ps.find(p => textOf(p) === 'Таблица 4.1. Исходные данные')!;
  assert.ok(heading.includes('<w:keepNext/>'), 'table heading keepNext');
  assert.ok(ps.find(p => textOf(p) === '1. Раздел')!.includes('<w:keepNext/>'), 'section heading keepNext');
  assert.ok(ps.find(p => textOf(p) === 'Traceability')!.includes('<w:keepNext/>'), 'traceability heading keepNext');
  // the header row of a long table is repeated and itself kept with the first body row
  assert.ok(xml.includes('<w:tblHeader/>'));
  const header = xml.slice(xml.indexOf('<w:tr>'), xml.indexOf('</w:tr>'));
  assert.ok(header.includes('<w:keepNext/>'));
});

test('D-C4: every body row of a table is unbreakable across pages; the header row still repeats', async () => {
  const xml = await documentXml(await renderGenericDocx(sample(40), { layout: 'landscape' }));
  const rows = xml.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? [];
  assert.equal(rows.length, 41);
  const body = rows.filter(r => !r.includes('<w:tblHeader/>'));
  assert.equal(body.length, 40);
  assert.ok(body.every(r => r.includes('<w:cantSplit/>')), 'cantSplit on every body row');
  assert.equal(rows.filter(r => r.includes('<w:tblHeader/>')).length, 1);
});

test('D-C1: the closing block (heading, every item, last item and footer) is chained so a footer or one line is never alone on a last page', async () => {
  const xml = await documentXml(await renderGenericDocx(sample(), { layout: 'portrait' }));
  const ps = paragraphs(xml);
  const start = ps.findIndex(p => textOf(p) === 'Traceability');
  const block = ps.slice(start);
  assert.equal(block.length, 4);                                        // heading, 2 items, footer
  assert.ok(block.slice(0, 3).every(p => p.includes('<w:keepNext/>')), 'heading and items keep with the next paragraph');
  assert.ok(!block[3].includes('<w:keepNext/>'), 'the footer is the end of the chain');
  assert.equal(textOf(block[3]), 'Подвал документа');
  const appendix = await documentXml(await renderGenericDocx({ ...sample(), metadataPlacement: 'appendix' }, { layout: 'portrait' }));
  const aps = paragraphs(appendix); const a = aps.slice(aps.findIndex(p => textOf(p) === 'Traceability'));
  assert.ok(a.slice(0, -1).every(p => p.includes('<w:keepNext/>')) && !a[a.length - 1].includes('<w:keepNext/>'));
  // title pages that the structure asks for are untouched
  const withBreak = await documentXml(await renderGenericDocx(sample(), { layout: 'portrait', pageBreakAfterMetadata: true }));
  assert.ok(withBreak.includes('<w:br w:type="page"/>'));
});

// ---------- D-C3: the quality-control table sits in section 8 ----------
const techdoc = () => {
  const mk = (i: number, name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `step-${i}`, order: i, name, type, enabled: true, sources: [], gases: [], coatingMode: 'multi', layers: [], origin: 'user', calculatedFields: [], ...extra });
  return parseTechnicalProcessDocument({
    schemaVersion: 4, pressureUnit: 'pa', general: { processName: 'Тест' }, initialData: {},
    steps: [mk(1, 'Загрузка', 'loading'), mk(2, 'Откачка', 'pumpdown', { pressureStartPa: 101325, pressureEndPa: 0.001, durationMin: 45 }), mk(3, 'Выгрузка', 'unloading')],
    qualityChecks: Array.from({ length: 12 }, (_, i) => ({ id: `qc-${i}`, parameter: `Параметр контроля ${i + 1}`, method: 'M', criterion: '≥ 2', unit: 'мкм', result: '2.1', status: 'pass' })),
    safety: { hazards: ['Высокое напряжение'], ppe: ['Перчатки'], interlocks: ['Блокировка двери'] }, legacy: { stepFields: [], steps: [] },
    traceability: { version: 2, createdAt: '2026-11-09T07:44:29.863Z', updatedAt: '2026-11-09T07:44:59.869Z', source: 'magnetron-pvd' },
  });
};

test('D-C3: in the instruction (DOCX) the quality table follows section 8 and precedes section 9; nothing is lost', async () => {
  const result = await exportTechDoc(techdoc() as never, 'instruction', 'docx');
  const ps = paragraphs(await documentXml(result.buffer)).map(textOf);
  const at = (s: string) => ps.findIndex(t => t === s);
  const i8 = at('8. Контроль качества'), iTable = at('Контроль качества'), i9 = at('9. Требования безопасности'), iT = at('10. Traceability / версия документа');
  assert.ok(i8 >= 0 && iTable > i8 && i9 > iTable && iT > i9, `order: ${[i8, iTable, i9, iT]}`);
  const xml = await documentXml(result.buffer);
  for (let n = 1; n <= 12; n++) assert.ok(xml.includes(`Параметр контроля ${n}<`), `row ${n}`);
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 13);              // header + 12 checks
  for (const part of ['Высокое напряжение', 'Перчатки', 'Блокировка двери', '№1. Загрузка', '№2. Откачка', '№3. Выгрузка', 'Версия: ']) assert.ok(xml.includes(part) || ps.some(t => t.includes(part)), part);
  // the order of the technological steps is unchanged
  assert.ok(ps.findIndex(t => t.startsWith('№1. Загрузка')) < ps.findIndex(t => t.startsWith('№2. Откачка')));
});

test('D-C3: other document types keep their structure (no quality table in the card/route card/recipe, sections unchanged)', async () => {
  for (const type of ['technologicalCard', 'routeCard', 'recipe'] as const) {
    const xml = await documentXml((await exportTechDoc(techdoc() as never, type, 'docx')).buffer);
    assert.ok(!xml.includes('Параметр контроля 1<'), type);
  }
});
