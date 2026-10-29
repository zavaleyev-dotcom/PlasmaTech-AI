import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import { updateStep, createDocumentFromPreset, buildInstructionView, type TechnicalProcessDocument } from '../src/services/workspace/techdoc-assistant';
import { buildDocumentViewModel, exportTechDoc } from '../src/services/workspace/techdoc-export';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const docxXml = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml');
const docxPlain = (buffer: Buffer) => docxXml(buffer).replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function named(doc: TechnicalProcessDocument): TechnicalProcessDocument {
  return { ...doc, general: { ...doc.general, processName: 'AlTiN_PVD' } };
}

// The description of a card ("Описание этапа") is the only free-text field a card keeps: it must reach every document verbatim.

const DESCRIPTION = 'UNIQUE-STEP-DESC-7731: первая строка описания\nВторая строка: смещение −150 V, толщина 0.9 µm, Ar/N2 = 40/10 sccm, Ti–Al, 2**3**2\n\nЧетвёртая строка после пустой: a < b & c > d, 400 °C';

function docWithDescription(description: string | null = DESCRIPTION, order = 5): TechnicalProcessDocument {
  const doc = named(createDocumentFromPreset('magnetron-pvd'));
  return { ...doc, steps: updateStep(doc.steps, order, { description: description ?? undefined, durationMin: 60, temperatureC: 350 }) };
}

test('view model: the instruction contains the full step description, byte for byte, with its line breaks', () => {
  const vm = buildDocumentViewModel(docWithDescription(), 'instruction');
  const paragraphs = vm.sections.find(s => s.heading.startsWith('7.'))!.paragraphs;
  const stepParagraph = paragraphs.find(p => p.startsWith('№5.'))!;
  assert.ok(stepParagraph.includes(`Описание: ${DESCRIPTION}`), 'description printed verbatim, newlines and the blank line included');
  assert.ok(stepParagraph.startsWith('№5.') && stepParagraph.includes('Продолжительность: 60 мин'), 'the existing step summary is unchanged');
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
  doc = { ...doc, steps: updateStep(doc.steps, 8, { description: 'Контроль выгрузки, 5 µm ± 0.2' }) };
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
  doc = { ...doc, steps: doc.steps.map(s => s.order === 5 ? { ...s, enabled: false } : s) };
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

test('the technological card prints the step description in its own column; the route card and the brief recipe never print it', async () => {
  const card = buildDocumentViewModel(docWithDescription(), 'technologicalCard');
  const cardRow = card.tables[0].rows.find(r => r[0] === '5')!;
  assert.equal(cardRow[9], DESCRIPTION, 'the description column holds the text verbatim');
  assert.equal(card.tables[0].columns[9], 'Описание');
  for (const type of ['routeCard', 'recipe'] as const) {
    const vm = buildDocumentViewModel(docWithDescription(), type);
    assert.ok(!JSON.stringify([vm.sections, vm.tables]).includes('UNIQUE-STEP-DESC-7731'), type);
  }
});
