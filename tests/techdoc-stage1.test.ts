import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import {
  addMagnetron, addArcSource, removeMagnetron, removeArcSource, updateMagnetron, updateArcSource, updateStep,
  createBlankDocument, createDocumentFromPreset, ensureUniqueSourceIds, findDuplicateSourceIds, buildInstructionView,
  restoreDocumentWithReport, tryRestoreDocument,
  type TechnicalProcessDocument, type SourceSet,
} from '../src/services/workspace/techdoc-assistant';
import { buildDocumentViewModel, exportTechDoc, parseTechnicalProcessDocument } from '../src/services/workspace/techdoc-export';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const docxXml = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml');
const docxPlain = (buffer: Buffer) => docxXml(buffer).replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const ids = (list: readonly { id: string }[]) => list.map(item => item.id);
const unique = (list: readonly string[]) => new Set(list).size === list.length;
const roundTrip = (doc: TechnicalProcessDocument): TechnicalProcessDocument => {
  const restored = tryRestoreDocument(JSON.stringify(doc));
  assert.ok(restored, 'the saved document must restore');
  return restored;
};
function named(doc: TechnicalProcessDocument): TechnicalProcessDocument {
  return { ...doc, general: { ...doc.general, processName: 'AlTiN_PVD' } };
}

// =====================================================================================
// Defect 1 - source ids stay unique across save / restore / add / edit / delete
// =====================================================================================

test('ids: sources added to a document are unique and sequential', () => {
  let sources: SourceSet = createBlankDocument().sources;
  for (let i = 0; i < 4; i++) sources = addMagnetron(sources);
  for (let i = 0; i < 3; i++) sources = addArcSource(sources);
  assert.deepEqual(ids(sources.magnetrons), ['magnetron-1', 'magnetron-2', 'magnetron-3', 'magnetron-4']);
  assert.deepEqual(ids(sources.arcSources), ['arc-1', 'arc-2', 'arc-3']);
});

test('ids: after save + restore, adding a magnetron or arc source never repeats an existing id (the audit scenario)', () => {
  let doc = named(createBlankDocument());
  doc = { ...doc, sources: addMagnetron(addMagnetron(doc.sources)) };
  doc = { ...doc, sources: addArcSource(addArcSource(doc.sources)) };
  const restored = roundTrip(doc);
  assert.deepEqual(ids(restored.sources.magnetrons), ['magnetron-1', 'magnetron-2']);

  const grown = { ...restored.sources, ...{ magnetrons: addMagnetron(restored.sources).magnetrons, arcSources: addArcSource(restored.sources).arcSources } };
  assert.deepEqual(ids(grown.magnetrons), ['magnetron-1', 'magnetron-2', 'magnetron-3']);
  assert.deepEqual(ids(grown.arcSources), ['arc-1', 'arc-2', 'arc-3']);
  assert.ok(unique(ids(grown.magnetrons)) && unique(ids(grown.arcSources)));
});

test('ids: repeated save/restore/add cycles never produce a duplicate', () => {
  let doc = named(createBlankDocument());
  for (let cycle = 0; cycle < 6; cycle++) {
    doc = { ...doc, sources: addArcSource(addMagnetron(doc.sources)) };
    doc = roundTrip(doc);
    assert.ok(unique(ids(doc.sources.magnetrons)), `cycle ${cycle}: magnetron ids`);
    assert.ok(unique(ids(doc.sources.arcSources)), `cycle ${cycle}: arc ids`);
  }
  assert.equal(doc.sources.magnetrons.length, 6);
});

test('ids: the next id is derived from what exists - gaps, huge, non-numeric and foreign-prefix ids can never be duplicated', () => {
  const base = createBlankDocument().sources;
  const m = (id: string) => ({ id, enabled: true });
  const cases: [string[], string][] = [
    [['magnetron-1', 'magnetron-5'], 'magnetron-6'],
    [['magnetron-2', 'magnetron-3'], 'magnetron-4'],
    [['magnetron-abc', 'x'], 'magnetron-1'],
    [['magnetron-99999999999'], 'magnetron-1'],
    [['magnetron-1', 'magnetron-2', 'magnetron-3'], 'magnetron-4'],
    [['arc-7', 'magnetron-2'], 'magnetron-3'],
  ];
  for (const [existing, expected] of cases) {
    const next = addMagnetron({ ...base, magnetrons: existing.map(m) }).magnetrons.at(-1)!.id;
    assert.equal(next, expected, JSON.stringify(existing));
    assert.ok(!existing.includes(next));
  }
});

test('edit: updating a source by id changes exactly one record, also after restore + add', () => {
  let doc = named(createBlankDocument());
  doc = { ...doc, sources: addMagnetron(addMagnetron(doc.sources)) };
  doc = roundTrip(doc);
  doc = { ...doc, sources: addMagnetron(doc.sources) };
  doc = { ...doc, sources: addArcSource(addArcSource(doc.sources)) };
  doc = roundTrip(doc);
  doc = { ...doc, sources: addArcSource(doc.sources) };

  const edited = updateMagnetron(doc.sources, 'magnetron-2', { material: 'Ti', powerW: 1500, mode: 'pulsed DC' });
  assert.deepEqual(edited.magnetrons.map(x => x.material), [undefined, 'Ti', undefined]);
  assert.equal(edited.magnetrons.filter(x => x.powerW === 1500).length, 1);
  const editedArc = updateArcSource(doc.sources, 'arc-3', { cathodeMaterial: 'Cr', arcCurrentA: 80, filtered: true });
  assert.deepEqual(editedArc.arcSources.map(x => x.cathodeMaterial), [undefined, undefined, 'Cr']);
  assert.equal(editedArc.arcSources.filter(x => x.filtered).length, 1);
});

test('delete: removing a source by id removes exactly one record, also after restore + add; the rest keep their data', () => {
  let doc = named(createBlankDocument());
  doc = { ...doc, sources: addMagnetron(addMagnetron(doc.sources)) };
  doc = { ...doc, sources: { ...doc.sources, magnetrons: updateMagnetron(doc.sources, 'magnetron-1', { material: 'Al' }).magnetrons.map(x => x.id === 'magnetron-2' ? { ...x, material: 'Ti' } : x) } };
  doc = roundTrip(doc);
  doc = { ...doc, sources: addMagnetron(doc.sources) };
  doc = { ...doc, sources: { ...doc.sources, magnetrons: updateMagnetron(doc.sources, 'magnetron-3', { material: 'Cr' }).magnetrons } };

  const without2 = removeMagnetron(doc.sources, 'magnetron-2');
  assert.deepEqual(without2.magnetrons.map(x => [x.id, x.material]), [['magnetron-1', 'Al'], ['magnetron-3', 'Cr']]);
  const again = addMagnetron(without2).magnetrons.map(x => x.id);
  assert.ok(unique(again) && again.length === 3);

  let arcs = addArcSource(addArcSource(addArcSource(createBlankDocument().sources)));
  arcs = updateArcSource(arcs, 'arc-2', { cathodeMaterial: 'Cr' });
  assert.deepEqual(removeArcSource(arcs, 'arc-2').arcSources.map(x => x.id), ['arc-1', 'arc-3']);
  assert.equal(removeArcSource(arcs, 'no-such-id').arcSources.length, 3);
});

test('restore: a saved document with DUPLICATE ids is repaired - first keeps its id, later ones get new unique ids, no parameter changes', () => {
  const doc = named(createBlankDocument());
  const damaged: TechnicalProcessDocument = { ...doc, sources: { ...doc.sources,
    magnetrons: [
      { id: 'magnetron-1', enabled: true, material: 'Ti', powerW: 1000, mode: 'DC' },
      { id: 'magnetron-1', enabled: false, material: 'Al', powerW: 2000, mode: 'RF' },
      { id: 'magnetron-2', enabled: true, material: 'Cr', powerW: 3000 },
      { id: 'magnetron-1', enabled: true, material: 'Zr', powerW: 4000 },
    ],
    arcSources: [
      { id: 'arc-1', enabled: true, cathodeMaterial: 'Ti', arcCurrentA: 60, filtered: true },
      { id: 'arc-1', enabled: true, cathodeMaterial: 'Cr', arcCurrentA: 70, filtered: false },
    ],
  } };
  assert.deepEqual(findDuplicateSourceIds(damaged.sources), { magnetrons: ['magnetron-1'], arcSources: ['arc-1'] });

  const report = restoreDocumentWithReport(JSON.stringify(damaged));
  assert.ok(report);
  assert.equal(report.repairedSourceIds, 3);
  const { magnetrons, arcSources } = report.document.sources;
  assert.ok(unique(ids(magnetrons)) && unique(ids(arcSources)));
  assert.deepEqual(findDuplicateSourceIds(report.document.sources), { magnetrons: [], arcSources: [] });
  assert.equal(magnetrons[0].id, 'magnetron-1');
  assert.equal(magnetrons[2].id, 'magnetron-2');
  assert.equal(arcSources[0].id, 'arc-1');
  const strip = (list: readonly { id: string }[]) => list.map(item => { const rest: Record<string, unknown> = { ...item }; delete rest.id; return rest; });
  const json = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(json(strip(magnetrons)), json(strip(damaged.sources.magnetrons)), 'every user parameter and the order are unchanged');
  assert.deepEqual(json(strip(arcSources)), json(strip(damaged.sources.arcSources)));
  assert.deepEqual(tryRestoreDocument(JSON.stringify(damaged))?.sources, report.document.sources, 'tryRestoreDocument repairs too');

  // After repair, editing/removing one record touches exactly that record.
  const edited = updateMagnetron(report.document.sources, magnetrons[1].id, { material: 'EDITED' });
  assert.equal(edited.magnetrons.filter(x => x.material === 'EDITED').length, 1);
  assert.equal(removeMagnetron(report.document.sources, magnetrons[3].id).magnetrons.length, 3);
  assert.equal(restoreDocumentWithReport(JSON.stringify(report.document))?.repairedSourceIds, 0, 'a repaired document is stable');
});

test('restore: empty ids are replaced; a clean document is restored unchanged with nothing reported', () => {
  const doc = named(createBlankDocument());
  const withEmpty = { ...doc, sources: { ...doc.sources, magnetrons: [{ id: '', enabled: true, material: 'Ti' }, { id: 'magnetron-1', enabled: true, material: 'Al' }] } };
  const repaired = restoreDocumentWithReport(JSON.stringify(withEmpty));
  assert.ok(repaired && repaired.repairedSourceIds === 1);
  assert.deepEqual(ids(repaired.document.sources.magnetrons), ['magnetron-2', 'magnetron-1']);
  assert.deepEqual(repaired.document.sources.magnetrons.map(x => x.material), ['Ti', 'Al']);

  let clean = { ...doc, sources: addArcSource(addMagnetron(addMagnetron(doc.sources))) };
  clean = { ...clean, sources: updateMagnetron(clean.sources, 'magnetron-2', { material: 'Ti', powerW: 1200 }) };
  const result = restoreDocumentWithReport(JSON.stringify(clean));
  assert.ok(result);
  assert.equal(result.repairedSourceIds, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.document)), JSON.parse(JSON.stringify(clean)));
});

test('restore: ensureUniqueSourceIds leaves a clean set untouched (same object)', () => {
  const clean = addMagnetron(createBlankDocument().sources);
  assert.equal(ensureUniqueSourceIds(clean).sources, clean);
  assert.equal(ensureUniqueSourceIds(clean).repaired, 0);
});

test('restore: bad input still falls back to null (no regression)', () => {
  assert.equal(restoreDocumentWithReport(null), null);
  assert.equal(restoreDocumentWithReport('not json'), null);
  assert.equal(restoreDocumentWithReport('{"general":{"processName":""}}'), null);
});

test('export: a document that arrives with duplicate source ids is still exported completely (ids are internal, not printed)', async () => {
  const doc = named(createBlankDocument());
  const dup = { ...doc, sources: { ...doc.sources, magnetrons: [{ id: 'magnetron-1', enabled: true, material: 'Ti', powerW: 1000 }, { id: 'magnetron-1', enabled: true, material: 'Al', powerW: 2000 }] } };
  const { buffer } = await exportTechDoc(dup, 'instruction', 'docx');
  const text = docxPlain(buffer);
  assert.ok(text.includes('материал — Ti') && text.includes('материал — Al'));
});

// =====================================================================================
// Defect 2 - the step description reaches the exported instruction
// =====================================================================================

const DESCRIPTION = 'UNIQUE-STEP-DESC-7731: первая строка описания\nВторая строка: смещение −150 V, толщина 0.9 µm, Ar/N2 = 40/10 sccm, Ti–Al, 2**3**2\n\nЧетвёртая строка после пустой: a < b & c > d, 400 °C';

function docWithDescription(description: string | null = DESCRIPTION, order = 6): TechnicalProcessDocument {
  const doc = named(createDocumentFromPreset('magnetron-pvd'));
  return { ...doc, steps: updateStep(doc.steps, order, { description: description ?? undefined, durationMin: 60, temperatureC: 350 }) };
}

test('view model: the instruction contains the full step description, byte for byte, with its line breaks', () => {
  const vm = buildDocumentViewModel(docWithDescription(), 'instruction');
  const paragraphs = vm.sections.find(s => s.heading.startsWith('7.'))!.paragraphs;
  const stepParagraph = paragraphs.find(p => p.startsWith('№6.'))!;
  assert.ok(stepParagraph.includes(`\nОписание: ${DESCRIPTION}`), 'description appended verbatim, newlines and the blank line included');
  assert.ok(stepParagraph.startsWith('№6.') && stepParagraph.includes('длительность: 60 мин'), 'the existing step summary is unchanged');
  assert.equal(paragraphs.filter(p => p.includes('UNIQUE-STEP-DESC-7731')).length, 1);
});

test('view model: a step without a description (or with only whitespace) prints no "Описание"', () => {
  for (const description of [null, '', '   \n  ']) {
    const vm = buildDocumentViewModel(docWithDescription(description), 'instruction');
    assert.ok(!vm.sections.flatMap(s => s.paragraphs).some(p => p.includes('Описание:')), JSON.stringify(description));
  }
});

test('DOCX: the multi-line description is in the document verbatim - lines, blank line, order and exact notation', async () => {
  const { buffer } = await exportTechDoc(docWithDescription(), 'instruction', 'docx');
  const text = docxPlain(buffer);
  assert.ok(text.includes(`Описание: ${DESCRIPTION}`), 'the whole description, newlines and the blank line included');
  for (const token of ['−150 V', '0.9 µm', 'Ar/N2 = 40/10 sccm', 'Ti–Al', '2**3**2', 'a < b & c > d', '400 °C']) assert.ok(text.includes(token), token);
  assert.ok(docxXml(buffer).split('<w:br/>').length - 1 >= 3, 'the description lines are real Word line breaks');
});

test('PDF: the multi-line description is extractable from the real file', async () => {
  const { buffer } = await exportTechDoc(docWithDescription(), 'instruction', 'pdf');
  const text = (await pdfText(buffer)).replace(/μ/g, 'µ').replace(/\s+/g, ' ');
  for (const part of [
    'Описание: UNIQUE-STEP-DESC-7731: первая строка описания', 'Вторая строка: смещение −150 V', 'толщина 0.9 µm', 'Ar/N2 = 40/10 sccm',
    'Ti–Al', '2**3**2', 'Четвёртая строка после пустой: a < b & c > d, 400 °C',
  ]) assert.ok(text.includes(part), `PDF is missing: ${part}`);
});

test('preview and export agree: every enabled step description shown in the on-screen instruction is also in the exported document', async () => {
  let doc = docWithDescription();
  doc = { ...doc, steps: updateStep(doc.steps, 1, { description: 'Загрузка: проверить оснастку.\nЗафиксировать подложки (шаг 10 мм).' }) };
  doc = { ...doc, steps: updateStep(doc.steps, 9, { description: 'Контроль толщины, 5 µm ± 0.2' }) };
  const preview = buildInstructionView(doc);
  const exported = docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer);
  const described = doc.steps.filter(s => s.enabled && s.description);
  assert.equal(described.length, 3);
  for (const step of described) {
    assert.ok(preview.includes(step.description!), `preview step ${step.order}`);
    assert.ok(exported.includes(step.description!.split('\n')[0]) && exported.includes(step.description!.split('\n').at(-1)!), `export step ${step.order}`);
  }
});

test('a disabled step keeps its description in the export, like its other fields (the preview shows none of a disabled step\'s details)', async () => {
  let doc = docWithDescription();
  doc = { ...doc, steps: doc.steps.map(s => s.order === 6 ? { ...s, enabled: false } : s) };
  const text = docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer);
  assert.ok(text.includes('UNIQUE-STEP-DESC-7731') && text.includes('(отключён)'));
});

test('description survives the real export route (untrusted JSON parse -> validate -> render)', async () => {
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: docWithDescription(), documentType: 'instruction', format: 'docx' }),
  }));
  assert.equal(response.status, 200);
  const text = docxPlain(Buffer.from(await response.arrayBuffer()));
  assert.ok(text.includes('UNIQUE-STEP-DESC-7731') && text.includes('Четвёртая строка после пустой'));
  const pdf = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: docWithDescription(), documentType: 'instruction', format: 'pdf' }),
  }));
  assert.ok((await pdfText(Buffer.from(await pdf.arrayBuffer()))).includes('UNIQUE-STEP-DESC-7731'));
});

test('other document types are unchanged by the description fix (card/route/recipe never print a step description)', async () => {
  for (const type of ['technologicalCard', 'routeCard', 'recipe'] as const) {
    const vm = buildDocumentViewModel(docWithDescription(), type);
    const everything = JSON.stringify([vm.sections, vm.tables]);
    assert.ok(!everything.includes('UNIQUE-STEP-DESC-7731'), type);
  }
});

// =====================================================================================
// Id assignment order on restore: explicit ids are reserved BEFORE ids are assigned
// =====================================================================================

type RawSources = { magnetrons?: Record<string, unknown>[]; arcSources?: Record<string, unknown>[] };
function restoreRaw(sources: RawSources) {
  const raw = JSON.parse(JSON.stringify({ ...createBlankDocument(), general: { processName: 'X' } }));
  raw.sources.magnetrons = sources.magnetrons ?? [];
  raw.sources.arcSources = sources.arcSources ?? [];
  const report = restoreDocumentWithReport(JSON.stringify(raw));
  assert.ok(report, 'must restore');
  return report;
}
const mats = (r: ReturnType<typeof restoreRaw>) => r.document.sources.magnetrons.map(m => `${m.material}:${m.id}`);
const arcs = (r: ReturnType<typeof restoreRaw>) => r.document.sources.arcSources.map(a => `${a.cathodeMaterial}:${a.id}`);

test('restore order (audit case): Ti without an id, Al with "magnetron-0" - Al KEEPS magnetron-0, Ti gets a new unique id (magnetrons and arcs alike)', () => {
  const r = restoreRaw({
    magnetrons: [{ material: 'Ti' }, { id: 'magnetron-0', material: 'Al' }],
    arcSources: [{ cathodeMaterial: 'Ti', filtered: true }, { id: 'arc-0', cathodeMaterial: 'Cr', filtered: false }],
  });
  assert.deepEqual(mats(r), ['Ti:magnetron-1', 'Al:magnetron-0']);
  assert.deepEqual(arcs(r), ['Ti:arc-1', 'Cr:arc-0']);
  assert.equal(r.repairedSourceIds, 2, 'only the id-less records count as repaired');
});

test('restore order: explicit ids are reserved first wherever the id-less records sit in the list', () => {
  const before = restoreRaw({ magnetrons: [{ material: 'A' }, { material: 'B' }, { id: 'magnetron-1', material: 'C' }, { id: 'magnetron-2', material: 'D' }] });
  assert.deepEqual(mats(before), ['A:magnetron-3', 'B:magnetron-4', 'C:magnetron-1', 'D:magnetron-2']);
  const after = restoreRaw({ magnetrons: [{ id: 'magnetron-1', material: 'C' }, { material: 'A' }, { id: 'magnetron-3', material: 'D' }, { material: 'B' }] });
  assert.deepEqual(mats(after), ['C:magnetron-1', 'A:magnetron-4', 'D:magnetron-3', 'B:magnetron-5']);
  const arcsOnly = restoreRaw({ arcSources: [{ cathodeMaterial: 'A' }, { id: 'arc-1', cathodeMaterial: 'B' }, { cathodeMaterial: 'C' }] });
  assert.deepEqual(arcs(arcsOnly), ['A:arc-2', 'B:arc-1', 'C:arc-3']);
});

test('restore order: with REAL duplicates the first explicit owner keeps the id, even when an id-less record precedes it', () => {
  const r = restoreRaw({ magnetrons: [{ material: 'Ti' }, { id: 'magnetron-0', material: 'Al' }, { id: 'magnetron-0', material: 'Cr' }, { id: 'magnetron-1', material: 'Zr' }] });
  assert.deepEqual(mats(r), ['Ti:magnetron-2', 'Al:magnetron-0', 'Cr:magnetron-3', 'Zr:magnetron-1']);
  assert.equal(r.repairedSourceIds, 2);
  const a = restoreRaw({ arcSources: [{ cathodeMaterial: 'Ti' }, { id: 'arc-0', cathodeMaterial: 'Al' }, { id: 'arc-0', cathodeMaterial: 'Cr' }] });
  assert.deepEqual(arcs(a), ['Ti:arc-1', 'Al:arc-0', 'Cr:arc-2']);
});

test('restore order: non-standard ids are respected (kept as written) and never reused', () => {
  const r = restoreRaw({ magnetrons: [
    { material: 'A' }, { id: 'MAGNETRON-1', material: 'B' }, { id: 'magnetron-01', material: 'C' }, { id: 'Ti-source', material: 'D' },
    { id: 'magnetron-99999999999', material: 'E' }, { id: '   ', material: 'F' }, { id: 'magnetron-1', material: 'G' },
  ] });
  const result = r.document.sources.magnetrons;
  assert.deepEqual(result.slice(1, 5).map(m => m.id), ['MAGNETRON-1', 'magnetron-01', 'Ti-source', 'magnetron-99999999999'], 'explicit non-empty ids are untouched');
  assert.equal(result[6].id, 'magnetron-1', 'a non-colliding explicit id stays');
  assert.ok(unique(ids(result)));
  const fresh = [result[0].id, result[5].id];
  assert.ok(fresh.every(id => !['MAGNETRON-1', 'magnetron-01', 'Ti-source', 'magnetron-99999999999', 'magnetron-1'].includes(id)), `new ids never collide: ${fresh}`);
  assert.deepEqual(result.map(m => m.material), ['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'order and materials untouched');
});

test('restore order: materials, parameters, order and enabled/filtered states are untouched by the id assignment', () => {
  const r = restoreRaw({
    magnetrons: [{ material: 'Ti', powerW: 1000, mode: 'DC', enabled: false }, { id: 'magnetron-0', material: 'Al', powerW: 2000, mode: 'RF', enabled: true }, { material: 'Cr', powerW: 3000, enabled: true }],
    arcSources: [{ cathodeMaterial: 'Ti', arcCurrentA: 60, filtered: true, enabled: false }, { id: 'arc-0', cathodeMaterial: 'Cr', arcCurrentA: 70, filtered: false, enabled: true }],
  });
  const strip = (list: readonly { id: string }[]) => JSON.parse(JSON.stringify(list.map(item => { const rest: Record<string, unknown> = { ...item }; delete rest.id; return rest; })));
  assert.deepEqual(strip(r.document.sources.magnetrons), [
    { enabled: false, material: 'Ti', powerW: 1000, mode: 'DC' }, { enabled: true, material: 'Al', powerW: 2000, mode: 'RF' }, { enabled: true, material: 'Cr', powerW: 3000 },
  ]);
  assert.deepEqual(strip(r.document.sources.arcSources), [
    { enabled: false, cathodeMaterial: 'Ti', arcCurrentA: 60, filtered: true }, { enabled: true, cathodeMaterial: 'Cr', arcCurrentA: 70, filtered: false },
  ]);
});

test('restore order: restoring again is stable (nothing left to repair, ids identical), and later adds stay unique', () => {
  const first = restoreRaw({ magnetrons: [{ material: 'Ti' }, { id: 'magnetron-0', material: 'Al' }, { id: 'magnetron-0', material: 'Cr' }], arcSources: [{ cathodeMaterial: 'Ti' }, { id: 'arc-0', cathodeMaterial: 'Cr' }] });
  const second = restoreDocumentWithReport(JSON.stringify(first.document));
  assert.ok(second);
  assert.equal(second.repairedSourceIds, 0);
  assert.deepEqual(ids(second.document.sources.magnetrons), ids(first.document.sources.magnetrons));
  assert.deepEqual(ids(second.document.sources.arcSources), ids(first.document.sources.arcSources));
  const third = roundTrip(second.document);
  const grown = { magnetrons: addMagnetron(third.sources).magnetrons, arcSources: addArcSource(third.sources).arcSources };
  assert.ok(unique(ids(grown.magnetrons)) && unique(ids(grown.arcSources)));
  const target = grown.magnetrons[1].id;
  assert.equal(updateMagnetron(third.sources, target, { material: 'EDIT' }).magnetrons.filter(m => m.material === 'EDIT').length, 1);
  assert.equal(removeMagnetron(third.sources, target).magnetrons.length, 2);
});

test('parse: a source without an id keeps an empty id (assigned only by the repair step); a non-string id is still rejected', () => {
  const doc = JSON.parse(JSON.stringify(createBlankDocument()));
  doc.general.processName = 'X';
  doc.sources.magnetrons = [{ material: 'Ti' }];
  assert.equal(parseTechnicalProcessDocument(doc).sources.magnetrons[0].id, '');
  doc.sources.magnetrons = [{ id: 5, material: 'Ti' }];
  assert.throws(() => parseTechnicalProcessDocument(doc), /id/);
});

test('export route: a document whose sources have no ids still exports, and validation messages name the record by position', async () => {
  const doc = JSON.parse(JSON.stringify(createBlankDocument()));
  doc.general.processName = 'X';
  doc.sources.magnetrons = [{ material: 'Ti', powerW: 1000 }, { id: 'magnetron-0', material: 'Al', powerW: 2000 }];
  const send = (document: unknown) => exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document, documentType: 'instruction', format: 'docx' }),
  }));
  const ok = await send(doc);
  assert.equal(ok.status, 200);
  const text = docxPlain(Buffer.from(await ok.arrayBuffer()));
  assert.ok(text.includes('материал — Ti') && text.includes('материал — Al'));
  doc.sources.magnetrons[0].powerW = -5;
  const bad = await send(doc);
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /Магнетрон #1/);
});
