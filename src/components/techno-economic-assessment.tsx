'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCurrency, runAssessment,
  type AssessmentInput, type AssessmentResult, type Currency, type EconomicEffectMode, type OpexPeriod,
} from '@/services/workspace/techno-economic-assessment';
import { acknowledgeEquipmentHandoff, peekPendingEquipmentHandoff, type EquipmentTeaHandoffRecord } from '@/services/workspace/equipment-tea-handoff';
import {
  TEA_PROJECT_CONFIG, applyHandoffToProject, confirmHandoffDelivery, planHandoffDelivery, defaultTeaForm, defaultTeaProject, defaultTeaScenarioForms, isCalculationStale, recomputeResults, shownResultContext, STALE_RESULTS_MESSAGE, teaFormToInput,
  type CalculatedFrom, type TeaFormState, type TeaProjectContent,
} from '@/services/workspace/tea-project-store';
import {
  createAutosave, createProjectPersistence, detectProjectStore, type Autosave, type ProjectPersistence, type ProjectLoadResult, type SaveOutcome,
} from '@/services/workspace/local-project-persistence';
import { SCENARIO_KEYS, SCENARIO_LABELS, reportRequestBody, CURRENCY_NAMES, type ScenarioKey, type ReportVariant, type TeaReportRequest } from '@/services/workspace/techno-economic-report';

// ---------- raw (string) form state - converted to numbers only at calculation time (the type and the defaults live with the saved project) ----------

type FormState = TeaFormState;
const defaultForm = defaultTeaForm;
const toAssessmentInput = teaFormToInput;

// ---------- 3-scenario analysis (Base / Conservative / Optimistic) - same engine, same form
// shape as Variant A/B above; the user must explicitly set each scenario's own numbers, nothing
// is auto-derived or invented between scenarios. ----------

export { SCENARIO_KEYS, SCENARIO_LABELS };
export type { ScenarioKey };

export function defaultScenarioForms(): Record<ScenarioKey, FormState> {
  return defaultTeaScenarioForms();
}

function NumberField({ label, value, onChange, min }: { label: string; value: string; onChange: (v: string) => void; min?: number }) {
  return <label className="text-sm">{label}
    <input type="number" step="any" min={min} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={value} onChange={e => onChange(e.target.value)} />
  </label>;
}

function TitleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="text-sm">Что оцениваем (название/описание, необязательно)
    <input type="text" maxLength={200} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={value} onChange={e => onChange(e.target.value)} />
  </label>;
}

function ImportedFromEquipmentSelector({ record, onDismiss }: { record: EquipmentTeaHandoffRecord; onDismiss: () => void }) {
  const { handoff } = record;
  return <section className="content-card">
    <div className="flex justify-between items-start gap-2">
      <h3>Импортировано из Equipment Selector</h3>
      <button type="button" className="button secondary" onClick={onDismiss}>Скрыть</button>
    </div>
    <p className="muted small">Источник: Equipment Selector, конфигурация «{handoff.configurationName}». {handoff.note}</p>
    <ul className="list-disc mt-2 text-sm">
      <li>Процессы: {handoff.supportedPurposes.join(', ') || '—'}</li>
      <li>Технологии: {handoff.supportedTechnologies.join(', ') || '—'}</li>
      <li>Макс. размер: {handoff.maxChamberSizeMm} мм</li>
      <li>Макс. температура: {handoff.maxProcessTempC}°C</li>
      <li>Источники: {handoff.sourcesSummary}</li>
      <li>Газовые линии (макс.): {handoff.maxGasLines}</li>
      <li>Производительность: {handoff.throughputClasses.join(', ') || '—'}</li>
      <li>Автоматизация: {handoff.automationLevels.join(', ') || '—'}</li>
      <li>Cleanroom: {handoff.cleanroomSupport.join(', ') || '—'}</li>
    </ul>
    <p className="muted small mt-2">Это справочная информация о выбранном оборудовании - поле «Что оцениваем» в Варианте A заполнено автоматически, его можно изменить. Финансовые поля ниже нужно заполнить вручную.</p>
  </section>;
}

function CapexSection({ value, onChange }: { value: FormState['capex']; onChange: (next: FormState['capex']) => void }) {
  const set = (key: keyof FormState['capex']) => (v: string) => onChange({ ...value, [key]: v });
  return <fieldset className="content-card">
    <legend><h2>A. Инвестиции CAPEX</h2></legend>
    <p className="muted small">Единовременные затраты. Обязательно только «Стоимость оборудования».</p>
    <div className="content-grid mt-3">
      <NumberField label="Стоимость оборудования *" value={value.equipment} onChange={set('equipment')} min={0} />
      <NumberField label="Доставка" value={value.delivery} onChange={set('delivery')} min={0} />
      <NumberField label="Таможня / логистика" value={value.customsLogistics} onChange={set('customsLogistics')} min={0} />
      <NumberField label="Монтаж" value={value.installation} onChange={set('installation')} min={0} />
      <NumberField label="Пусконаладка" value={value.commissioning} onChange={set('commissioning')} min={0} />
      <NumberField label="Обучение" value={value.training} onChange={set('training')} min={0} />
      <NumberField label="Инфраструктура" value={value.infrastructure} onChange={set('infrastructure')} min={0} />
      <NumberField label="Оснастка / комплектующие" value={value.tooling} onChange={set('tooling')} min={0} />
      <NumberField label="Прочие единовременные затраты" value={value.otherOneTime} onChange={set('otherOneTime')} min={0} />
    </div>
  </fieldset>;
}

function OpexSection({ period, value, onPeriodChange, onChange }: { period: OpexPeriod; value: FormState['opex']; onPeriodChange: (p: OpexPeriod) => void; onChange: (next: FormState['opex']) => void }) {
  const set = (key: keyof FormState['opex']) => (v: string) => onChange({ ...value, [key]: v });
  return <fieldset className="content-card">
    <legend><h2>B. Эксплуатационные затраты OPEX</h2></legend>
    <label className="text-sm">Период ввода данных
      <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={period} onChange={e => onPeriodChange(e.target.value as OpexPeriod)}>
        <option value="year">В год</option>
        <option value="month">В месяц</option>
      </select>
    </label>
    <p className="muted small mt-2">Все поля ниже вводятся за выбранный период ({period === 'year' ? 'год' : 'месяц'}); годовой итог считается автоматически.</p>
    <div className="content-grid mt-3">
      <NumberField label="Электроэнергия" value={value.electricity} onChange={set('electricity')} min={0} />
      <NumberField label="Технологические газы" value={value.processGases} onChange={set('processGases')} min={0} />
      <NumberField label="Расходные материалы" value={value.consumables} onChange={set('consumables')} min={0} />
      <NumberField label="Мишени / катоды" value={value.targetsCathodes} onChange={set('targetsCathodes')} min={0} />
      <NumberField label="Реактивы" value={value.reagents} onChange={set('reagents')} min={0} />
      <NumberField label="Обслуживание" value={value.maintenance} onChange={set('maintenance')} min={0} />
      <NumberField label="Ремонт" value={value.repairs} onChange={set('repairs')} min={0} />
      <NumberField label="Персонал" value={value.labor} onChange={set('labor')} min={0} />
      <NumberField label="Аренда / помещения" value={value.facilities} onChange={set('facilities')} min={0} />
      <NumberField label="Утилизация" value={value.disposal} onChange={set('disposal')} min={0} />
      <NumberField label="Прочие эксплуатационные расходы" value={value.otherOperating} onChange={set('otherOperating')} min={0} />
    </div>
  </fieldset>;
}

function CapacitySection({ value, onChange, depreciationYears, onDepreciationChange }: { value: FormState['capacity']; onChange: (next: FormState['capacity']) => void; depreciationYears: string; onDepreciationChange: (v: string) => void }) {
  const set = (key: keyof FormState['capacity']) => (v: string) => onChange({ ...value, [key]: v });
  return <fieldset className="content-card">
    <legend><h2>C. Производительность</h2></legend>
    <div className="content-grid mt-3">
      <NumberField label="Смен в сутки" value={value.shiftsPerDay} onChange={set('shiftsPerDay')} min={0} />
      <NumberField label="Часов в смену" value={value.hoursPerShift} onChange={set('hoursPerShift')} min={0} />
      <NumberField label="Рабочих дней в год" value={value.workingDaysPerYear} onChange={set('workingDaysPerYear')} min={0} />
      <NumberField label="Загрузка оборудования, %" value={value.utilizationPercent} onChange={set('utilizationPercent')} min={0} />
      <NumberField label="Время одного цикла, мин" value={value.cycleTimeMinutes} onChange={set('cycleTimeMinutes')} min={0} />
      <NumberField label="Изделий за цикл" value={value.unitsPerCycle} onChange={set('unitsPerCycle')} min={0} />
      <NumberField label="Срок амортизации, лет (необязательно)" value={depreciationYears} onChange={onDepreciationChange} min={0} />
    </div>
  </fieldset>;
}

function EconomicEffectSection({ mode, onModeChange, currentUnitCost, newUnitCost, currentAnnualCost, newAnnualCost, onChange }: {
  mode: EconomicEffectMode; onModeChange: (m: EconomicEffectMode) => void;
  currentUnitCost: string; newUnitCost: string; currentAnnualCost: string; newAnnualCost: string;
  onChange: (field: 'currentUnitCost' | 'newUnitCost' | 'currentAnnualCost' | 'newAnnualCost', v: string) => void;
}) {
  return <fieldset className="content-card">
    <legend><h2>D. Экономический эффект</h2></legend>
    <label className="text-sm">Как считать эффект
      <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={mode} onChange={e => onModeChange(e.target.value as EconomicEffectMode)}>
        <option value="total_external_cost">По текущим и новым годовым затратам</option>
        <option value="unit_cost">По себестоимости единицы (текущая / новая)</option>
      </select>
    </label>
    <div className="content-grid mt-3">
      {mode === 'total_external_cost' ? <>
        <NumberField label="Текущие внешние затраты в год" value={currentAnnualCost} onChange={v => onChange('currentAnnualCost', v)} min={0} />
        <NumberField label="Затраты после внедрения, в год" value={newAnnualCost} onChange={v => onChange('newAnnualCost', v)} min={0} />
      </> : <>
        <NumberField label="Текущая себестоимость единицы" value={currentUnitCost} onChange={v => onChange('currentUnitCost', v)} min={0} />
        <NumberField label="Новая себестоимость единицы" value={newUnitCost} onChange={v => onChange('newUnitCost', v)} min={0} />
      </>}
    </div>
  </fieldset>;
}

/** Everything the report is built from, fixed at the moment the calculation ran: the inputs, the CURRENCY of the entered amounts and the configuration from
 *  Equipment Selector that was shown then. Changing the currency selector, editing a field or dismissing the configuration card afterwards changes none of it, so a
 *  report can never re-label old amounts or carry another configuration. A new calculation makes a new snapshot. */
type ReportSnapshot = TeaReportRequest;

type ReportFormat = 'docx' | 'pdf';
type DownloadState = 'ready' | 'generating' | 'completed' | 'error';

function filenameFromContentDisposition(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="([^"]+)"/i.exec(value);
  return plain ? plain[1] : fallback;
}

/** "Скачать DOCX" / "Скачать PDF": the report of the last calculation, no re-entry. The file is built on the server from the same inputs by the same engine. */
function ReportDownload({ snapshot, displayCurrency }: { snapshot: ReportSnapshot; displayCurrency: Currency }) {
  const [state, setState] = useState<DownloadState>('ready');
  const [message, setMessage] = useState('');

  async function download(format: ReportFormat) {
    setState('generating');
    setMessage('');
    try {
      const response = await fetch('/api/workspace/techno-economic/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportRequestBody(snapshot, format)),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Не удалось сформировать отчёт.');
      }
      const blob = await response.blob();
      const filename = filenameFromContentDisposition(response.headers.get('Content-Disposition'), `TEA-report.${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setState('completed');
      setMessage(`Отчёт сформирован: ${filename}`);
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'Не удалось сформировать отчёт.');
    }
  }

  return <div className="content-card mt-4">
    <h3>Отчёт</h3>
    <p className="muted small">Отчёт формируется по последнему выполненному расчёту (все заполненные данные, результаты, варианты и сценарии) — повторно вводить ничего не нужно. DOCX и PDF содержат одно и то же.</p>
    <p className="muted small" data-testid="report-basis">Валюта отчёта: {CURRENCY_NAMES[snapshot.currency]} (валюта расчёта). Конфигурация Equipment Selector: {snapshot.handoff ? `«${snapshot.handoff.configurationName}»` : 'не передавалась'}.</p>
    {displayCurrency !== snapshot.currency && <p role="status" className="small">Сейчас на экране выбрана другая валюта ({displayCurrency}). Это только отображение: суммы расчёта введены в {snapshot.currency}, и в отчёт они попадут в {snapshot.currency}. Чтобы получить отчёт в другой валюте, введите суммы в этой валюте и рассчитайте заново.</p>}
    <div className="flex flex-wrap gap-2 mt-2">
      <button type="button" className="button secondary" disabled={state === 'generating'} onClick={() => download('docx')}>Скачать DOCX</button>
      <button type="button" className="button secondary" disabled={state === 'generating'} onClick={() => download('pdf')}>Скачать PDF</button>
    </div>
    {state === 'generating' && <p role="status" className="mt-2">Формирование…</p>}
    {state === 'completed' && <p role="status" className="mt-2">{message}</p>}
    {state === 'error' && <p role="alert" className="mt-2">{message}</p>}
  </div>;
}

function ResultCards({ result, currency }: { result: AssessmentResult; currency: Currency }) {
  const money = (v: number) => formatCurrency(v, currency);
  return <div className="content-grid">
    <div className="content-card"><h3>CAPEX</h3><p className="text-2xl">{money(result.capex.total)}</p></div>
    <div className="content-card"><h3>OPEX / год</h3><p className="text-2xl">{money(result.opex.annualTotal)}</p></div>
    <div className="content-card"><h3>Выпуск / год</h3><p className="text-2xl">{result.capacity.unitsPerYear.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ед.</p></div>
    <div className="content-card"><h3>Себестоимость / ед.</h3><p className="text-2xl">{money(result.unitCost.withoutDepreciation)}</p>{result.unitCost.withDepreciation !== null && <p className="muted small">с амортизацией: {money(result.unitCost.withDepreciation)}</p>}</div>
    <div className="content-card"><h3>Годовая экономия</h3><p className="text-2xl">{money(result.economicEffect.annualSavings)}</p></div>
    <div className="content-card"><h3>Окупаемость</h3>{result.payback.years !== null ? <p className="text-2xl">{result.payback.years.toFixed(2)} лет ({result.payback.months!.toFixed(1)} мес.)</p> : <p role="alert">{result.payback.message}</p>}</div>
    <div className="content-card"><h3>ROI</h3><p className="text-2xl">{result.roi.percent.toFixed(1)}%</p></div>
  </div>;
}

function FormulasDisclosure({ result }: { result: AssessmentResult }) {
  return <details className="content-card mt-4">
    <summary>Как рассчитано</summary>
    <ul className="mt-3 flex flex-col gap-2 text-sm">
      <li><strong>CAPEX:</strong> {result.capex.formula} = {result.capex.total.toFixed(2)}</li>
      <li><strong>OPEX:</strong> {result.opex.formula}</li>
      <li><strong>Производительность:</strong> {result.capacity.formula}</li>
      <li><strong>Себестоимость:</strong> {result.unitCost.formula}</li>
      <li><strong>Экономический эффект:</strong> {result.economicEffect.formula}</li>
      <li><strong>Окупаемость:</strong> {result.payback.formula}</li>
      <li><strong>ROI:</strong> {result.roi.formula}</li>
      {result.breakEven && <li><strong>Точка безубыточности:</strong> {result.breakEven.formula}</li>}
    </ul>
  </details>;
}

/** The state of the local project shown to the user. It lives only in this browser: not sent anywhere, not encrypted, not backed up. */
type ProjectStatus =
  | { kind: 'loading' } | { kind: 'new' } | { kind: 'restored'; savedAt: string } | { kind: 'saved'; savedAt: string }
  | { kind: 'unreadable' } | { kind: 'unavailable' } | { kind: 'read_failed' } | { kind: 'conflict' }
  | { kind: 'failed'; reason: 'quota' | 'error' | 'quarantine_failed' | 'quarantine_occupied' }
  | { kind: 'invalid'; problem: string };

const timeOf = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };

export function TechnoEconomicAssessment() {
  const [formA, setFormA] = useState<FormState>(defaultForm());
  const [formB, setFormB] = useState<FormState>(defaultForm());
  const [compareB, setCompareB] = useState(false);
  const [currency, setCurrency] = useState<Currency>('RUB');
  const [resultA, setResultA] = useState<AssessmentResult | null>(null);
  const [resultB, setResultB] = useState<AssessmentResult | null>(null);
  const [error, setError] = useState('');
  const [importedHandoff, setImportedHandoff] = useState<EquipmentTeaHandoffRecord | null>(null);
  const [scenariosEnabled, setScenariosEnabled] = useState(false);
  const [scenarioForms, setScenarioForms] = useState<Record<ScenarioKey, FormState>>(defaultScenarioForms());
  const [scenarioResults, setScenarioResults] = useState<Record<ScenarioKey, AssessmentResult | null>>({ base: null, conservative: null, optimistic: null });
  const [reportSnapshot, setReportSnapshot] = useState<ReportSnapshot | null>(null);
  const [calculatedFrom, setCalculatedFrom] = useState<CalculatedFrom | null>(null);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>({ kind: 'loading' });
  const persistence = useRef<ProjectPersistence<TeaProjectContent> | null>(null);
  const autosave = useRef<Autosave<TeaProjectContent> | null>(null);
  const latestProject = useRef<TeaProjectContent>(defaultTeaProject());
  // What is saved: the INPUTS and settings. The results are derived and are calculated again from the stored inputs of the last calculation when the project is restored.
  const project = useMemo<TeaProjectContent>(() => ({
    formA, formB, compareB, currency, scenariosEnabled, scenarioForms, handoff: importedHandoff, calculation: reportSnapshot, calculatedFrom,
  }), [formA, formB, compareB, currency, scenariosEnabled, scenarioForms, importedHandoff, reportSnapshot, calculatedFrom]);

  // A hand-over from Equipment Selector that was applied to the screen but is not yet CONFIRMED saved: it stays in the queue until a write that contains it succeeds.
  const pendingHandoff = useRef<EquipmentTeaHandoffRecord | null>(null);

  const announce = useCallback((outcome: SaveOutcome, saved: TeaProjectContent): void => {
    if (outcome.ok) {
      setProjectStatus({ kind: 'saved', savedAt: outcome.savedAt });
      // the project that contains the hand-over is now written: only now is it removed from the queue (a failed removal is retried by the next successful save or opening)
      pendingHandoff.current = confirmHandoffDelivery(pendingHandoff.current, saved, record => acknowledgeEquipmentHandoff(record));
    }
    else if (outcome.reason === 'unavailable') setProjectStatus({ kind: 'unavailable' });
    else if (outcome.reason === 'invalid') setProjectStatus({ kind: 'invalid', problem: outcome.problem ?? 'проект не проходит проверку' });
    else if (outcome.reason === 'quota' || outcome.reason === 'error' || outcome.reason === 'quarantine_failed' || outcome.reason === 'quarantine_occupied') setProjectStatus({ kind: 'failed', reason: outcome.reason });
  }, []);

  // Shows a successfully read project: the inputs as they were, the results calculated again from the stored inputs of the last calculation.
  const applyProject = useCallback((c: TeaProjectContent, savedAt: string): void => {
    setFormA(c.formA); setFormB(c.formB); setCompareB(c.compareB); setCurrency(c.currency); setScenariosEnabled(c.scenariosEnabled); setScenarioForms(c.scenarioForms);
    setImportedHandoff(c.handoff); setReportSnapshot(c.calculation); setCalculatedFrom(c.calculatedFrom);
    const again = c.calculation ? recomputeResults(c.calculation) : null;
    setResultA(again?.resultA ?? null); setResultB(again?.resultB ?? null); setScenarioResults(again?.scenarioResults ?? { base: null, conservative: null, optimistic: null });
    setProjectStatus({ kind: 'restored', savedAt });
  }, []);

  const showLoaded = useCallback((loaded: ProjectLoadResult<TeaProjectContent>): void => {
    if (loaded.status === 'restored') applyProject(loaded.project.content, loaded.project.savedAt);
    else if (loaded.status === 'unavailable') setProjectStatus({ kind: 'unavailable' });
    else if (loaded.status === 'read_failed') setProjectStatus({ kind: 'read_failed' });
    else if (loaded.status === 'empty') setProjectStatus({ kind: 'new' });
    else setProjectStatus({ kind: 'unreadable' });
  }, [applyProject]);

  // Restore on mount (browser only), THEN pick up a pending Equipment Selector hand-over. Saving opens only after a successful read of the stored project, so the empty
  // initial form can never overwrite a saved one. Leaving the page (unmount, `pagehide`) saves whatever is still waiting.
  useEffect(() => {
    const t = setTimeout(() => {
      const p = createProjectPersistence(TEA_PROJECT_CONFIG, detectProjectStore);
      persistence.current = p;
      autosave.current = createAutosave(p, announce);
      const loaded = p.hydrate();
      showLoaded(loaded);
      if (loaded.status !== 'restored') autosave.current.update(latestProject.current);
      // The hand-over is READ, not removed. If the restored project already contains this very hand-over (it was saved earlier but the queue entry could not be removed),
      // it is not applied again - only the removal is retried. Otherwise it is applied on top of the restored project and removed after that project is safely saved.
      const record = peekPendingEquipmentHandoff();
      const plan = planHandoffDelivery(loaded.status === 'restored' ? loaded.project.content.handoff : null, record);
      if (record && plan === 'already_saved') acknowledgeEquipmentHandoff(record);
      else if (record && plan === 'apply') {
        pendingHandoff.current = record;
        const next = applyHandoffToProject(latestProject.current, record);      // only the card and the descriptive title of variant A
        setImportedHandoff(next.handoff);
        setFormA(prev => ({ ...prev, title: next.formA.title }));
      }
    }, 0);
    const leave = () => autosave.current?.flush();
    window.addEventListener('pagehide', leave);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pagehide', leave);
      autosave.current?.flush();
      autosave.current = null; persistence.current = null;
    };
  }, [announce, showLoaded]);

  useEffect(() => {
    latestProject.current = project;
    autosave.current?.update(project);
  }, [project]);

  // Another attempt to read the stored project after a failed read (explicit action only). If the user has already entered something, the stored project is NOT adopted
  // (it would replace their input); it is put aside in the backup slot before the first new save.
  function retryRead() {
    const p = persistence.current;
    if (!p) return;
    const pristine = JSON.stringify(latestProject.current) === JSON.stringify(defaultTeaProject());
    const loaded = p.hydrate({ keepExisting: !pristine });
    if (loaded.status === 'restored' && !pristine) { setProjectStatus({ kind: 'conflict' }); autosave.current?.update(latestProject.current); return; }
    showLoaded(loaded);
    if (p.isHydrated()) autosave.current?.update(latestProject.current);
  }

  // Clears the PROJECT of this tool after a confirmation. The data of other tools (Scientific Writer, Equipment Selector, the library) are not touched.
  function clearProject() {
    if (!window.confirm('Очистить проект? Будут удалены все введённые данные, варианты, сценарии и результаты техно-экономической оценки из этого браузера. Данные других инструментов не затрагиваются. Действие нельзя отменить.')) return;
    autosave.current?.cancel();                                // a waiting save must not write the deleted project back
    const outcome = persistence.current ? persistence.current.clear() : null;
    const d = defaultTeaProject();
    setFormA(d.formA); setFormB(d.formB); setCompareB(false); setCurrency('RUB'); setScenariosEnabled(false); setScenarioForms(d.scenarioForms);
    setImportedHandoff(null); setReportSnapshot(null); setCalculatedFrom(null); setResultA(null); setResultB(null); setScenarioResults({ base: null, conservative: null, optimistic: null }); setError('');
    if (!outcome) setProjectStatus({ kind: 'unavailable' });
    else if (outcome.ok) setProjectStatus({ kind: 'new' });
    else if (outcome.reason === 'not_hydrated') setProjectStatus({ kind: 'read_failed' });
    else if (outcome.reason === 'unavailable') setProjectStatus({ kind: 'unavailable' });
    else setProjectStatus({ kind: 'failed', reason: outcome.reason });
  }

  function updateScenarioForm(key: ScenarioKey, patch: Partial<FormState>) {
    setScenarioForms(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function calculate(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setResultA(null); setResultB(null); setReportSnapshot(null); setCalculatedFrom(null);
    setScenarioResults({ base: null, conservative: null, optimistic: null });
    try {
      const inputA = toAssessmentInput(formA);
      const variant = (form: FormState, input: AssessmentInput): ReportVariant => ({ ...(form.title.trim() !== '' ? { title: form.title } : {}), input });
      const snapshot: ReportSnapshot = { currency, variantA: variant(formA, inputA), ...(importedHandoff ? { handoff: importedHandoff.handoff } : {}) };
      setResultA(runAssessment(inputA));
      if (compareB) { const inputB = toAssessmentInput(formB); setResultB(runAssessment(inputB)); snapshot.variantB = variant(formB, inputB); }
      if (scenariosEnabled) {
        const next = { base: null, conservative: null, optimistic: null } as Record<ScenarioKey, AssessmentResult | null>;
        const inputs = {} as Record<ScenarioKey, ReportVariant>;
        for (const key of SCENARIO_KEYS) { const input = toAssessmentInput(scenarioForms[key]); next[key] = runAssessment(input); inputs[key] = variant(scenarioForms[key], input); }
        setScenarioResults(next);
        snapshot.scenarios = inputs;
      }
      setReportSnapshot(snapshot);
      setCalculatedFrom({ formA, formB, compareB, currency, scenariosEnabled, scenarioForms, handoff: importedHandoff });      // the FORM the results were calculated from (to tell when it changes)
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось выполнить расчёт.'); }
  }

  // The shown results belong to the CALCULATION (its inputs, currency and titles), not to the form, which may have changed since. They are never recalculated without the
  // user pressing "Рассчитать"; if the form differs from the calculation, that is said plainly.
  const stale = isCalculationStale(project);
  const shown = shownResultContext(project);
  const shownCurrency = shown?.currency ?? currency;
  const scenariosShown = reportSnapshot ? !!reportSnapshot.scenarios : scenariosEnabled;

  const comparisonRows = useMemo(() => {
    if (!resultA || !resultB) return null;
    const money = (v: number) => formatCurrency(v, shownCurrency);
    return [
      ['CAPEX', money(resultA.capex.total), money(resultB.capex.total)],
      ['OPEX / год', money(resultA.opex.annualTotal), money(resultB.opex.annualTotal)],
      ['Выпуск / год', resultA.capacity.unitsPerYear.toFixed(0), resultB.capacity.unitsPerYear.toFixed(0)],
      ['Себестоимость / ед.', money(resultA.unitCost.withoutDepreciation), money(resultB.unitCost.withoutDepreciation)],
      ['Годовая экономия', money(resultA.economicEffect.annualSavings), money(resultB.economicEffect.annualSavings)],
      ['Окупаемость, лет', resultA.payback.years?.toFixed(2) ?? '—', resultB.payback.years?.toFixed(2) ?? '—'],
      ['ROI, %', resultA.roi.percent.toFixed(1), resultB.roi.percent.toFixed(1)],
    ];
  }, [resultA, resultB, shownCurrency]);

  const scenarioComparisonRows = useMemo(() => {
    const results = SCENARIO_KEYS.map(key => scenarioResults[key]);
    if (results.some(r => r === null)) return null;
    const rs = results as AssessmentResult[];
    const money = (v: number) => formatCurrency(v, shownCurrency);
    return [
      ['CAPEX', ...rs.map(r => money(r.capex.total))],
      ['OPEX / год', ...rs.map(r => money(r.opex.annualTotal))],
      ['Выпуск / год', ...rs.map(r => r.capacity.unitsPerYear.toFixed(0))],
      ['Себестоимость / ед.', ...rs.map(r => money(r.unitCost.withoutDepreciation))],
      ['Годовая экономия', ...rs.map(r => money(r.economicEffect.annualSavings))],
      ['Окупаемость, лет', ...rs.map(r => r.payback.years?.toFixed(2) ?? '—')],
      ['ROI, %', ...rs.map(r => r.roi.percent.toFixed(1))],
    ];
  }, [scenarioResults, shownCurrency]);

  return <div>
    <p className="muted small mb-4">Реальный локальный расчёт по прозрачным формулам - без внешних API и без LLM. Ниже можно раскрыть «Как рассчитано» для каждой формулы.</p>
    <section className="content-card mb-4" role="status" aria-live="polite" data-testid="project-status">
      <p className="small">
        <strong>Проект сохраняется автоматически только в этом браузере</strong> (локально, на сервер и в сторонние сервисы не отправляется). Он не шифруется и не копируется в резерв:
        доступен всем, кто работает в этом профиле браузера, и пропадёт при очистке данных сайта. Сохраняются введённые данные и настройки; результаты при восстановлении рассчитываются заново.
      </p>
      <p className="muted small">
        {projectStatus.kind === 'loading' && 'Проверяю сохранённый проект…'}
        {projectStatus.kind === 'new' && 'Сохранённого проекта нет — изменения будут сохраняться автоматически.'}
        {projectStatus.kind === 'restored' && `Проект восстановлен (сохранён в ${timeOf(projectStatus.savedAt)}).`}
        {projectStatus.kind === 'saved' && `Сохранено в ${timeOf(projectStatus.savedAt)}.`}
        {projectStatus.kind === 'unavailable' && 'Локальное хранилище браузера недоступно: проект пока не сохраняется и пропадёт при обновлении страницы. Введённые данные остаются на экране; если доступ был временно закрыт, можно повторить попытку.'}
        {projectStatus.kind === 'read_failed' && 'Не удалось прочитать сохранённый проект (возможно, временно). Сохранение приостановлено, чтобы не затереть его; ранее сохранённые данные не удалены.'}
        {projectStatus.kind === 'conflict' && 'Найден ранее сохранённый проект, но вы уже начали новый ввод. Он не загружен и будет перемещён в отдельную ячейку хранилища перед первым новым сохранением.'}
        {projectStatus.kind === 'unreadable' && 'Ранее сохранённый проект повреждён или создан другой версией и не загружен. Он будет перемещён в отдельную ячейку хранилища перед первым новым сохранением.'}
        {projectStatus.kind === 'invalid' && `Проект не сохранён: ${projectStatus.problem} Данные на экране не потеряны и не изменены; ранее сохранённый проект остался без изменений.`}
        {projectStatus.kind === 'failed' && projectStatus.reason === 'quota' && 'Не удалось сохранить: хранилище браузера переполнено. Данные на экране не потеряны, но при закрытии страницы они пропадут.'}
        {projectStatus.kind === 'failed' && projectStatus.reason === 'error' && 'Не удалось сохранить проект. Данные на экране не потеряны; повторная попытка будет при следующем изменении.'}
        {projectStatus.kind === 'failed' && projectStatus.reason === 'quarantine_occupied' && 'Резервная ячейка уже занята другим сохранённым документом, который не удаляется автоматически. Новые изменения не сохраняются, чтобы не уничтожить данные.'}
        {projectStatus.kind === 'failed' && projectStatus.reason === 'quarantine_failed' && 'Ранее сохранённые нераспознанные данные нельзя безопасно отложить, поэтому новые изменения не сохраняются, чтобы не стереть их.'}
      </p>
      {(projectStatus.kind === 'read_failed' || projectStatus.kind === 'unavailable') && <button type="button" className="button secondary mt-2" onClick={retryRead}>Повторить чтение проекта</button>}
    </section>
    {importedHandoff && <ImportedFromEquipmentSelector record={importedHandoff} onDismiss={() => setImportedHandoff(null)} />}
    <form onSubmit={calculate} className="flex flex-col gap-6">
      <label className="text-sm">Валюта отображения (без автоматической конвертации)
        <select className="rounded-md border border-[#dce0e5] p-3 mt-1" value={currency} onChange={e => setCurrency(e.target.value as Currency)}>
          <option value="RUB">₽ Рубль</option><option value="USD">$ Доллар</option><option value="EUR">€ Евро</option>
        </select>
      </label>

      <h2 className="mt-2">Вариант A</h2>
      <TitleField value={formA.title} onChange={v => setFormA({ ...formA, title: v })} />
      <CapexSection value={formA.capex} onChange={v => setFormA({ ...formA, capex: v })} />
      <OpexSection period={formA.opexPeriod} value={formA.opex} onPeriodChange={p => setFormA({ ...formA, opexPeriod: p })} onChange={v => setFormA({ ...formA, opex: v })} />
      <CapacitySection value={formA.capacity} onChange={v => setFormA({ ...formA, capacity: v })} depreciationYears={formA.depreciationYears} onDepreciationChange={v => setFormA({ ...formA, depreciationYears: v })} />
      <EconomicEffectSection
        mode={formA.effectMode} onModeChange={m => setFormA({ ...formA, effectMode: m })}
        currentUnitCost={formA.currentUnitCost} newUnitCost={formA.newUnitCost} currentAnnualCost={formA.currentAnnualCost} newAnnualCost={formA.newAnnualCost}
        onChange={(field, v) => setFormA({ ...formA, [field]: v })}
      />

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={compareB} onChange={e => setCompareB(e.target.checked)} /> F. Сравнить с Вариантом B (например: другая установка, аутсорсинг, старая технология)
      </label>
      {compareB && <>
        <h2>Вариант B</h2>
        <TitleField value={formB.title} onChange={v => setFormB({ ...formB, title: v })} />
        <CapexSection value={formB.capex} onChange={v => setFormB({ ...formB, capex: v })} />
        <OpexSection period={formB.opexPeriod} value={formB.opex} onPeriodChange={p => setFormB({ ...formB, opexPeriod: p })} onChange={v => setFormB({ ...formB, opex: v })} />
        <CapacitySection value={formB.capacity} onChange={v => setFormB({ ...formB, capacity: v })} depreciationYears={formB.depreciationYears} onDepreciationChange={v => setFormB({ ...formB, depreciationYears: v })} />
        <EconomicEffectSection
          mode={formB.effectMode} onModeChange={m => setFormB({ ...formB, effectMode: m })}
          currentUnitCost={formB.currentUnitCost} newUnitCost={formB.newUnitCost} currentAnnualCost={formB.currentAnnualCost} newAnnualCost={formB.newAnnualCost}
          onChange={(field, v) => setFormB({ ...formB, [field]: v })}
        />
      </>}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={scenariosEnabled} onChange={e => setScenariosEnabled(e.target.checked)} /> G. Сравнить 3 сценария (Базовый / Консервативный / Оптимистичный)
      </label>
      <p className="muted small">Каждый сценарий считается тем же самым движком расчёта - разница только в значениях, которые вы вводите сами. Платформа не придумывает оптимистичные или консервативные допущения автоматически.</p>
      {scenariosEnabled && SCENARIO_KEYS.map(key => <div key={key} className="flex flex-col gap-6">
        <h2>{SCENARIO_LABELS[key]}</h2>
        <TitleField value={scenarioForms[key].title} onChange={v => updateScenarioForm(key, { title: v })} />
        <CapexSection value={scenarioForms[key].capex} onChange={v => updateScenarioForm(key, { capex: v })} />
        <OpexSection period={scenarioForms[key].opexPeriod} value={scenarioForms[key].opex} onPeriodChange={p => updateScenarioForm(key, { opexPeriod: p })} onChange={v => updateScenarioForm(key, { opex: v })} />
        <CapacitySection value={scenarioForms[key].capacity} onChange={v => updateScenarioForm(key, { capacity: v })} depreciationYears={scenarioForms[key].depreciationYears} onDepreciationChange={v => updateScenarioForm(key, { depreciationYears: v })} />
        <EconomicEffectSection
          mode={scenarioForms[key].effectMode} onModeChange={m => updateScenarioForm(key, { effectMode: m })}
          currentUnitCost={scenarioForms[key].currentUnitCost} newUnitCost={scenarioForms[key].newUnitCost}
          currentAnnualCost={scenarioForms[key].currentAnnualCost} newAnnualCost={scenarioForms[key].newAnnualCost}
          onChange={(field, v) => updateScenarioForm(key, { [field]: v })}
        />
      </div>)}

      <div className="flex gap-2 self-start">
        <button className="button primary">Рассчитать</button>
        <button type="button" className="button secondary" onClick={clearProject}>Очистить проект</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>

    {resultA && stale && <p role="status" className="content-card mt-6" data-testid="stale-results">{STALE_RESULTS_MESSAGE}</p>}
    {resultA && !stale && <section className="mt-6" aria-live="polite">
      <h2>E. Результаты{resultB ? ' - Вариант A' : ''}{shown?.titleA ? `: ${shown.titleA}` : ''}</h2>
      <ResultCards result={resultA} currency={shownCurrency} />
      <FormulasDisclosure result={resultA} />
      {reportSnapshot && <ReportDownload snapshot={reportSnapshot} displayCurrency={currency} />}
    </section>}

    {resultB && !stale && <section className="mt-6" aria-live="polite">
      <h2>Результаты - Вариант B{shown?.titleB ? `: ${shown.titleB}` : ''}</h2>
      <ResultCards result={resultB} currency={shownCurrency} />
      <FormulasDisclosure result={resultB} />
    </section>}

    {comparisonRows && !stale && <section className="mt-6">
      <h2>Сравнение вариантов</h2>
      <table className="w-full text-sm"><thead><tr><th className="text-left">Показатель</th><th className="text-left">Вариант A</th><th className="text-left">Вариант B</th></tr></thead>
        <tbody>{comparisonRows.map(([label, a, b]) => <tr key={label}><td>{label}</td><td>{a}</td><td>{b}</td></tr>)}</tbody>
      </table>
      <p className="muted small mt-2">Сравнение носит информационный характер - платформа не выбирает «победителя» автоматически.</p>
    </section>}

    {scenariosShown && !stale && SCENARIO_KEYS.map(key => scenarioResults[key] && <section className="mt-6" key={key} aria-live="polite">
      <h2>Результаты - {SCENARIO_LABELS[key]}{shown?.scenarioTitles[key] ? `: ${shown.scenarioTitles[key]}` : ''}</h2>
      <ResultCards result={scenarioResults[key]!} currency={shownCurrency} />
      <FormulasDisclosure result={scenarioResults[key]!} />
    </section>)}

    {scenarioComparisonRows && !stale && <section className="mt-6">
      <h2>Сравнение сценариев</h2>
      <table className="w-full text-sm"><thead><tr><th className="text-left">Показатель</th>{SCENARIO_KEYS.map(key => <th key={key} className="text-left">{SCENARIO_LABELS[key]}</th>)}</tr></thead>
        <tbody>{scenarioComparisonRows.map(([label, ...values]) => <tr key={label}><td>{label}</td>{values.map((v, i) => <td key={i}>{v}</td>)}</tr>)}</tbody>
      </table>
      <p className="muted small mt-2">Сравнение носит информационный характер - платформа не выбирает «победителя» автоматически.</p>
    </section>}

    <p className="muted small mt-6">Расчёт является инженерно-экономической оценкой и не заменяет бухгалтерское, налоговое или инвестиционное заключение.</p>
  </div>;
}
