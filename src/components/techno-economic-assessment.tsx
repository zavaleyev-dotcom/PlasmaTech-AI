'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  formatCurrency, runAssessment,
  type AssessmentInput, type AssessmentResult, type Currency, type EconomicEffectMode, type OpexPeriod,
} from '@/services/workspace/techno-economic-assessment';
import { consumePendingEquipmentHandoff, type EquipmentTeaHandoffRecord } from '@/services/workspace/equipment-tea-handoff';

// ---------- raw (string) form state - converted to numbers only at calculation time ----------

interface FormState {
  title: string;
  capex: Record<'equipment' | 'delivery' | 'customsLogistics' | 'installation' | 'commissioning' | 'training' | 'infrastructure' | 'tooling' | 'otherOneTime', string>;
  opexPeriod: OpexPeriod;
  opex: Record<'electricity' | 'processGases' | 'consumables' | 'targetsCathodes' | 'reagents' | 'maintenance' | 'repairs' | 'labor' | 'facilities' | 'disposal' | 'otherOperating', string>;
  capacity: Record<'shiftsPerDay' | 'hoursPerShift' | 'workingDaysPerYear' | 'utilizationPercent' | 'cycleTimeMinutes' | 'unitsPerCycle', string>;
  depreciationYears: string;
  effectMode: EconomicEffectMode;
  currentUnitCost: string; newUnitCost: string;
  currentAnnualCost: string; newAnnualCost: string;
}

function defaultForm(): FormState {
  return {
    title: '',
    capex: { equipment: '', delivery: '', customsLogistics: '', installation: '', commissioning: '', training: '', infrastructure: '', tooling: '', otherOneTime: '' },
    opexPeriod: 'year',
    opex: { electricity: '', processGases: '', consumables: '', targetsCathodes: '', reagents: '', maintenance: '', repairs: '', labor: '', facilities: '', disposal: '', otherOperating: '' },
    capacity: { shiftsPerDay: '2', hoursPerShift: '8', workingDaysPerYear: '250', utilizationPercent: '80', cycleTimeMinutes: '20', unitsPerCycle: '1' },
    depreciationYears: '',
    effectMode: 'total_external_cost',
    currentUnitCost: '', newUnitCost: '',
    currentAnnualCost: '', newAnnualCost: '',
  };
}

// ---------- 3-scenario analysis (Base / Conservative / Optimistic) - same engine, same form
// shape as Variant A/B above; the user must explicitly set each scenario's own numbers, nothing
// is auto-derived or invented between scenarios. ----------

export const SCENARIO_KEYS = ['base', 'conservative', 'optimistic'] as const;
export type ScenarioKey = typeof SCENARIO_KEYS[number];
export const SCENARIO_LABELS: Record<ScenarioKey, string> = { base: 'Базовый', conservative: 'Консервативный', optimistic: 'Оптимистичный' };

export function defaultScenarioForms(): Record<ScenarioKey, FormState> {
  return { base: defaultForm(), conservative: defaultForm(), optimistic: defaultForm() };
}

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

function toAssessmentInput(form: FormState): AssessmentInput {
  return {
    capex: {
      equipment: Number(form.capex.equipment),
      delivery: num(form.capex.delivery), customsLogistics: num(form.capex.customsLogistics), installation: num(form.capex.installation),
      commissioning: num(form.capex.commissioning), training: num(form.capex.training), infrastructure: num(form.capex.infrastructure),
      tooling: num(form.capex.tooling), otherOneTime: num(form.capex.otherOneTime),
    },
    opex: {
      period: form.opexPeriod,
      electricity: num(form.opex.electricity), processGases: num(form.opex.processGases), consumables: num(form.opex.consumables),
      targetsCathodes: num(form.opex.targetsCathodes), reagents: num(form.opex.reagents), maintenance: num(form.opex.maintenance),
      repairs: num(form.opex.repairs), labor: num(form.opex.labor), facilities: num(form.opex.facilities),
      disposal: num(form.opex.disposal), otherOperating: num(form.opex.otherOperating),
    },
    capacity: {
      shiftsPerDay: Number(form.capacity.shiftsPerDay), hoursPerShift: Number(form.capacity.hoursPerShift),
      workingDaysPerYear: Number(form.capacity.workingDaysPerYear), utilizationPercent: Number(form.capacity.utilizationPercent),
      cycleTimeMinutes: Number(form.capacity.cycleTimeMinutes), unitsPerCycle: Number(form.capacity.unitsPerCycle),
    },
    depreciationYears: num(form.depreciationYears),
    economicEffect: form.effectMode === 'unit_cost'
      ? { mode: 'unit_cost', currentUnitCost: num(form.currentUnitCost), newUnitCost: num(form.newUnitCost) }
      : { mode: 'total_external_cost', currentAnnualCost: num(form.currentAnnualCost), newAnnualCost: num(form.newAnnualCost) },
  };
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

  function updateScenarioForm(key: ScenarioKey, patch: Partial<FormState>) {
    setScenarioForms(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  // Picks up a pending handoff from Equipment Selector ("Передать в Техно-экономическую
  // оценку") since the last time this module was open - consumed once per mount, never
  // re-applied on remount, and never overwrites financial fields (only the descriptive title).
  useEffect(() => {
    const t = setTimeout(() => {
      const record = consumePendingEquipmentHandoff();
      if (record) {
        setImportedHandoff(record);
        setFormA(prev => ({ ...prev, title: record.handoff.configurationName }));
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  function calculate(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setResultA(null); setResultB(null);
    setScenarioResults({ base: null, conservative: null, optimistic: null });
    try {
      setResultA(runAssessment(toAssessmentInput(formA)));
      if (compareB) setResultB(runAssessment(toAssessmentInput(formB)));
      if (scenariosEnabled) {
        const next = { base: null, conservative: null, optimistic: null } as Record<ScenarioKey, AssessmentResult | null>;
        for (const key of SCENARIO_KEYS) next[key] = runAssessment(toAssessmentInput(scenarioForms[key]));
        setScenarioResults(next);
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось выполнить расчёт.'); }
  }

  const comparisonRows = useMemo(() => {
    if (!resultA || !resultB) return null;
    const money = (v: number) => formatCurrency(v, currency);
    return [
      ['CAPEX', money(resultA.capex.total), money(resultB.capex.total)],
      ['OPEX / год', money(resultA.opex.annualTotal), money(resultB.opex.annualTotal)],
      ['Выпуск / год', resultA.capacity.unitsPerYear.toFixed(0), resultB.capacity.unitsPerYear.toFixed(0)],
      ['Себестоимость / ед.', money(resultA.unitCost.withoutDepreciation), money(resultB.unitCost.withoutDepreciation)],
      ['Годовая экономия', money(resultA.economicEffect.annualSavings), money(resultB.economicEffect.annualSavings)],
      ['Окупаемость, лет', resultA.payback.years?.toFixed(2) ?? '—', resultB.payback.years?.toFixed(2) ?? '—'],
      ['ROI, %', resultA.roi.percent.toFixed(1), resultB.roi.percent.toFixed(1)],
    ];
  }, [resultA, resultB, currency]);

  const scenarioComparisonRows = useMemo(() => {
    const results = SCENARIO_KEYS.map(key => scenarioResults[key]);
    if (results.some(r => r === null)) return null;
    const rs = results as AssessmentResult[];
    const money = (v: number) => formatCurrency(v, currency);
    return [
      ['CAPEX', ...rs.map(r => money(r.capex.total))],
      ['OPEX / год', ...rs.map(r => money(r.opex.annualTotal))],
      ['Выпуск / год', ...rs.map(r => r.capacity.unitsPerYear.toFixed(0))],
      ['Себестоимость / ед.', ...rs.map(r => money(r.unitCost.withoutDepreciation))],
      ['Годовая экономия', ...rs.map(r => money(r.economicEffect.annualSavings))],
      ['Окупаемость, лет', ...rs.map(r => r.payback.years?.toFixed(2) ?? '—')],
      ['ROI, %', ...rs.map(r => r.roi.percent.toFixed(1))],
    ];
  }, [scenarioResults, currency]);

  return <div>
    <p className="muted small mb-4">Реальный локальный расчёт по прозрачным формулам - без внешних API и без LLM. Ниже можно раскрыть «Как рассчитано» для каждой формулы.</p>
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

      <button className="button primary self-start">Рассчитать</button>
      {error && <p role="alert">{error}</p>}
    </form>

    {resultA && <section className="mt-6" aria-live="polite">
      <h2>E. Результаты{compareB ? ' - Вариант A' : ''}{formA.title ? `: ${formA.title}` : ''}</h2>
      <ResultCards result={resultA} currency={currency} />
      <FormulasDisclosure result={resultA} />
    </section>}

    {resultB && <section className="mt-6" aria-live="polite">
      <h2>Результаты - Вариант B{formB.title ? `: ${formB.title}` : ''}</h2>
      <ResultCards result={resultB} currency={currency} />
      <FormulasDisclosure result={resultB} />
    </section>}

    {comparisonRows && <section className="mt-6">
      <h2>Сравнение вариантов</h2>
      <table className="w-full text-sm"><thead><tr><th className="text-left">Показатель</th><th className="text-left">Вариант A</th><th className="text-left">Вариант B</th></tr></thead>
        <tbody>{comparisonRows.map(([label, a, b]) => <tr key={label}><td>{label}</td><td>{a}</td><td>{b}</td></tr>)}</tbody>
      </table>
      <p className="muted small mt-2">Сравнение носит информационный характер - платформа не выбирает «победителя» автоматически.</p>
    </section>}

    {scenariosEnabled && SCENARIO_KEYS.map(key => scenarioResults[key] && <section className="mt-6" key={key} aria-live="polite">
      <h2>Результаты - {SCENARIO_LABELS[key]}{scenarioForms[key].title ? `: ${scenarioForms[key].title}` : ''}</h2>
      <ResultCards result={scenarioResults[key]!} currency={currency} />
      <FormulasDisclosure result={scenarioResults[key]!} />
    </section>)}

    {scenarioComparisonRows && <section className="mt-6">
      <h2>Сравнение сценариев</h2>
      <table className="w-full text-sm"><thead><tr><th className="text-left">Показатель</th>{SCENARIO_KEYS.map(key => <th key={key} className="text-left">{SCENARIO_LABELS[key]}</th>)}</tr></thead>
        <tbody>{scenarioComparisonRows.map(([label, ...values]) => <tr key={label}><td>{label}</td>{values.map((v, i) => <td key={i}>{v}</td>)}</tr>)}</tbody>
      </table>
      <p className="muted small mt-2">Сравнение носит информационный характер - платформа не выбирает «победителя» автоматически.</p>
    </section>}

    <p className="muted small mt-6">Расчёт является инженерно-экономической оценкой и не заменяет бухгалтерское, налоговое или инвестиционное заключение.</p>
  </div>;
}
