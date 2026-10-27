'use client';

import { useEffect, useState } from 'react';
import {
  createBlankDocument, createDocumentFromPreset, validateDocument, touchDocument, restoreDocumentDetailed,
  PRESSURE_UNITS, PRESSURE_UNIT_LABELS, paToDisplayInputValue, parsePressureInput,
  PROCESS_PRESETS, STEP_TYPES, STEP_TYPE_LABELS, QUALITY_CHECK_CATEGORIES,
  addStep, removeStep, duplicateStep, moveStep, toggleStepEnabled, updateStep, calculateStepDurationFromDeposition,
  addGasLine, updateGasLine,
  addMagnetron, updateMagnetron, addArcSource, updateArcSource,
  addSourceAssignment, updateSourceAssignment, removeSourceAssignment, addGasAssignment, updateGasAssignment, removeGasAssignment,
  removeSourceFromDocument, removeGasLineFromDocument, collectStepWarnings,
  SOURCE_KIND_LABELS, ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS,
  createQualityCheck,
  buildTechnologicalCard, buildRouteCard, buildInstructionView, buildBriefRecipe,
  type TechnicalProcessDocument, type ProcessStep, type StepType, type QualityCheck, type PressureUnit, type SourceSet, type GasLine, type SourceKind, type AssignmentMode,
} from '@/services/workspace/techdoc-assistant';
import { DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, type DocumentType, type ExportFormat } from '@/services/workspace/techdoc-export-types';

type ViewMode = 'instruction' | 'techcard' | 'routecard' | 'recipe';

/** This browser's own localStorage only - never sent to a server, never shared across devices
 *  or browsers. See the honest wording in save()'s notice below. */
const STORAGE_KEY = 'techdoc-assistant:document';

const UNREADABLE_NOTICE = (reason: string) => `Сохранённый документ не загружен: ${reason} Он не изменён и не удалён. Сохранение поверх него отключено, пока вы явно не подтвердите замену.`;
const FUTURE_VERSION_NOTICE = (version: number) => `В этом браузере сохранён документ более новой схемы (версия ${version}); эта версия приложения её не понимает, поэтому документ не загружен. Он не изменён и не удалён. Сохранение поверх него отключено, пока вы явно не подтвердите замену.`;

function num(v: string): number | undefined { return v.trim() === '' ? undefined : Number(v); }

const ASSIGNMENT_STEP_TYPES: StepType[] = ['adhesion_underlayer', 'multilayer_coating'];
const INPUT = 'rounded-md border border-[#dce0e5] p-2 mt-1 block';

/** Which sources of section D and which gas lines of section E are USED on this step, and how.
 *  Materials and gas names are read from D/E, never typed here. */
function StepAssignments({ step, sources, gasSystem, onChange }: { step: ProcessStep; sources: SourceSet; gasSystem: GasLine[]; onChange: (updater: (steps: ProcessStep[]) => ProcessStep[]) => void }) {
  const [sourcePick, setSourcePick] = useState('');
  const [linePick, setLinePick] = useState('');

  const allSources = [
    ...sources.magnetrons.map(m => ({ kind: 'magnetron' as SourceKind, id: m.id, usable: m.enabled, text: `${m.material?.trim() ? m.material : 'материал не задан'}` })),
    ...sources.arcSources.map(a => ({ kind: 'arc' as SourceKind, id: a.id, usable: a.enabled, text: `${a.cathodeMaterial?.trim() ? a.cathodeMaterial : 'материал не задан'}${a.filtered ? ', фильтрованный' : ''}` })),
  ];
  const freeSources = allSources.filter(x => !step.sourceAssignments.some(a => a.kind === x.kind && a.sourceId === x.id));
  const freeLines = gasSystem.filter(l => !step.gasAssignments.some(a => a.lineId === l.id));
  const patchSource = (kind: SourceKind, id: string, p: Parameters<typeof updateSourceAssignment>[4]) => onChange(steps => updateSourceAssignment(steps, step.order, kind, id, p));
  const patchGas = (id: string, p: Parameters<typeof updateGasAssignment>[3]) => onChange(steps => updateGasAssignment(steps, step.order, id, p));

  return <div className="mt-3 content-card">
    <h4>Источники на этапе (из раздела D)</h4>
    <p className="muted small">Раздел D описывает оборудование установки; здесь задаётся, что включено именно на этом этапе. Материал мишени или катода берётся из раздела D. Время - в минутах от начала этапа. «Последовательно» - интервал не пересекается с интервалами других включённых источников этапа.</p>
    {step.sourceAssignments.length === 0 && <p className="muted small">Источники на этапе не назначены.</p>}
    {step.sourceAssignments.map(a => {
      const known = allSources.find(x => x.kind === a.kind && x.id === a.sourceId);
      return <div key={`${a.kind}:${a.sourceId}`} className="flex flex-wrap gap-3 items-end mt-2 border border-[#dce0e5] rounded-md p-2">
        <strong className="text-sm">{SOURCE_KIND_LABELS[a.kind]} {a.sourceId}<br /><span className="muted small">{known ? (a.kind === 'magnetron' ? 'мишень: ' : 'катод: ') + known.text : 'нет в разделе D'}</span></strong>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.enabled} onChange={e => patchSource(a.kind, a.sourceId, { enabled: e.target.checked })} /> Включён на этапе</label>
        {a.kind === 'magnetron'
          ? <label className="text-sm">Мощность на этапе, Вт<input type="number" step="any" min={0} className={INPUT} value={a.powerW ?? ''} onChange={e => patchSource(a.kind, a.sourceId, { powerW: num(e.target.value) })} /></label>
          : <label className="text-sm">Ток дуги на этапе, А<input type="number" step="any" min={0} className={INPUT} value={a.currentA ?? ''} onChange={e => patchSource(a.kind, a.sourceId, { currentA: num(e.target.value) })} /></label>}
        <label className="text-sm">Начало, мин<input type="number" step="any" min={0} className={INPUT} value={a.startMin ?? ''} onChange={e => patchSource(a.kind, a.sourceId, { startMin: num(e.target.value) })} /></label>
        <label className="text-sm">Длительность, мин<input type="number" step="any" min={0} className={INPUT} value={a.durationMin ?? ''} onChange={e => patchSource(a.kind, a.sourceId, { durationMin: num(e.target.value) })} /></label>
        <label className="text-sm">Режим
          <select className={INPUT} value={a.mode} onChange={e => patchSource(a.kind, a.sourceId, { mode: e.target.value as AssignmentMode })}>
            {ASSIGNMENT_MODES.map(mode => <option key={mode} value={mode}>{ASSIGNMENT_MODE_LABELS[mode]}</option>)}
          </select>
        </label>
        <button type="button" className="button secondary" onClick={() => onChange(steps => removeSourceAssignment(steps, step.order, a.kind, a.sourceId))}>Снять назначение</button>
      </div>;
    })}
    <div className="flex flex-wrap gap-2 items-end mt-2">
      <label className="text-sm">Назначить источник
        <select className={INPUT} value={sourcePick} onChange={e => setSourcePick(e.target.value)}>
          <option value="">{freeSources.length === 0 ? (allSources.length === 0 ? 'Сначала добавьте источники в разделе D' : 'Все источники уже назначены') : 'Выберите источник…'}</option>
          {freeSources.map(x => <option key={`${x.kind}:${x.id}`} value={`${x.kind}:${x.id}`} disabled={!x.usable}>{SOURCE_KIND_LABELS[x.kind]} {x.id} ({x.text}){x.usable ? '' : ' - отключён в установке'}</option>)}
        </select>
      </label>
      <button type="button" className="button secondary" disabled={!sourcePick} onClick={() => {
        const [kind, ...rest] = sourcePick.split(':');
        onChange(steps => addSourceAssignment(steps, step.order, kind as SourceKind, rest.join(':')));
        setSourcePick('');
      }}>Назначить</button>
    </div>

    <h4 className="mt-4">Газовые линии на этапе (из раздела E)</h4>
    <p className="muted small">Газ берётся из раздела E. Расход задаётся в sccm (стандартные см³/мин) и не пересчитывается из других единиц.</p>
    {step.gasAssignments.length === 0 && <p className="muted small">Газовые линии на этапе не назначены.</p>}
    {step.gasAssignments.map(a => {
      const line = gasSystem.find(l => l.id === a.lineId);
      return <div key={a.lineId} className="flex flex-wrap gap-3 items-end mt-2 border border-[#dce0e5] rounded-md p-2">
        <strong className="text-sm">Линия {a.lineId}<br /><span className="muted small">{line ? `газ: ${line.gas.trim() ? line.gas : 'не указан в разделе E'}` : 'нет в разделе E'}</span></strong>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.enabled} onChange={e => patchGas(a.lineId, { enabled: e.target.checked })} /> Подача включена</label>
        <label className="text-sm">Расход, sccm<input type="number" step="any" min={0} className={INPUT} value={a.flowSccm ?? ''} onChange={e => patchGas(a.lineId, { flowSccm: num(e.target.value) })} /></label>
        <label className="text-sm">Начало подачи, мин<input type="number" step="any" min={0} className={INPUT} value={a.startMin ?? ''} onChange={e => patchGas(a.lineId, { startMin: num(e.target.value) })} /></label>
        <label className="text-sm">Длительность подачи, мин<input type="number" step="any" min={0} className={INPUT} value={a.durationMin ?? ''} onChange={e => patchGas(a.lineId, { durationMin: num(e.target.value) })} /></label>
        <button type="button" className="button secondary" onClick={() => onChange(steps => removeGasAssignment(steps, step.order, a.lineId))}>Снять назначение</button>
      </div>;
    })}
    <div className="flex flex-wrap gap-2 items-end mt-2">
      <label className="text-sm">Назначить газовую линию
        <select className={INPUT} value={linePick} onChange={e => setLinePick(e.target.value)}>
          <option value="">{freeLines.length === 0 ? (gasSystem.length === 0 ? 'В разделе E нет линий' : 'Все линии уже назначены') : 'Выберите линию…'}</option>
          {freeLines.map(l => <option key={l.id} value={l.id} disabled={!l.enabled}>Линия {l.id} ({l.gas.trim() ? l.gas : 'газ не указан'}){l.enabled ? '' : ' - отключена'}</option>)}
        </select>
      </label>
      <button type="button" className="button secondary" disabled={!linePick} onClick={() => { onChange(steps => addGasAssignment(steps, step.order, linePick)); setLinePick(''); }}>Назначить</button>
    </div>
  </div>;
}

function StepCard({ step, total, pressureUnit, sources, gasSystem, onChange }: { step: ProcessStep; total: number; pressureUnit: PressureUnit; sources: SourceSet; gasSystem: GasLine[]; onChange: (updater: (steps: ProcessStep[]) => ProcessStep[]) => void }) {
  const [calcOpen, setCalcOpen] = useState(false);
  const [thickness, setThickness] = useState('1000');
  const [rate, setRate] = useState('10');
  const [calcError, setCalcError] = useState('');

  function patch(p: Partial<ProcessStep>) { onChange(steps => updateStep(steps, step.order, p)); }

  return <article className="content-card">
    <div className="flex justify-between items-center">
      <h3>№{step.order}. {step.name}{!step.enabled && ' (отключён)'}</h3>
      <div className="flex gap-2">
        <button type="button" className="button secondary" disabled={step.order === 1} onClick={() => onChange(steps => moveStep(steps, step.order, 'up'))}>↑</button>
        <button type="button" className="button secondary" disabled={step.order === total} onClick={() => onChange(steps => moveStep(steps, step.order, 'down'))}>↓</button>
        <button type="button" className="button secondary" onClick={() => onChange(steps => duplicateStep(steps, step.order))}>Копировать</button>
        <button type="button" className="button secondary" onClick={() => onChange(steps => toggleStepEnabled(steps, step.order))}>{step.enabled ? 'Отключить' : 'Включить'}</button>
        <button type="button" className="button secondary" onClick={() => onChange(steps => removeStep(steps, step.order))}>Удалить</button>
      </div>
    </div>
    <div className="content-grid mt-3">
      <label className="text-sm">Название
        <input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.name} onChange={e => patch({ name: e.target.value })} />
      </label>
      <label className="text-sm">Тип операции
        <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.type} onChange={e => patch({ type: e.target.value as StepType })}>
          {STEP_TYPES.map(t => <option key={t} value={t}>{STEP_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label className="text-sm">Длительность, мин
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.durationMin ?? ''} onChange={e => patch({ durationMin: num(e.target.value) })} />
      </label>
      <label className="text-sm">Температура, °C
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.temperatureC ?? ''} onChange={e => patch({ temperatureC: num(e.target.value) })} />
      </label>
      <label className="text-sm">Давление, {PRESSURE_UNIT_LABELS[pressureUnit]}
        <input type="number" step="any" min={0} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={paToDisplayInputValue(step.pressurePa, pressureUnit) ?? ''} onChange={e => patch({ pressurePa: parsePressureInput(e.target.value, pressureUnit) })} />
      </label>
      <label className="text-sm">Источник (описание)
        <input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.sourceConfiguration ?? ''} onChange={e => patch({ sourceConfiguration: e.target.value || undefined })} />
      </label>
      <label className="text-sm">Мощность этапа (общая), Вт
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.powerW ?? ''} onChange={e => patch({ powerW: num(e.target.value) })} />
      </label>
      <label className="text-sm">Ток этапа (общий), А
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.currentA ?? ''} onChange={e => patch({ currentA: num(e.target.value) })} />
      </label>
      <label className="text-sm">Substrate bias, В
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.substrateBiasV ?? ''} onChange={e => patch({ substrateBiasV: num(e.target.value) })} />
      </label>
      <label className="text-sm">Вращение, об/мин
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.rotationRpm ?? ''} onChange={e => patch({ rotationRpm: num(e.target.value) })} />
      </label>
      <label className="text-sm">Расстояние, мм
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.distanceMm ?? ''} onChange={e => patch({ distanceMm: num(e.target.value) })} />
      </label>
    </div>
    <label className="text-sm block mt-3">Описание
      <textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} value={step.description ?? ''} onChange={e => patch({ description: e.target.value || undefined })} />
    </label>
    <label className="text-sm block mt-3">Критерий приёмки
      <input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.acceptanceCriteria ?? ''} onChange={e => patch({ acceptanceCriteria: e.target.value || undefined })} />
    </label>
    <label className="text-sm block mt-3">Примечание
      <input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.notes ?? ''} onChange={e => patch({ notes: e.target.value || undefined })} />
    </label>

    {(ASSIGNMENT_STEP_TYPES.includes(step.type) || step.sourceAssignments.length > 0 || step.gasAssignments.length > 0) &&
      <StepAssignments step={step} sources={sources} gasSystem={gasSystem} onChange={onChange} />}

    <div className="mt-3">
      <h4>Газы для этапа (общий список)</h4>
      {step.gasUsage.map((g, i) => <div key={i} className="flex gap-2 mt-2">
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Газ" value={g.gas} onChange={e => patch({ gasUsage: step.gasUsage.map((x, j) => j === i ? { ...x, gas: e.target.value } : x) })} />
        <input type="number" step="any" className="rounded-md border border-[#dce0e5] p-2" placeholder="Расход, sccm" value={g.flowSccm ?? ''} onChange={e => patch({ gasUsage: step.gasUsage.map((x, j) => j === i ? { ...x, flowSccm: num(e.target.value) } : x) })} />
        <button type="button" className="button secondary" onClick={() => patch({ gasUsage: step.gasUsage.filter((_, j) => j !== i) })}>Убрать</button>
      </div>)}
      <button type="button" className="button secondary mt-2" onClick={() => patch({ gasUsage: [...step.gasUsage, { gas: '' }] })}>Добавить газ</button>
    </div>

    <div className="mt-3">
      <button type="button" className="button secondary" onClick={() => setCalcOpen(v => !v)}>Рассчитать длительность по толщине/скорости (Engineering Calculators)</button>
      {calcOpen && <div className="flex flex-wrap gap-2 items-end mt-2">
        <label className="text-sm">Толщина, нм<input type="number" className="rounded-md border border-[#dce0e5] p-2 mt-1 block" value={thickness} onChange={e => setThickness(e.target.value)} /></label>
        <label className="text-sm">Скорость, нм/мин<input type="number" className="rounded-md border border-[#dce0e5] p-2 mt-1 block" value={rate} onChange={e => setRate(e.target.value)} /></label>
        <button type="button" className="button primary" onClick={() => {
          setCalcError('');
          // Invalid/zero/negative/non-finite thickness or rate must produce a clear, user-facing
          // validation message here - never an uncaught exception that breaks the page, and
          // never a silently invented duration.
          try {
            onChange(steps => calculateStepDurationFromDeposition(steps, step.order, Number(thickness), 'nm', Number(rate), 'nm_per_min'));
            setCalcOpen(false);
          } catch (err) {
            setCalcError(err instanceof Error ? err.message : 'Не удалось рассчитать длительность.');
          }
        }}>Применить к длительности</button>
      </div>}
      {calcError && <p role="alert" className="text-sm mt-1">{calcError}</p>}
      {step.calculatedFields.length > 0 && <p className="muted small mt-2">Вычислено системой: {step.calculatedFields.join(', ')}</p>}
    </div>
  </article>;
}

function QualityCheckRow({ qc, onChange, onRemove }: { qc: QualityCheck; onChange: (patch: Partial<QualityCheck>) => void; onRemove: () => void }) {
  return <div className="content-card">
    <div className="flex justify-between"><strong>{qc.parameter}</strong><button type="button" className="button secondary" onClick={onRemove}>Удалить</button></div>
    <div className="content-grid mt-3">
      <label className="text-sm">Метод<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={qc.method ?? ''} onChange={e => onChange({ method: e.target.value || undefined })} /></label>
      <label className="text-sm">Критерий<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={qc.criterion ?? ''} onChange={e => onChange({ criterion: e.target.value || undefined })} /></label>
      <label className="text-sm">Единица<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={qc.unit ?? ''} onChange={e => onChange({ unit: e.target.value || undefined })} /></label>
      <label className="text-sm">Результат<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={qc.result ?? ''} onChange={e => onChange({ result: e.target.value || undefined })} /></label>
      <label className="text-sm">Статус
        <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={qc.status ?? ''} onChange={e => onChange({ status: (e.target.value || undefined) as QualityCheck['status'] })}>
          <option value="">— не задано —</option>
          <option value="pass">Годен</option>
          <option value="fail">Не годен</option>
          <option value="not_tested">Не проверено</option>
        </select>
      </label>
    </div>
  </div>;
}

type ExportState = 'ready' | 'generating' | 'completed' | 'error';

/** Parses the `filename*=UTF-8''...` (falling back to `filename="..."`) part of a
 *  Content-Disposition header - the export API always sends one of these two forms. */
function filenameFromContentDisposition(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="([^"]+)"/i.exec(value);
  return plain ? plain[1] : fallback;
}

function ExportBlock({ doc }: { doc: TechnicalProcessDocument }) {
  const [documentType, setDocumentType] = useState<DocumentType>('instruction');
  const [format, setFormat] = useState<ExportFormat>('docx');
  const [state, setState] = useState<ExportState>('ready');
  const [message, setMessage] = useState('');

  async function generate() {
    setState('generating');
    setMessage('');
    try {
      const response = await fetch('/api/workspace/techdoc/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: doc, documentType, format }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Не удалось сформировать файл.');
      }
      const blob = await response.blob();
      const filename = filenameFromContentDisposition(response.headers.get('Content-Disposition'), `document.${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setState('completed');
      setMessage(`Файл сформирован: ${filename}`);
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Не удалось сформировать файл.');
    }
  }

  return <section className="content-card">
    <h2>Экспорт документа</h2>
    <p className="muted small">Файл формируется локально, на сервере приложения, из тех же данных, что и предпросмотр выше - без LLM и без внешних сервисов.</p>
    <div className="content-grid mt-3">
      <label className="text-sm">Вид документа
        <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={documentType} onChange={e => setDocumentType(e.target.value as DocumentType)}>
          {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label className="text-sm">Формат
        <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>
          {EXPORT_FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
        </select>
      </label>
    </div>
    <button type="button" className="button primary mt-3" disabled={state === 'generating'} onClick={generate}>
      {state === 'generating' ? 'Формирование…' : 'Сформировать файл'}
    </button>
    {state === 'completed' && <p role="status" className="mt-2">{message}</p>}
    {state === 'error' && <p role="alert" className="mt-2">{message}</p>}
  </section>;
}

export function TechDocAssistant() {
  const [doc, setDoc] = useState<TechnicalProcessDocument>(createBlankDocument());
  const [view, setView] = useState<ViewMode>('instruction');
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const [futureVersion, setFutureVersion] = useState<number | null>(null);
  const [unreadableReason, setUnreadableReason] = useState<string | null>(null);
  const [newStepType, setNewStepType] = useState<StepType>(STEP_TYPES[0]);
  const stepWarnings = collectStepWarnings(doc);

  /** A source / gas line that steps still use is NOT deleted: the user is told which steps use it. */
  function removeSource(kind: SourceKind, id: string) {
    const result = removeSourceFromDocument(doc, kind, id);
    if (result.blockedBySteps.length > 0) { setError(`${SOURCE_KIND_LABELS[kind]} ${id} используется на этапах ${result.blockedBySteps.map(n => `№${n}`).join(', ')}. Сначала снимите назначение на этих этапах.`); return; }
    setError(''); setDoc(result.document);
  }
  function removeLine(id: string) {
    const result = removeGasLineFromDocument(doc, id);
    if (result.blockedBySteps.length > 0) { setError(`Линия ${id} используется на этапах ${result.blockedBySteps.map(n => `№${n}`).join(', ')}. Сначала снимите назначение на этих этапах.`); return; }
    setError(''); setDoc(result.document);
  }

  function updateSteps(updater: (steps: ProcessStep[]) => ProcessStep[]) {
    setDoc(prev => ({ ...prev, steps: updater(prev.steps) }));
  }

  useEffect(() => {
    const initial = setTimeout(() => {
      try {
        const restored = restoreDocumentDetailed(localStorage.getItem(STORAGE_KEY));
        if (restored.status === 'ok') {
          setDoc(restored.document);
          const notes: string[] = [];
          if (restored.migratedFromSchema === 1) {
            notes.push(`Рецепт сохранён в старой схеме (версия ${restored.migratedFromSchema}): давление переведено из мбар в паскали (1 мбар = 100 Па) и показано в Па; физические значения не изменены. Сохранённая копия остаётся прежней, пока вы не нажмёте «Сохранить структуру».`);
          }
          if (restored.migratedFromSchema === 2) notes.push('Рецепт сохранён в схеме версии 2: к этапам добавлены (пустые) списки назначенных источников и газовых линий. Все прежние параметры сохранены без изменений.');
          if (restored.migratedFromSchema === 1) notes.push('Рецепт из схемы 1 также получил пустые списки назначенных источников и газовых линий на этапах.');
          if (restored.repairedSourceIds > 0) notes.push(`В сохранённом документе повторялись идентификаторы источников (исправлено: ${restored.repairedSourceIds}). Параметры источников не изменены.`);
          if (restored.repairedGasLineIds > 0) notes.push(`В сохранённом документе повторялись идентификаторы газовых линий (исправлено: ${restored.repairedGasLineIds}). Параметры линий не изменены.`);
          if (notes.length > 0) setSavedNotice(notes.join(' '));
        } else if (restored.status === 'invalid' && restored.reason) {
          // Not silently blank: the saved data stays untouched in storage, and the reason is shown.
          setUnreadableReason(restored.reason);
          setSavedNotice(UNREADABLE_NOTICE(restored.reason));
        } else if (restored.status === 'future_version') {
          setFutureVersion(restored.schemaVersion);
          setSavedNotice(FUTURE_VERSION_NOTICE(restored.schemaVersion));
        }
      } catch {
        // localStorage itself unavailable (e.g. private browsing) - keep the blank document
      }
    }, 0);
    return () => clearTimeout(initial);
  }, []);

  function save(replaceNewerSchema = false) {
    setSavedNotice('');
    try {
      validateDocument(doc);
      const touched = touchDocument(doc);
      try {
        // A document saved by a NEWER schema is never overwritten silently: its structure is not
        // understood here, so writing over it would destroy data this build cannot recreate.
        const existing = restoreDocumentDetailed(localStorage.getItem(STORAGE_KEY));
        if (existing.status === 'future_version' && !replaceNewerSchema) {
          setFutureVersion(existing.schemaVersion);
          setSavedNotice(FUTURE_VERSION_NOTICE(existing.schemaVersion));
          setError('');
          return;
        }
        if (existing.status === 'invalid' && existing.reason && !replaceNewerSchema) {
          setUnreadableReason(existing.reason);
          setSavedNotice(UNREADABLE_NOTICE(existing.reason));
          setError('');
          return;
        }
        setDoc(touched);
        setError('');
        localStorage.setItem(STORAGE_KEY, JSON.stringify(touched));
        setFutureVersion(null);
        setUnreadableReason(null);
        setSavedNotice(`Структура сохранена в этом браузере (версия ${touched.traceability.version}). Данные хранятся только локально (localStorage) - не передаются на сервер и недоступны на других устройствах или в другом браузере.`);
      } catch {
        setDoc(touched);
        setError('');
        setSavedNotice(`Версия документа обновлена (${touched.traceability.version}), но локальное сохранение в браузере сейчас недоступно (хранилище заблокировано или переполнено) - изменения сохранятся только до перезагрузки страницы.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить структуру.');
    }
  }

  return <div className="flex flex-col gap-6">
    <section className="content-card">
      <h2>Presets</h2>
      <p className="muted small">Preset создаёт структуру процесса, но не подставляет неподтверждённые технологические параметры.</p>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className="button secondary" onClick={() => setDoc(createBlankDocument())}>Начать с чистого листа</button>
        {PROCESS_PRESETS.map(p => <button key={p.id} type="button" className="button secondary" onClick={() => setDoc(createDocumentFromPreset(p.id))} title={p.description}>{p.label}</button>)}
      </div>
    </section>

    <fieldset className="content-card">
      <legend><h2>A. Общие сведения</h2></legend>
      <div className="content-grid mt-3">
        <label className="text-sm">Название процесса *<input required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.processName} onChange={e => setDoc({ ...doc, general: { ...doc.general, processName: e.target.value } })} /></label>
        <label className="text-sm">Назначение<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.purpose ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, purpose: e.target.value || undefined } })} /></label>
        <label className="text-sm">Оборудование<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.equipment ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, equipment: e.target.value || undefined } })} /></label>
        <label className="text-sm">Установка/модель<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.installationModel ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, installationModel: e.target.value || undefined } })} /></label>
        <label className="text-sm">Материал подложки<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.substrateMaterial ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, substrateMaterial: e.target.value || undefined } })} /></label>
        <label className="text-sm">Тип изделия<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.productType ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, productType: e.target.value || undefined } })} /></label>
        <label className="text-sm">Материал покрытия/обработки<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.coatingMaterial ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, coatingMaterial: e.target.value || undefined } })} /></label>
        <label className="text-sm">Ответственный/подразделение<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.responsible ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, responsible: e.target.value || undefined } })} /></label>
        <label className="text-sm">Версия документа<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.documentVersion ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, documentVersion: e.target.value || undefined } })} /></label>
        <label className="text-sm">Дата<input type="date" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.general.date ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, date: e.target.value || undefined } })} /></label>
      </div>
    </fieldset>

    <fieldset className="content-card">
      <legend><h2>B. Исходные требования</h2></legend>
      <div className="content-grid mt-3">
        <label className="text-sm">Размер изделия, мм<input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.partSizeMm ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, partSizeMm: num(e.target.value) } })} /></label>
        <label className="text-sm">Количество<input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.quantity ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, quantity: num(e.target.value) } })} /></label>
        <label className="text-sm">Исходное состояние поверхности<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.initialSurfaceCondition ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, initialSurfaceCondition: e.target.value || undefined } })} /></label>
        <label className="text-sm">Требования к чистоте<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.cleanlinessRequirement ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, cleanlinessRequirement: e.target.value || undefined } })} /></label>
        <label className="text-sm">Требования к покрытию/обработке<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.coatingRequirement ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, coatingRequirement: e.target.value || undefined } })} /></label>
        <label className="text-sm">Требуемая толщина, мкм<input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.requiredThicknessUm ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, requiredThicknessUm: num(e.target.value) } })} /></label>
        <label className="text-sm">Допустимая температура, °C<input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.initialData.allowedTemperatureC ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, allowedTemperatureC: num(e.target.value) } })} /></label>
      </div>
      <label className="text-sm block mt-3">Дополнительные требования
        <textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} value={doc.initialData.additionalRequirements ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, additionalRequirements: e.target.value || undefined } })} />
      </label>
    </fieldset>

    <section className="content-card">
      <h2>C. Этапы процесса</h2>
      <div className="flex gap-2 mt-3">
        <select className="rounded-md border border-[#dce0e5] p-3" value={newStepType} onChange={e => setNewStepType(e.target.value as StepType)}>
          {STEP_TYPES.map(t => <option key={t} value={t}>{STEP_TYPE_LABELS[t]}</option>)}
        </select>
        <button type="button" className="button primary" onClick={() => updateSteps(steps => addStep(steps, newStepType))}>Добавить этап</button>
      </div>
      <label className="text-sm block mt-3">Единица давления (ввод, предпросмотр и экспорт)
        <select className="rounded-md border border-[#dce0e5] p-3 mt-1 block" value={doc.pressureUnit} onChange={e => setDoc(prev => ({ ...prev, pressureUnit: e.target.value as PressureUnit }))}>
          {PRESSURE_UNITS.map(unit => <option key={unit} value={unit}>{PRESSURE_UNIT_LABELS[unit]}</option>)}
        </select>
      </label>
      <p className="muted small">1 мбар = 100 Па. Давление хранится в паскалях; переключение единицы меняет только отображение, но не физическое значение. Научная запись вводится так: 1e-5.</p>
      <div className="flex flex-col gap-4 mt-4">
        {doc.steps.map(step => <StepCard key={step.order} step={step} total={doc.steps.length} pressureUnit={doc.pressureUnit} sources={doc.sources} gasSystem={doc.gasSystem} onChange={updateSteps} />)}
      </div>
    </section>

    <fieldset className="content-card">
      <legend><h2>D. Источники</h2></legend>
      <p className="muted small">Справочник оборудования установки. Включение источника, его мощность или ток и время работы задаются отдельно на каждом этапе (карточки «Адгезионный подслой» и «Многослойное покрытие»). Значения мощности/тока здесь - справочные.</p>
      <h3>Магнетроны</h3>
      {doc.sources.magnetrons.map(m => <div key={m.id} className="flex flex-wrap gap-2 items-end mt-2">
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Материал" value={m.material ?? ''} onChange={e => setDoc({ ...doc, sources: updateMagnetron(doc.sources, m.id, { material: e.target.value || undefined }) })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Мощность, Вт (справочно)" value={m.powerW ?? ''} onChange={e => setDoc({ ...doc, sources: updateMagnetron(doc.sources, m.id, { powerW: num(e.target.value) }) })} />
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Режим (DC/pulsed DC/RF)" value={m.mode ?? ''} onChange={e => setDoc({ ...doc, sources: updateMagnetron(doc.sources, m.id, { mode: e.target.value || undefined }) })} />
        <button type="button" className="button secondary" onClick={() => removeSource('magnetron', m.id)}>Удалить</button>
      </div>)}
      <button type="button" className="button secondary mt-2" onClick={() => setDoc({ ...doc, sources: addMagnetron(doc.sources) })}>Добавить магнетрон</button>

      <h3 className="mt-4">Arc-источники</h3>
      {doc.sources.arcSources.map(a => <div key={a.id} className="flex flex-wrap gap-2 items-end mt-2">
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Материал катода" value={a.cathodeMaterial ?? ''} onChange={e => setDoc({ ...doc, sources: updateArcSource(doc.sources, a.id, { cathodeMaterial: e.target.value || undefined }) })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Ток дуги, А (справочно)" value={a.arcCurrentA ?? ''} onChange={e => setDoc({ ...doc, sources: updateArcSource(doc.sources, a.id, { arcCurrentA: num(e.target.value) }) })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.filtered} onChange={e => setDoc({ ...doc, sources: updateArcSource(doc.sources, a.id, { filtered: e.target.checked }) })} /> Фильтрованная</label>
        <button type="button" className="button secondary" onClick={() => removeSource('arc', a.id)}>Удалить</button>
      </div>)}
      <button type="button" className="button secondary mt-2" onClick={() => setDoc({ ...doc, sources: addArcSource(doc.sources) })}>Добавить arc-источник</button>

      <h3 className="mt-4">ICP/RF</h3>
      <div className="flex flex-wrap gap-2 items-end mt-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={doc.sources.icpRf.enabled} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, icpRf: { ...doc.sources.icpRf, enabled: e.target.checked } } })} /> Включено</label>
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Мощность, Вт" value={doc.sources.icpRf.powerW ?? ''} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, icpRf: { ...doc.sources.icpRf, powerW: num(e.target.value) } } })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Bias, В" value={doc.sources.icpRf.biasV ?? ''} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, icpRf: { ...doc.sources.icpRf, biasV: num(e.target.value) } } })} />
      </div>

      <h3 className="mt-4">Ion source</h3>
      <div className="flex flex-wrap gap-2 items-end mt-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={doc.sources.ionSource.enabled} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, ionSource: { ...doc.sources.ionSource, enabled: e.target.checked } } })} /> Включено</label>
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Напряжение, В" value={doc.sources.ionSource.voltageV ?? ''} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, ionSource: { ...doc.sources.ionSource, voltageV: num(e.target.value) } } })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Ток, А" value={doc.sources.ionSource.currentA ?? ''} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, ionSource: { ...doc.sources.ionSource, currentA: num(e.target.value) } } })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Мощность, Вт" value={doc.sources.ionSource.powerW ?? ''} onChange={e => setDoc({ ...doc, sources: { ...doc.sources, ionSource: { ...doc.sources.ionSource, powerW: num(e.target.value) } } })} />
      </div>
    </fieldset>

    <fieldset className="content-card">
      <legend><h2>E. Газовая система</h2></legend>
      <p className="muted small">Справочник газовых линий. Какие линии используются на этапе, с каким расходом (sccm) и в какое время - задаётся в карточке этапа.</p>
      {doc.gasSystem.map(line => <div key={line.id} className="flex flex-wrap gap-2 items-end mt-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={line.enabled} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { enabled: e.target.checked }) })} /> Вкл.</label>
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Газ (например Ar, C2H2, произвольный)" value={line.gas} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { gas: e.target.value }) })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Расход" value={line.flow ?? ''} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { flow: num(e.target.value) }) })} />
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Ед." value={line.unit} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { unit: e.target.value }) })} />
        <button type="button" className="button secondary" onClick={() => removeLine(line.id)}>Удалить</button>
      </div>)}
      <button type="button" className="button secondary mt-2" onClick={() => setDoc({ ...doc, gasSystem: addGasLine(doc.gasSystem) })}>Добавить линию</button>
    </fieldset>

    <section className="content-card">
      <h2>F. Контроль качества</h2>
      <p className="muted small">Это только категории. Конкретные нормативы вводит пользователь.</p>
      <div className="flex flex-wrap gap-2 mt-3">
        {QUALITY_CHECK_CATEGORIES.map(c => <button key={c} type="button" className="button secondary" onClick={() => setDoc({ ...doc, qualityChecks: [...doc.qualityChecks, createQualityCheck(c)] })}>{c}</button>)}
      </div>
      <div className="flex flex-col gap-3 mt-4">
        {doc.qualityChecks.map(qc => <QualityCheckRow key={qc.id} qc={qc}
          onChange={patch => setDoc({ ...doc, qualityChecks: doc.qualityChecks.map(x => x.id === qc.id ? { ...x, ...patch } : x) })}
          onRemove={() => setDoc({ ...doc, qualityChecks: doc.qualityChecks.filter(x => x.id !== qc.id) })} />)}
      </div>
    </section>

    <fieldset className="content-card">
      <legend><h2>G. Безопасность</h2></legend>
      <p className="muted small">Нормативные требования не генерируются автоматически - заполняются только вручную.</p>
      <div className="content-grid mt-3">
        <label className="text-sm">Опасности (через запятую)<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.hazards.join(', ')} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, hazards: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></label>
        <label className="text-sm">СИЗ (через запятую)<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.ppe.join(', ')} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, ppe: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></label>
        <label className="text-sm">Блокировки (через запятую)<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.interlocks.join(', ')} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, interlocks: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></label>
        <label className="text-sm">Газовая безопасность<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.gasSafety ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, gasSafety: e.target.value || undefined } })} /></label>
        <label className="text-sm">Вакуумная безопасность<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.vacuumSafety ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, vacuumSafety: e.target.value || undefined } })} /></label>
        <label className="text-sm">Высокое напряжение<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.highVoltage ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, highVoltage: e.target.value || undefined } })} /></label>
        <label className="text-sm">Горячие поверхности<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={doc.safety.hotSurfaces ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, hotSurfaces: e.target.value || undefined } })} /></label>
      </div>
      <label className="text-sm block mt-3">Примечания<textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} value={doc.safety.notes ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, notes: e.target.value || undefined } })} /></label>
    </fieldset>

    <div className="flex gap-2">
      <button type="button" className="button primary" onClick={() => save()}>Сохранить структуру</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {savedNotice && <p role="status">{savedNotice}</p>}
    {stepWarnings.length > 0 && <div role="status" className="content-card">
      <h3>Замечания к данным этапов</h3>
      <ul className="list-disc">{stepWarnings.map(w => <li key={w}>{w}</li>)}</ul>
    </div>}
    {futureVersion !== null && <button type="button" className="button secondary" onClick={() => save(true)}>Заменить сохранённый документ (схема {futureVersion}) текущим</button>}
    {unreadableReason !== null && futureVersion === null && <button type="button" className="button secondary" onClick={() => save(true)}>Заменить нечитаемый сохранённый документ текущим</button>}

    <section className="content-card">
      <h2>H. Предпросмотр документа</h2>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className={`button ${view === 'instruction' ? 'primary' : 'secondary'}`} onClick={() => setView('instruction')}>Инструкция</button>
        <button type="button" className={`button ${view === 'techcard' ? 'primary' : 'secondary'}`} onClick={() => setView('techcard')}>Технологическая карта</button>
        <button type="button" className={`button ${view === 'routecard' ? 'primary' : 'secondary'}`} onClick={() => setView('routecard')}>Маршрутная карта</button>
        <button type="button" className={`button ${view === 'recipe' ? 'primary' : 'secondary'}`} onClick={() => setView('recipe')}>Краткий рецепт</button>
      </div>
      <div className="mt-4" style={{ overflowX: 'auto' }}>
        {view === 'instruction' && <pre style={{ whiteSpace: 'pre-wrap' }}>{buildInstructionView(doc)}</pre>}
        {view === 'recipe' && <pre style={{ whiteSpace: 'pre-wrap' }}>{buildBriefRecipe(doc)}</pre>}
        {view === 'techcard' && <table className="w-full text-sm">
          <thead><tr><th>№</th><th>Операция</th><th>Время</th><th>Температура</th><th>Давление</th><th>Газы</th><th>Источник/мощность</th><th>Bias</th><th>Контроль</th><th>Примечание</th></tr></thead>
          <tbody>{buildTechnologicalCard(doc).map(r => <tr key={r.number}><td>{r.number}</td><td>{r.operation}</td><td>{r.duration}</td><td>{r.temperature}</td><td>{r.pressure}</td><td>{r.gases}</td><td>{r.sourcePower}</td><td>{r.bias}</td><td>{r.control}</td><td>{r.note}</td></tr>)}</tbody>
        </table>}
        {view === 'routecard' && <table className="w-full text-sm">
          <thead><tr><th>№</th><th>Этап</th><th>Оборудование</th><th>Вход</th><th>Операция</th><th>Выход</th><th>Контроль</th><th>Примечание</th></tr></thead>
          <tbody>{buildRouteCard(doc).map(r => <tr key={r.number}><td>{r.number}</td><td>{r.stage}</td><td>{r.equipment}</td><td>{r.input}</td><td>{r.operation}</td><td>{r.output}</td><td>{r.control}</td><td>{r.note}</td></tr>)}</tbody>
        </table>}
      </div>
    </section>

    <ExportBlock doc={doc} />

    <p className="muted small">TechDoc Assistant не заменяет решение технолога: параметры процесса, нормативы и допуски определяет специалист. Не заданные значения отображаются как «не задано» и никогда не подставляются автоматически.</p>
  </div>;
}
