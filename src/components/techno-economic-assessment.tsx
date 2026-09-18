'use client';

import { useMemo, useState } from 'react';
import {
  formatCurrency, runAssessment,
  type AssessmentInput, type AssessmentResult, type Currency, type EconomicEffectMode, type OpexPeriod,
} from '@/services/workspace/techno-economic-assessment';

// ---------- raw (string) form state - converted to numbers only at calculation time ----------

interface FormState {
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

  function calculate(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setResultA(null); setResultB(null);
    try {
      setResultA(runAssessment(toAssessmentInput(formA)));
      if (compareB) setResultB(runAssessment(toAssessmentInput(formB)));
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

  return <div>
    <p className="muted small mb-4">Реальный локальный расчёт по прозрачным формулам - без внешних API и без LLM. Ниже можно раскрыть «Как рассчитано» для каждой формулы.</p>
    <form onSubmit={calculate} className="flex flex-col gap-6">
      <label className="text-sm">Валюта отображения (без автоматической конвертации)
        <select className="rounded-md border border-[#dce0e5] p-3 mt-1" value={currency} onChange={e => setCurrency(e.target.value as Currency)}>
          <option value="RUB">₽ Рубль</option><option value="USD">$ Доллар</option><option value="EUR">€ Евро</option>
        </select>
      </label>

      <h2 className="mt-2">Вариант A</h2>
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
        <CapexSection value={formB.capex} onChange={v => setFormB({ ...formB, capex: v })} />
        <OpexSection period={formB.opexPeriod} value={formB.opex} onPeriodChange={p => setFormB({ ...formB, opexPeriod: p })} onChange={v => setFormB({ ...formB, opex: v })} />
        <CapacitySection value={formB.capacity} onChange={v => setFormB({ ...formB, capacity: v })} depreciationYears={formB.depreciationYears} onDepreciationChange={v => setFormB({ ...formB, depreciationYears: v })} />
        <EconomicEffectSection
          mode={formB.effectMode} onModeChange={m => setFormB({ ...formB, effectMode: m })}
          currentUnitCost={formB.currentUnitCost} newUnitCost={formB.newUnitCost} currentAnnualCost={formB.currentAnnualCost} newAnnualCost={formB.newAnnualCost}
          onChange={(field, v) => setFormB({ ...formB, [field]: v })}
        />
      </>}

      <button className="button primary self-start">Рассчитать</button>
      {error && <p role="alert">{error}</p>}
    </form>

    {resultA && <section className="mt-6" aria-live="polite">
      <h2>E. Результаты{compareB ? ' - Вариант A' : ''}</h2>
      <ResultCards result={resultA} currency={currency} />
      <FormulasDisclosure result={resultA} />
    </section>}

    {resultB && <section className="mt-6" aria-live="polite">
      <h2>Результаты - Вариант B</h2>
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

    <p className="muted small mt-6">Расчёт является инженерно-экономической оценкой и не заменяет бухгалтерское, налоговое или инвестиционное заключение.</p>
  </div>;
}
