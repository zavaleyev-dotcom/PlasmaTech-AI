'use client';

import { useEffect, useState } from 'react';
import {
  createBlankDocument, createDocumentFromPreset, validateDocument, touchDocument, tryRestoreDocument,
  PROCESS_PRESETS, STEP_TYPES, STEP_TYPE_LABELS, QUALITY_CHECK_CATEGORIES,
  addStep, removeStep, duplicateStep, moveStep, toggleStepEnabled, updateStep, calculateStepDurationFromDeposition,
  addGasLine, removeGasLine, updateGasLine,
  addMagnetron, removeMagnetron, updateMagnetron, addArcSource, removeArcSource, updateArcSource,
  createQualityCheck,
  buildTechnologicalCard, buildRouteCard, buildInstructionView, buildBriefRecipe,
  type TechnicalProcessDocument, type ProcessStep, type StepType, type QualityCheck,
} from '@/services/workspace/techdoc-assistant';
import { DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, type DocumentType, type ExportFormat } from '@/services/workspace/techdoc-export-types';

type ViewMode = 'instruction' | 'techcard' | 'routecard' | 'recipe';

/** This browser's own localStorage only - never sent to a server, never shared across devices
 *  or browsers. See the honest wording in save()'s notice below. */
const STORAGE_KEY = 'techdoc-assistant:document';

function num(v: string): number | undefined { return v.trim() === '' ? undefined : Number(v); }

function StepCard({ step, total, onChange }: { step: ProcessStep; total: number; onChange: (updater: (steps: ProcessStep[]) => ProcessStep[]) => void }) {
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
      <label className="text-sm">Давление, мбар
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.pressureMbar ?? ''} onChange={e => patch({ pressureMbar: num(e.target.value) })} />
      </label>
      <label className="text-sm">Источник (описание)
        <input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.sourceConfiguration ?? ''} onChange={e => patch({ sourceConfiguration: e.target.value || undefined })} />
      </label>
      <label className="text-sm">Мощность, Вт
        <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={step.powerW ?? ''} onChange={e => patch({ powerW: num(e.target.value) })} />
      </label>
      <label className="text-sm">Ток, А
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

    <div className="mt-3">
      <h4>Газы для этапа</h4>
      {step.gasUsage.map((g, i) => <div key={i} className="flex gap-2 mt-2">
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Газ" value={g.gas} onChange={e => patch({ gasUsage: step.gasUsage.map((x, j) => j === i ? { ...x, gas: e.target.value } : x) })} />
        <input type="number" step="any" className="rounded-md border border-[#dce0e5] p-2" placeholder="Расход, см³/мин" value={g.flowSccm ?? ''} onChange={e => patch({ gasUsage: step.gasUsage.map((x, j) => j === i ? { ...x, flowSccm: num(e.target.value) } : x) })} />
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
  const [newStepType, setNewStepType] = useState<StepType>(STEP_TYPES[0]);

  function updateSteps(updater: (steps: ProcessStep[]) => ProcessStep[]) {
    setDoc(prev => ({ ...prev, steps: updater(prev.steps) }));
  }

  useEffect(() => {
    const initial = setTimeout(() => {
      try {
        const restored = tryRestoreDocument(localStorage.getItem(STORAGE_KEY));
        if (restored) setDoc(restored);
      } catch {
        // localStorage itself unavailable (e.g. private browsing) - keep the blank document
      }
    }, 0);
    return () => clearTimeout(initial);
  }, []);

  function save() {
    setSavedNotice('');
    try {
      validateDocument(doc);
      const touched = touchDocument(doc);
      setDoc(touched);
      setError('');
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(touched));
        setSavedNotice(`Структура сохранена в этом браузере (версия ${touched.traceability.version}). Данные хранятся только локально (localStorage) - не передаются на сервер и недоступны на других устройствах или в другом браузере.`);
      } catch {
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
      <div className="flex flex-col gap-4 mt-4">
        {doc.steps.map(step => <StepCard key={step.order} step={step} total={doc.steps.length} onChange={updateSteps} />)}
      </div>
    </section>

    <fieldset className="content-card">
      <legend><h2>D. Источники</h2></legend>
      <h3>Магнетроны</h3>
      {doc.sources.magnetrons.map(m => <div key={m.id} className="flex flex-wrap gap-2 items-end mt-2">
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Материал" value={m.material ?? ''} onChange={e => setDoc({ ...doc, sources: updateMagnetron(doc.sources, m.id, { material: e.target.value || undefined }) })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Мощность, Вт" value={m.powerW ?? ''} onChange={e => setDoc({ ...doc, sources: updateMagnetron(doc.sources, m.id, { powerW: num(e.target.value) }) })} />
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Режим (DC/pulsed DC/RF)" value={m.mode ?? ''} onChange={e => setDoc({ ...doc, sources: updateMagnetron(doc.sources, m.id, { mode: e.target.value || undefined }) })} />
        <button type="button" className="button secondary" onClick={() => setDoc({ ...doc, sources: removeMagnetron(doc.sources, m.id) })}>Удалить</button>
      </div>)}
      <button type="button" className="button secondary mt-2" onClick={() => setDoc({ ...doc, sources: addMagnetron(doc.sources) })}>Добавить магнетрон</button>

      <h3 className="mt-4">Arc-источники</h3>
      {doc.sources.arcSources.map(a => <div key={a.id} className="flex flex-wrap gap-2 items-end mt-2">
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Материал катода" value={a.cathodeMaterial ?? ''} onChange={e => setDoc({ ...doc, sources: updateArcSource(doc.sources, a.id, { cathodeMaterial: e.target.value || undefined }) })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Ток дуги, А" value={a.arcCurrentA ?? ''} onChange={e => setDoc({ ...doc, sources: updateArcSource(doc.sources, a.id, { arcCurrentA: num(e.target.value) }) })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={a.filtered} onChange={e => setDoc({ ...doc, sources: updateArcSource(doc.sources, a.id, { filtered: e.target.checked }) })} /> Фильтрованная</label>
        <button type="button" className="button secondary" onClick={() => setDoc({ ...doc, sources: removeArcSource(doc.sources, a.id) })}>Удалить</button>
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
      {doc.gasSystem.map(line => <div key={line.id} className="flex flex-wrap gap-2 items-end mt-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={line.enabled} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { enabled: e.target.checked }) })} /> Вкл.</label>
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Газ (например Ar, C2H2, произвольный)" value={line.gas} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { gas: e.target.value }) })} />
        <input type="number" className="rounded-md border border-[#dce0e5] p-2" placeholder="Расход" value={line.flow ?? ''} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { flow: num(e.target.value) }) })} />
        <input className="rounded-md border border-[#dce0e5] p-2" placeholder="Ед." value={line.unit} onChange={e => setDoc({ ...doc, gasSystem: updateGasLine(doc.gasSystem, line.id, { unit: e.target.value }) })} />
        <button type="button" className="button secondary" onClick={() => setDoc({ ...doc, gasSystem: removeGasLine(doc.gasSystem, line.id) })}>Удалить</button>
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
      <button type="button" className="button primary" onClick={save}>Сохранить структуру</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {savedNotice && <p role="status">{savedNotice}</p>}

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
