'use client';

import { useEffect, useState } from 'react';
import {
  createBlankDocument, createDocumentFromPreset, validateDocument, touchDocument, restoreDocumentDetailed, saveDocumentWithBackup,
  PRESSURE_UNITS, PRESSURE_UNIT_LABELS, paToDisplayInputValue, parsePressureInput,
  PROCESS_PRESETS, STEP_TYPES, STEP_TYPE_LABELS, STEP_TYPE_SPECS, STEP_FIELD_META, LAYER_FIELDS, LAYER_OPTIONAL_FIELDS, COATING_MODES, COATING_MODE_LABELS,
  QUALITY_CHECK_CATEGORIES, SOURCE_KINDS, SOURCE_KIND_LABELS, SOURCE_KIND_FIELDS, ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS,
  addStep, removeStep, duplicateStep, moveStep, toggleStepEnabled, updateStep, calculateStepDurationFromDeposition,
  addSource, updateSource, removeSource, addGas, updateGas, removeGas,
  addLayer, updateLayer, removeLayer, moveLayer, setCoatingMode, stepUnits,
  moveLegacyFieldToDescription, restoreLegacyField, removeLegacyField, restoreLegacyStep, removeLegacyStep, copyLegacyEquipmentToUnit, clearLegacyEquipment,
  collectStepWarnings, createQualityCheck, hasLegacyData,
  buildTechnologicalCard, buildRouteCard, buildInstructionView, buildBriefRecipe,
  type TechnicalProcessDocument, type ProcessStep, type CoatingLayer, type StepType, type StepFieldKey, type QualityCheck, type PressureUnit,
  type SourceKind, type StepSource, type StepGas, type UnitRef, type AssignmentMode, type CoatingMode, type LegacyEquipmentRef,
} from '@/services/workspace/techdoc-assistant';
import { describeMigration } from '@/services/workspace/techdoc-migrate';
import { DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, type DocumentType, type ExportFormat } from '@/services/workspace/techdoc-export-types';

type ViewMode = 'instruction' | 'techcard' | 'routecard' | 'recipe';

/** This browser's own localStorage only - never sent to a server, never shared across devices
 *  or browsers. See the honest wording in save()'s notice below. */
const STORAGE_KEY = 'techdoc-assistant:document';

const UNREADABLE_NOTICE = (reason: string) => `Сохранённый документ не загружен: ${reason} Он не изменён и не удалён. Сохранение поверх него отключено, пока вы явно не подтвердите замену.`;
const FUTURE_VERSION_NOTICE = (version: number) => `В этом браузере сохранён документ более новой схемы (версия ${version}); эта версия приложения её не понимает, поэтому документ не загружен. Он не изменён и не удалён. Сохранение поверх него отключено, пока вы явно не подтвердите замену.`;

function num(v: string): number | undefined { return v.trim() === '' ? undefined : Number(v); }

const FIELD = 'w-full rounded-md border border-[#dce0e5] p-3 mt-1';
const INPUT = 'rounded-md border border-[#dce0e5] p-2 mt-1 block';

type StepsUpdater = (updater: (steps: ProcessStep[]) => ProcessStep[]) => void;

// ---------- one field of a card or a layer ----------

function FieldInput({ fieldKey, value, pressureUnit, optional, onChange }: {
  fieldKey: StepFieldKey; value: number | string | undefined; pressureUnit: PressureUnit; optional: boolean; onChange: (value: number | string | undefined) => void;
}) {
  const meta = STEP_FIELD_META[fieldKey];
  const unit = meta.pressure ? `, ${PRESSURE_UNIT_LABELS[pressureUnit]}` : meta.unit ? `, ${meta.unit}` : '';
  const label = `${meta.label}${unit}${optional ? ' (необязательно)' : ''}`;
  if (meta.kind === 'text') {
    return <label className="text-sm">{label}
      <input className={FIELD} value={(value as string | undefined) ?? ''} onChange={e => onChange(e.target.value || undefined)} />
    </label>;
  }
  if (meta.pressure) {
    return <label className="text-sm">{label}
      <input type="number" step="any" min={0} className={FIELD} value={paToDisplayInputValue(value as number | undefined, pressureUnit) ?? ''} onChange={e => onChange(parsePressureInput(e.target.value, pressureUnit))} />
    </label>;
  }
  return <label className="text-sm">{label}
    <input type="number" step={meta.kind === 'count' ? 1 : 'any'} min={meta.rule === 'nonnegative' || meta.kind === 'count' || meta.rule === undefined ? 0 : undefined} className={FIELD}
      value={(value as number | undefined) ?? ''} onChange={e => onChange(num(e.target.value))} />
  </label>;
}

// ---------- sources and gas lines of one card / layer ----------

const SOURCE_FIELD_LABELS = {
  magnetron: { material: 'Материал мишени', powerW: 'Мощность, Вт', operatingMode: 'Режим питания (DC, HiPIMS…)' },
  arc: { material: 'Материал катода', currentA: 'Ток дуги, А' },
  icp_rf: { powerW: 'Мощность, Вт', biasV: 'Смещение, В' },
  ion: { voltageV: 'Напряжение, В', currentA: 'Ток, А', powerW: 'Мощность, Вт' },
} as const;

function SourceRow({ source, onPatch, onRemove }: { source: StepSource; onPatch: (p: Partial<Omit<StepSource, 'id' | 'kind'>>) => void; onRemove: () => void }) {
  const labels = SOURCE_FIELD_LABELS[source.kind] as Record<string, string>;
  return <div className="flex flex-wrap gap-3 items-end mt-2 border border-[#dce0e5] rounded-md p-2">
    <strong className="text-sm">{SOURCE_KIND_LABELS[source.kind]} {source.id}</strong>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={source.enabled} onChange={e => onPatch({ enabled: e.target.checked })} /> Включён</label>
    {SOURCE_KIND_FIELDS[source.kind].map(key => key === 'filtered'
      ? <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={source.filtered ?? false} onChange={e => onPatch({ filtered: e.target.checked })} /> Фильтрация</label>
      : (key === 'material' || key === 'operatingMode')
        ? <label key={key} className="text-sm">{labels[key]}<input className={INPUT} value={(source[key] as string | undefined) ?? ''} onChange={e => onPatch({ [key]: e.target.value || undefined })} /></label>
        : <label key={key} className="text-sm">{labels[key]}<input type="number" step="any" className={INPUT} value={(source[key] as number | undefined) ?? ''} onChange={e => onPatch({ [key]: num(e.target.value) })} /></label>)}
    <label className="text-sm">Начало, мин<input type="number" step="any" min={0} className={INPUT} value={source.startMin ?? ''} onChange={e => onPatch({ startMin: num(e.target.value) })} /></label>
    <label className="text-sm">Длительность, мин<input type="number" step="any" min={0} className={INPUT} value={source.durationMin ?? ''} onChange={e => onPatch({ durationMin: num(e.target.value) })} /></label>
    <label className="text-sm">Режим работы
      <select className={INPUT} value={source.mode} onChange={e => onPatch({ mode: e.target.value as AssignmentMode })}>
        {ASSIGNMENT_MODES.map(mode => <option key={mode} value={mode}>{ASSIGNMENT_MODE_LABELS[mode]}</option>)}
      </select>
    </label>
    <button type="button" className="button secondary" onClick={onRemove}>Удалить источник</button>
  </div>;
}

function GasRow({ gas, onPatch, onRemove }: { gas: StepGas; onPatch: (p: Partial<Omit<StepGas, 'id'>>) => void; onRemove: () => void }) {
  return <div className="flex flex-wrap gap-3 items-end mt-2 border border-[#dce0e5] rounded-md p-2">
    <strong className="text-sm">Линия {gas.id}</strong>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={gas.enabled} onChange={e => onPatch({ enabled: e.target.checked })} /> Подача включена</label>
    <label className="text-sm">Газ<input className={INPUT} placeholder="Ar, N2, C2H2…" value={gas.gas} onChange={e => onPatch({ gas: e.target.value })} /></label>
    <label className="text-sm">Расход, sccm<input type="number" step="any" min={0} className={INPUT} value={gas.flowSccm ?? ''} onChange={e => onPatch({ flowSccm: num(e.target.value) })} /></label>
    <label className="text-sm">Начало подачи, мин<input type="number" step="any" min={0} className={INPUT} value={gas.startMin ?? ''} onChange={e => onPatch({ startMin: num(e.target.value) })} /></label>
    <label className="text-sm">Длительность подачи, мин<input type="number" step="any" min={0} className={INPUT} value={gas.durationMin ?? ''} onChange={e => onPatch({ durationMin: num(e.target.value) })} /></label>
    <button type="button" className="button secondary" onClick={onRemove}>Удалить линию</button>
  </div>;
}

/** Sources and gas lines of ONE card or ONE coating layer. Created and configured right here; nothing is registered elsewhere. */
function UnitEditor({ reference, sources, gases, withSources, withGases, onChange, onError }: {
  reference: UnitRef; sources: StepSource[]; gases: StepGas[]; withSources: boolean; withGases: boolean; onChange: StepsUpdater; onError: (message: string) => void;
}) {
  const [kind, setKind] = useState<SourceKind>('magnetron');
  const run = (op: (steps: ProcessStep[]) => ProcessStep[]) => onChange(steps => { try { const next = op(steps); onError(''); return next; } catch (e) { onError(e instanceof Error ? e.message : 'Не удалось изменить данные.'); return steps; } });
  return <div className="mt-3">
    {withSources && <div>
      <h4>Источники</h4>
      <p className="muted small">Время - в минутах от начала {reference.layerId ? 'слоя' : 'этапа'}. «Последовательно» - интервал не пересекается с интервалами других включённых источников.</p>
      {sources.length === 0 && <p className="muted small">Источники не добавлены.</p>}
      {sources.map(s => <SourceRow key={s.id} source={s} onPatch={p => run(steps => updateSource(steps, reference, s.id, p))} onRemove={() => run(steps => removeSource(steps, reference, s.id))} />)}
      <div className="flex flex-wrap gap-2 items-end mt-2">
        <label className="text-sm">Тип источника
          <select className={INPUT} value={kind} onChange={e => setKind(e.target.value as SourceKind)}>
            {SOURCE_KINDS.map(k => <option key={k} value={k}>{SOURCE_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <button type="button" className="button secondary" onClick={() => run(steps => addSource(steps, reference, kind))}>Добавить источник</button>
      </div>
    </div>}
    {withGases && <div className={withSources ? 'mt-4' : ''}>
      <h4>Газовые линии</h4>
      <p className="muted small">Расход задаётся в sccm (стандартные см³/мин) и не пересчитывается из других единиц.</p>
      {gases.length === 0 && <p className="muted small">Газовые линии не добавлены.</p>}
      {gases.map(g => <GasRow key={g.id} gas={g} onPatch={p => run(steps => updateGas(steps, reference, g.id, p))} onRemove={() => run(steps => removeGas(steps, reference, g.id))} />)}
      <button type="button" className="button secondary mt-2" onClick={() => run(steps => addGas(steps, reference))}>Добавить газовую линию</button>
    </div>}
  </div>;
}

// ---------- coating layers ----------

function LayerCard({ step, layer, index, total, pressureUnit, onChange, onError }: {
  step: ProcessStep; layer: CoatingLayer; index: number; total: number; pressureUnit: PressureUnit; onChange: StepsUpdater; onError: (m: string) => void;
}) {
  const run = (op: (steps: ProcessStep[]) => ProcessStep[]) => onChange(steps => { try { const next = op(steps); onError(''); return next; } catch (e) { onError(e instanceof Error ? e.message : 'Не удалось изменить данные.'); return steps; } });
  return <div className="content-card mt-3">
    <div className="flex justify-between items-center">
      <h4>Слой {index + 1}</h4>
      <div className="flex gap-2">
        <button type="button" className="button secondary" disabled={index === 0} onClick={() => run(steps => moveLayer(steps, step.order, layer.id, 'up'))}>↑</button>
        <button type="button" className="button secondary" disabled={index === total - 1} onClick={() => run(steps => moveLayer(steps, step.order, layer.id, 'down'))}>↓</button>
        <button type="button" className="button secondary" onClick={() => run(steps => removeLayer(steps, step.order, layer.id))}>Удалить слой</button>
      </div>
    </div>
    <div className="content-grid mt-3">
      {LAYER_FIELDS.map(key => <FieldInput key={key} fieldKey={key} pressureUnit={pressureUnit} optional={LAYER_OPTIONAL_FIELDS.includes(key)}
        value={layer[key as keyof CoatingLayer] as number | string | undefined}
        onChange={value => run(steps => updateLayer(steps, step.order, layer.id, { [key]: value }))} />)}
    </div>
    <UnitEditor reference={{ order: step.order, layerId: layer.id }} sources={layer.sources} gases={layer.gases} withSources withGases onChange={onChange} onError={onError} />
  </div>;
}

// ---------- data kept from an older version ----------

function LegacyFieldsOfStep({ doc, step, onDoc }: { doc: TechnicalProcessDocument; step: ProcessStep; onDoc: (update: (d: TechnicalProcessDocument) => TechnicalProcessDocument) => void }) {
  const entry = doc.legacy.stepFields.find(e => e.stepId === step.id);
  const [targets, setTargets] = useState<Record<string, string>>({});
  if (!entry || entry.fields.length === 0) return null;
  const freeTargets = STEP_TYPE_SPECS[step.type].fields.filter(k => step[k] === undefined);
  return <div className="mt-3 content-card" role="group" aria-label="Данные прежней версии">
    <h4>Данные прежней версии</h4>
    <p className="muted small">Эти значения были у этапа в старом документе, а в новой карточке для них нет поля. Они не входят в технологический режим и в таблицы режима при экспорте. Перенесите нужное в карточку или удалите явно.</p>
    {entry.fields.map(f => {
      const text = typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
      const target = targets[f.key] ?? '';
      return <div key={f.key} className="flex flex-wrap gap-2 items-end mt-2 border border-[#dce0e5] rounded-md p-2">
        <span className="text-sm"><strong>{f.label}:</strong> {text}</span>
        <button type="button" className="button secondary" onClick={() => onDoc(d => moveLegacyFieldToDescription(d, step.id, f.key))}>В описание</button>
        {freeTargets.length > 0 && <>
          <select className={INPUT} aria-label="Поле карточки" value={target} onChange={e => setTargets({ ...targets, [f.key]: e.target.value })}>
            <option value="">В поле карточки…</option>
            {freeTargets.map(k => <option key={k} value={k}>{STEP_FIELD_META[k].label}</option>)}
          </select>
          <button type="button" className="button secondary" disabled={!target} onClick={() => onDoc(d => restoreLegacyField(d, step.id, f.key, target as StepFieldKey))}>Перенести</button>
        </>}
        <button type="button" className="button secondary" onClick={() => onDoc(d => removeLegacyField(d, step.id, f.key))}>Удалить</button>
      </div>;
    })}
  </div>;
}

// ---------- one technological card ----------

function StepCard({ doc, step, onChange, onDoc, onError }: {
  doc: TechnicalProcessDocument; step: ProcessStep; onChange: StepsUpdater; onDoc: (update: (d: TechnicalProcessDocument) => TechnicalProcessDocument) => void; onError: (m: string) => void;
}) {
  const total = doc.steps.length;
  const spec = STEP_TYPE_SPECS[step.type];
  const [calcOpen, setCalcOpen] = useState(false);
  const [thickness, setThickness] = useState(() => String(step.thicknessNm ?? 1000));
  const [rate, setRate] = useState('10');
  const [calcError, setCalcError] = useState('');
  const run = (op: (steps: ProcessStep[]) => ProcessStep[]) => onChange(steps => { try { const next = op(steps); onError(''); return next; } catch (e) { onError(e instanceof Error ? e.message : 'Не удалось изменить данные.'); return steps; } });
  const patch = (p: Parameters<typeof updateStep>[2]) => onChange(steps => updateStep(steps, step.order, p));

  return <article className="content-card">
    <div className="flex justify-between items-center">
      <h3>№{step.order}. {step.name}{step.name !== STEP_TYPE_LABELS[step.type] && <> <span className="muted small">[{STEP_TYPE_LABELS[step.type]}]</span></>}{!step.enabled && ' (отключён)'}</h3>
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
        <input className={FIELD} value={step.name} onChange={e => patch({ name: e.target.value })} />
      </label>
      {spec.fields.map(key => <FieldInput key={key} fieldKey={key} pressureUnit={doc.pressureUnit} optional={spec.optional.includes(key)} value={step[key]}
        onChange={value => patch({ [key]: value })} />)}
    </div>

    {spec.layers && <div className="mt-3">
      <label className="text-sm block">Режим покрытия
        <select className={INPUT} value={step.coatingMode} onChange={e => run(steps => setCoatingMode(steps, step.order, e.target.value as CoatingMode))}>
          {COATING_MODES.map(m => <option key={m} value={m}>{COATING_MODE_LABELS[m]}</option>)}
        </select>
      </label>
      <p className="muted small">Источники, газовые линии и режимы задаются отдельно для каждого слоя. В однослойном режиме остаётся один слой.</p>
      {step.layers.map((layer, i) => <LayerCard key={layer.id} step={step} layer={layer} index={i} total={step.layers.length} pressureUnit={doc.pressureUnit} onChange={onChange} onError={onError} />)}
      <button type="button" className="button secondary mt-3" disabled={step.coatingMode === 'single' && step.layers.length >= 1} onClick={() => run(steps => addLayer(steps, step.order))}>Добавить слой</button>
    </div>}

    {(spec.sources || spec.gases) && <UnitEditor reference={{ order: step.order }} sources={step.sources} gases={step.gases} withSources={spec.sources} withGases={spec.gases} onChange={onChange} onError={onError} />}

    <label className="text-sm block mt-3">Описание этапа
      <textarea className={`${FIELD} resize-y`} rows={2} value={step.description ?? ''} onChange={e => patch({ description: e.target.value || undefined })} />
    </label>

    <LegacyFieldsOfStep doc={doc} step={step} onDoc={onDoc} />

    {spec.calculator && <div className="mt-3">
      <button type="button" className="button secondary" onClick={() => setCalcOpen(v => !v)}>Рассчитать длительность по толщине/скорости (Engineering Calculators)</button>
      {calcOpen && <div className="flex flex-wrap gap-2 items-end mt-2">
        <label className="text-sm">Толщина, нм<input type="number" className="rounded-md border border-[#dce0e5] p-2 mt-1 block" value={thickness} onChange={e => setThickness(e.target.value)} /></label>
        <label className="text-sm">Скорость, нм/мин<input type="number" className="rounded-md border border-[#dce0e5] p-2 mt-1 block" value={rate} onChange={e => setRate(e.target.value)} /></label>
        <button type="button" className="button primary" onClick={() => {
          setCalcError('');
          // Invalid/zero/negative/non-finite thickness or rate must produce a clear, user-facing validation message here -
          // never an uncaught exception that breaks the page, and never a silently invented duration.
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
    </div>}
  </article>;
}

// ---------- the whole legacy overview (steps without a card type, old equipment) ----------

function LegacyOverview({ doc, onDoc, onError }: { doc: TechnicalProcessDocument; onDoc: (update: (d: TechnicalProcessDocument) => TechnicalProcessDocument) => void; onError: (m: string) => void }) {
  const [restoreType, setRestoreType] = useState<Record<string, StepType>>({});
  const [copyTarget, setCopyTarget] = useState<Record<string, string>>({});
  const legacy = doc.legacy;
  if (legacy.steps.length === 0 && !legacy.equipment) return null;
  const guard = (update: (d: TechnicalProcessDocument) => TechnicalProcessDocument) => onDoc(d => { try { const next = update(d); onError(''); return next; } catch (e) { onError(e instanceof Error ? e.message : 'Не удалось выполнить действие.'); return d; } });
  const targets = doc.steps.flatMap(step => {
    const spec = STEP_TYPE_SPECS[step.type];
    if (!spec.layers && !spec.sources && !spec.gases) return [];
    return stepUnits(step).map(u => ({ key: `${u.ref.order}:${u.ref.layerId ?? ''}`, label: `${u.label} («${step.name}»)`, ref: u.ref, sources: spec.layers || spec.sources, gases: spec.layers || spec.gases }));
  });
  const equipmentItems: { id: string; text: string; ref: LegacyEquipmentRef }[] = [];
  const eq = legacy.equipment;
  if (eq) {
    eq.magnetrons.forEach(m => equipmentItems.push({ id: `magnetron:${m.id}`, text: `Магнетрон ${m.id}: ${m.material ?? 'материал не задан'}${m.powerW !== undefined ? `, ${m.powerW} Вт` : ''}${m.mode ? `, ${m.mode}` : ''}`, ref: { kind: 'magnetron', id: m.id } }));
    eq.arcSources.forEach(a => equipmentItems.push({ id: `arc:${a.id}`, text: `Вакуумно-дуговой источник ${a.id}: ${a.cathodeMaterial ?? 'материал не задан'}${a.arcCurrentA !== undefined ? `, ${a.arcCurrentA} А` : ''}${a.filtered ? ', фильтрованный' : ''}`, ref: { kind: 'arc', id: a.id } }));
    if (eq.icpRf.enabled || eq.icpRf.powerW !== undefined || eq.icpRf.biasV !== undefined) equipmentItems.push({ id: 'icp_rf', text: `ICP/RF: ${eq.icpRf.powerW ?? '—'} Вт, смещение ${eq.icpRf.biasV ?? '—'} В`, ref: { kind: 'icp_rf' } });
    if (eq.ionSource.enabled || eq.ionSource.voltageV !== undefined || eq.ionSource.currentA !== undefined || eq.ionSource.powerW !== undefined) equipmentItems.push({ id: 'ion', text: `Ионный источник: ${eq.ionSource.voltageV ?? '—'} В, ${eq.ionSource.currentA ?? '—'} А, ${eq.ionSource.powerW ?? '—'} Вт`, ref: { kind: 'ion' } });
    eq.gasLines.forEach(g => equipmentItems.push({ id: `gas:${g.id}`, text: `Газовая линия ${g.id}: ${g.gas || 'газ не указан'}${g.flow !== undefined ? `, ${g.flow} ${g.unit}` : ''}`, ref: { kind: 'gas', id: g.id } }));
  }
  return <section className="content-card" aria-label="Данные прежней версии">
    <h3>Данные прежней версии</h3>
    <p className="muted small">Эти данные перенесены из документа старой схемы. Они не входят в технологический режим: в экспорте они напечатаны отдельным приложением и не смешаны с параметрами этапов.</p>
    {legacy.steps.length > 0 && <div>
      <h4>Этапы, которым нет места среди карточек</h4>
      {legacy.steps.map(s => {
        const chosen = restoreType[s.id] ?? STEP_TYPES[0];
        return <div key={s.id} className="mt-2 border border-[#dce0e5] rounded-md p-2">
          <strong className="text-sm">«{s.name}»{!s.enabled && ' (был отключён)'}</strong> <span className="muted small">(прежний тип: {s.originalType}, был №{s.originalOrder})</span>
          <ul className="text-sm list-disc">{s.fields.map(f => <li key={f.key}>{f.label}: {typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}</li>)}</ul>
          <div className="flex flex-wrap gap-2 items-end">
            <select className={INPUT} aria-label="Тип карточки" value={chosen} onChange={e => setRestoreType({ ...restoreType, [s.id]: e.target.value as StepType })}>
              {STEP_TYPES.map(t => <option key={t} value={t}>{STEP_TYPE_LABELS[t]}</option>)}
            </select>
            <button type="button" className="button secondary" onClick={() => guard(d => restoreLegacyStep(d, s.id, chosen))}>Вернуть в процесс как карточку</button>
            <button type="button" className="button secondary" onClick={() => guard(d => removeLegacyStep(d, s.id))}>Удалить</button>
          </div>
        </div>;
      })}
    </div>}
    {equipmentItems.length > 0 && <div className="mt-3">
      <h4>Прежний справочник оборудования</h4>
      <p className="muted small">Копия записи добавляется в выбранный этап или слой как новый источник или газовая линия; запись остаётся здесь.</p>
      {equipmentItems.map(item => {
        const target = copyTarget[item.id] ?? '';
        const compatible = targets.filter(t => item.ref.kind === 'gas' ? t.gases : t.sources);
        return <div key={item.id} className="flex flex-wrap gap-2 items-end mt-2 border border-[#dce0e5] rounded-md p-2">
          <span className="text-sm">{item.text}</span>
          <select className={INPUT} aria-label="Куда добавить" value={target} onChange={e => setCopyTarget({ ...copyTarget, [item.id]: e.target.value })}>
            <option value="">Добавить в…</option>
            {compatible.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <button type="button" className="button secondary" disabled={!target} onClick={() => { const t = compatible.find(x => x.key === target); if (t) guard(d => copyLegacyEquipmentToUnit(d, item.ref, t.ref)); }}>Добавить копию</button>
        </div>;
      })}
      <button type="button" className="button secondary mt-3" onClick={() => guard(d => clearLegacyEquipment(d))}>Удалить прежний справочник</button>
    </div>}
  </section>;
}

function QualityCheckRow({ qc, onChange, onRemove }: { qc: QualityCheck; onChange: (patch: Partial<QualityCheck>) => void; onRemove: () => void }) {
  return <div className="content-card">
    <div className="flex justify-between"><strong>{qc.parameter}</strong><button type="button" className="button secondary" onClick={onRemove}>Удалить</button></div>
    <div className="content-grid mt-3">
      <label className="text-sm">Метод<textarea className={`${FIELD} resize-y`} rows={1} value={qc.method ?? ''} onChange={e => onChange({ method: e.target.value || undefined })} /></label>
      <label className="text-sm">Критерий<input className={FIELD} value={qc.criterion ?? ''} onChange={e => onChange({ criterion: e.target.value || undefined })} /></label>
      <label className="text-sm">Единица<input className={FIELD} value={qc.unit ?? ''} onChange={e => onChange({ unit: e.target.value || undefined })} /></label>
      <label className="text-sm">Результат<input className={FIELD} value={qc.result ?? ''} onChange={e => onChange({ result: e.target.value || undefined })} /></label>
      <label className="text-sm">Статус
        <select className={FIELD} value={qc.status ?? ''} onChange={e => onChange({ status: (e.target.value || undefined) as QualityCheck['status'] })}>
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
        <select className={FIELD} value={documentType} onChange={e => setDocumentType(e.target.value as DocumentType)}>
          {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label className="text-sm">Формат
        <select className={FIELD} value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>
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
  const [migrationNotes, setMigrationNotes] = useState<string[]>([]);
  /** Set when the loaded document was migrated: the stored text BEFORE migration, copied to a backup key on the first save. */
  const [migrated, setMigrated] = useState<{ fromSchema: number; originalRaw: string } | null>(null);
  const [futureVersion, setFutureVersion] = useState<number | null>(null);
  const [unreadableReason, setUnreadableReason] = useState<string | null>(null);
  const [newStepType, setNewStepType] = useState<StepType>(STEP_TYPES[0]);
  const stepWarnings = collectStepWarnings(doc);

  function updateSteps(updater: (steps: ProcessStep[]) => ProcessStep[]) {
    setDoc(prev => ({ ...prev, steps: updater(prev.steps) }));
  }
  function updateDoc(update: (d: TechnicalProcessDocument) => TechnicalProcessDocument) {
    setDoc(prev => update(prev));
  }

  useEffect(() => {
    const initial = setTimeout(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const restored = restoreDocumentDetailed(raw);
        if (restored.status === 'ok') {
          setDoc(restored.document);
          if (restored.migration && raw) {
            setMigrated({ fromSchema: restored.migration.fromSchema, originalRaw: raw });
            setMigrationNotes([...describeMigration(restored.migration), 'Сохранённая копия остаётся прежней. При первом сохранении она будет скопирована в отдельную резервную копию, существующая резервная копия не перезаписывается.']);
          }
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
        const outcome = saveDocumentWithBackup(localStorage, STORAGE_KEY, touched, migrated ?? undefined);
        if (outcome.status === 'not_restorable') {
          // The document would not open again after a reload (a size/nesting limit): it is not written, the stored data is untouched.
          setError(`Документ не сохранён: после перезагрузки его не удалось бы открыть (${outcome.reason}). Сохранённые данные не изменены.`);
          return;
        }
        if (outcome.status === 'backup_failed') {
          // The old version could not be copied, so nothing was written: it is never lost.
          setError(`Резервная копия старой версии не создана (${outcome.reason}) - документ не сохранён, прежняя копия осталась без изменений.`);
          return;
        }
        setDoc(touched);
        setError('');
        setFutureVersion(null);
        setUnreadableReason(null);
        const backup = outcome.backupKey ? (outcome.backupWritten ? ` Старая версия сохранена как резервная копия (ключ ${outcome.backupKey}).` : ` Резервная копия старой версии уже существовала (ключ ${outcome.backupKey}) и не перезаписана.`) : '';
        setMigrated(null);
        setSavedNotice(`Структура сохранена в этом браузере (версия ${touched.traceability.version}).${backup} Данные хранятся только локально (localStorage) - не передаются на сервер и недоступны на других устройствах или в другом браузере.`);
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
        <button type="button" className="button secondary" onClick={() => { setDoc(createBlankDocument()); setMigrated(null); setMigrationNotes([]); }}>Начать с чистого листа</button>
        {PROCESS_PRESETS.map(p => <button key={p.id} type="button" className="button secondary" onClick={() => { setDoc(createDocumentFromPreset(p.id)); setMigrated(null); setMigrationNotes([]); }} title={p.description}>{p.label}</button>)}
      </div>
    </section>

    {migrationNotes.length > 0 && <section className="content-card" role="status" aria-label="Перенос из старой версии">
      <h3>Документ перенесён из старой версии</h3>
      <ul className="list-disc">{migrationNotes.map(n => <li key={n}>{n}</li>)}</ul>
    </section>}

    <fieldset className="content-card">
      <legend><h2>A. Основные сведения</h2></legend>
      <div className="content-grid mt-3">
        <label className="text-sm">Название процесса *<input required className={FIELD} value={doc.general.processName} onChange={e => setDoc({ ...doc, general: { ...doc.general, processName: e.target.value } })} /></label>
        <label className="text-sm">Назначение<input className={FIELD} value={doc.general.purpose ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, purpose: e.target.value || undefined } })} /></label>
        <label className="text-sm">Оборудование<input className={FIELD} value={doc.general.equipment ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, equipment: e.target.value || undefined } })} /></label>
        <label className="text-sm">Установка/модель<input className={FIELD} value={doc.general.installationModel ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, installationModel: e.target.value || undefined } })} /></label>
        <label className="text-sm">Материал подложки<input className={FIELD} value={doc.general.substrateMaterial ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, substrateMaterial: e.target.value || undefined } })} /></label>
        <label className="text-sm">Тип изделия<input className={FIELD} value={doc.general.productType ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, productType: e.target.value || undefined } })} /></label>
        <label className="text-sm">Материал покрытия/обработки<input className={FIELD} value={doc.general.coatingMaterial ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, coatingMaterial: e.target.value || undefined } })} /></label>
        <label className="text-sm">Ответственный/подразделение<input className={FIELD} value={doc.general.responsible ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, responsible: e.target.value || undefined } })} /></label>
        <label className="text-sm">Версия документа<input className={FIELD} value={doc.general.documentVersion ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, documentVersion: e.target.value || undefined } })} /></label>
        <label className="text-sm">Дата<input type="date" className={FIELD} value={doc.general.date ?? ''} onChange={e => setDoc({ ...doc, general: { ...doc.general, date: e.target.value || undefined } })} /></label>
      </div>
    </fieldset>

    <fieldset className="content-card">
      <legend><h2>B. Требования к процессу</h2></legend>
      <div className="content-grid mt-3">
        <label className="text-sm">Размер изделия, мм<input type="number" step="any" className={FIELD} value={doc.initialData.partSizeMm ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, partSizeMm: num(e.target.value) } })} /></label>
        <label className="text-sm">Количество<input type="number" step="any" className={FIELD} value={doc.initialData.quantity ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, quantity: num(e.target.value) } })} /></label>
        <label className="text-sm">Исходное состояние поверхности<input className={FIELD} value={doc.initialData.initialSurfaceCondition ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, initialSurfaceCondition: e.target.value || undefined } })} /></label>
        <label className="text-sm">Требования к чистоте<input className={FIELD} value={doc.initialData.cleanlinessRequirement ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, cleanlinessRequirement: e.target.value || undefined } })} /></label>
        <label className="text-sm">Требования к покрытию/обработке<input className={FIELD} value={doc.initialData.coatingRequirement ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, coatingRequirement: e.target.value || undefined } })} /></label>
        <label className="text-sm">Требуемая толщина, мкм<input type="number" step="any" className={FIELD} value={doc.initialData.requiredThicknessUm ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, requiredThicknessUm: num(e.target.value) } })} /></label>
        <label className="text-sm">Допустимая температура, °C<input type="number" step="any" className={FIELD} value={doc.initialData.allowedTemperatureC ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, allowedTemperatureC: num(e.target.value) } })} /></label>
      </div>
      <label className="text-sm block mt-3">Дополнительные требования
        <textarea className={`${FIELD} resize-y`} rows={2} value={doc.initialData.additionalRequirements ?? ''} onChange={e => setDoc({ ...doc, initialData: { ...doc.initialData, additionalRequirements: e.target.value || undefined } })} />
      </label>
    </fieldset>

    <section className="content-card">
      <h2>C. Технологические этапы</h2>
      <div className="flex gap-2 mt-3">
        <select className="rounded-md border border-[#dce0e5] p-3" aria-label="Тип новой карточки" value={newStepType} onChange={e => setNewStepType(e.target.value as StepType)}>
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
        {doc.steps.map(step => <StepCard key={step.id} doc={doc} step={step} onChange={updateSteps} onDoc={updateDoc} onError={setError} />)}
      </div>
      <div className="mt-4"><LegacyOverview doc={doc} onDoc={updateDoc} onError={setError} /></div>
    </section>

    <section className="content-card">
      <h2>D. Контроль качества</h2>
      <p className="muted small">Это только категории. Конкретные нормативы вводит пользователь.</p>
      <div className="flex flex-wrap gap-2 mt-3">
        {QUALITY_CHECK_CATEGORIES.map(c => <button key={c} type="button" className="button secondary" onClick={() => setDoc({ ...doc, qualityChecks: [...doc.qualityChecks, createQualityCheck(c)] })}>{c}</button>)}
        <button type="button" className="button secondary" onClick={() => setDoc({ ...doc, qualityChecks: [...doc.qualityChecks, createQualityCheck('Контроль качества')] })}>Другой параметр</button>
      </div>
      <div className="flex flex-col gap-3 mt-4">
        {doc.qualityChecks.map(qc => <QualityCheckRow key={qc.id} qc={qc}
          onChange={patch => setDoc({ ...doc, qualityChecks: doc.qualityChecks.map(x => x.id === qc.id ? { ...x, ...patch } : x) })}
          onRemove={() => setDoc({ ...doc, qualityChecks: doc.qualityChecks.filter(x => x.id !== qc.id) })} />)}
      </div>
    </section>

    <fieldset className="content-card">
      <legend><h2>E. Безопасность</h2></legend>
      <p className="muted small">Нормативные требования не генерируются автоматически - заполняются только вручную.</p>
      <div className="content-grid mt-3">
        <label className="text-sm">Опасности (через запятую)<input className={FIELD} value={doc.safety.hazards.join(', ')} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, hazards: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></label>
        <label className="text-sm">СИЗ (через запятую)<input className={FIELD} value={doc.safety.ppe.join(', ')} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, ppe: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></label>
        <label className="text-sm">Блокировки (через запятую)<input className={FIELD} value={doc.safety.interlocks.join(', ')} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, interlocks: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></label>
        <label className="text-sm">Газовая безопасность<input className={FIELD} value={doc.safety.gasSafety ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, gasSafety: e.target.value || undefined } })} /></label>
        <label className="text-sm">Вакуумная безопасность<input className={FIELD} value={doc.safety.vacuumSafety ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, vacuumSafety: e.target.value || undefined } })} /></label>
        <label className="text-sm">Высокое напряжение<input className={FIELD} value={doc.safety.highVoltage ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, highVoltage: e.target.value || undefined } })} /></label>
        <label className="text-sm">Горячие поверхности<input className={FIELD} value={doc.safety.hotSurfaces ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, hotSurfaces: e.target.value || undefined } })} /></label>
      </div>
      <label className="text-sm block mt-3">Примечания<textarea className={`${FIELD} resize-y`} rows={2} value={doc.safety.notes ?? ''} onChange={e => setDoc({ ...doc, safety: { ...doc.safety, notes: e.target.value || undefined } })} /></label>
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
      <h2>F. Предпросмотр и экспорт</h2>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className={`button ${view === 'instruction' ? 'primary' : 'secondary'}`} onClick={() => setView('instruction')}>Инструкция</button>
        <button type="button" className={`button ${view === 'techcard' ? 'primary' : 'secondary'}`} onClick={() => setView('techcard')}>Технологическая карта</button>
        <button type="button" className={`button ${view === 'routecard' ? 'primary' : 'secondary'}`} onClick={() => setView('routecard')}>Маршрутная карта</button>
        <button type="button" className={`button ${view === 'recipe' ? 'primary' : 'secondary'}`} onClick={() => setView('recipe')}>Краткий рецепт</button>
      </div>
      <div className="mt-4" style={{ overflowX: 'auto' }}>
        {view === 'instruction' && <pre style={{ whiteSpace: 'pre-wrap' }}>{buildInstructionView(doc)}</pre>}
        {view === 'recipe' && <pre style={{ whiteSpace: 'pre-wrap' }}>{buildBriefRecipe(doc)}</pre>}
        {view === 'techcard' && <>
          <table className="w-full text-sm">
            <thead><tr><th>№</th><th>Операция</th><th>Время</th><th>Темп.</th><th>Давление</th><th>Газы</th><th>Источники</th><th>Bias</th><th>Прочие параметры</th><th>Описание</th></tr></thead>
            <tbody>{buildTechnologicalCard(doc).map(r => <tr key={r.number}><td>{r.number}</td><td>{r.operation}</td><td>{r.duration}</td><td>{r.temperature}</td><td>{r.pressure}</td><td>{r.gases}</td><td>{r.sources}</td><td>{r.bias}</td><td>{r.params}</td><td>{r.description}</td></tr>)}</tbody>
          </table>
          {buildTechnologicalCard(doc).filter(r => r.layers.length > 0).map(r => <div key={r.number} className="mt-4">
            <h3>Этап №{r.number} «{r.layers[0].stepName}»: слои покрытия</h3>
            <table className="w-full text-sm">
              <thead><tr><th>Слой</th><th>Материал</th><th>Толщина</th><th>Время</th><th>Температура</th><th>Давление</th><th>Bias</th><th>Вращение / расстояние</th><th>Источники</th><th>Газы</th></tr></thead>
              <tbody>{r.layers.map(l => <tr key={l.layer}><td>{l.layer}</td><td>{l.material}</td><td>{l.thickness}</td><td>{l.duration}</td><td>{l.temperature}</td><td>{l.pressure}</td><td>{l.bias}</td><td>{l.motion}</td><td>{l.sources}</td><td>{l.gases}</td></tr>)}</tbody>
            </table>
          </div>)}
        </>}
        {view === 'routecard' && <table className="w-full text-sm">
          <thead><tr><th>№</th><th>Этап</th><th>Оборудование</th><th>Вход</th><th>Операция</th><th>Выход</th></tr></thead>
          <tbody>{buildRouteCard(doc).map(r => <tr key={r.number}><td>{r.number}</td><td>{r.stage}</td><td>{r.equipment}</td><td>{r.input}</td><td>{r.operation}</td><td>{r.output}</td></tr>)}</tbody>
        </table>}
        {hasLegacyData(doc.legacy) && <p className="muted small mt-3">В документе есть данные прежней версии: они не входят в технологический режим и в экспорте напечатаны отдельным приложением к инструкции.</p>}
      </div>
    </section>

    <ExportBlock doc={doc} />

    <p className="muted small">TechDoc Assistant не заменяет решение технолога: параметры процесса, нормативы и допуски определяет специалист. Не заданные значения отображаются как «не задано» и никогда не подставляются автоматически.</p>
  </div>;
}
