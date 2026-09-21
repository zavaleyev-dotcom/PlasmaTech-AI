'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  matchEquipment, compareConfigurations, buildTechnoEconomicHandoff, EQUIPMENT_CONFIGURATIONS, REQUIREMENT_PRESETS,
  PURPOSES, TECHNOLOGIES, SUBSTRATE_TYPES, MATERIAL_CLASSES, THROUGHPUT_CLASSES, AUTOMATION_LEVELS, CLEANROOM_CLASSES, LABELS,
  type EquipmentRequirement, type MatchResult, type ComparisonRow, type TechnoEconomicHandoff,
} from '@/services/workspace/equipment-selector';
import { queueEquipmentHandoff } from '@/services/workspace/equipment-tea-handoff';

interface FormState {
  purpose: string; technology: string; substrateType: string; maxSizeMm: string;
  materialClass: string; maxProcessTempC: string; minMbar: string; maxMbar: string;
  magnetronCount: string; arcSourceCount: string; icpRf: boolean; substrateBias: boolean; ionSource: boolean; combinedModeRequired: boolean;
  gasLines: string; processGases: string; mfcRequired: boolean;
  throughputClass: string; automation: string; cleanroom: string; specialRequirements: string;
}

function defaultForm(): FormState {
  return {
    purpose: '', technology: '', substrateType: '', maxSizeMm: '',
    materialClass: '', maxProcessTempC: '', minMbar: '', maxMbar: '',
    magnetronCount: '0', arcSourceCount: '0', icpRf: false, substrateBias: false, ionSource: false, combinedModeRequired: false,
    gasLines: '2', processGases: '', mfcRequired: true,
    throughputClass: '', automation: '', cleanroom: '', specialRequirements: '',
  };
}

function toRequirement(form: FormState): EquipmentRequirement {
  return {
    purpose: form.purpose as EquipmentRequirement['purpose'],
    technology: form.technology as EquipmentRequirement['technology'],
    substrateType: form.substrateType as EquipmentRequirement['substrateType'],
    maxSizeMm: Number(form.maxSizeMm),
    materialClass: form.materialClass as EquipmentRequirement['materialClass'],
    maxProcessTempC: Number(form.maxProcessTempC),
    pressureRange: { minMbar: Number(form.minMbar), maxMbar: Number(form.maxMbar) },
    sources: {
      magnetronCount: Number(form.magnetronCount), arcSourceCount: Number(form.arcSourceCount),
      icpRf: form.icpRf, substrateBias: form.substrateBias, ionSource: form.ionSource, combinedModeRequired: form.combinedModeRequired,
    },
    gasSystem: { gasLines: Number(form.gasLines), processGases: form.processGases.split(',').map(s => s.trim()).filter(Boolean), mfcRequired: form.mfcRequired },
    throughputClass: form.throughputClass as EquipmentRequirement['throughputClass'],
    automation: form.automation as EquipmentRequirement['automation'],
    cleanroom: form.cleanroom as EquipmentRequirement['cleanroom'],
    specialRequirements: form.specialRequirements || undefined,
  };
}

function fromRequirement(req: EquipmentRequirement): FormState {
  return {
    purpose: req.purpose, technology: req.technology, substrateType: req.substrateType, maxSizeMm: String(req.maxSizeMm),
    materialClass: req.materialClass, maxProcessTempC: String(req.maxProcessTempC),
    minMbar: String(req.pressureRange.minMbar), maxMbar: String(req.pressureRange.maxMbar),
    magnetronCount: String(req.sources.magnetronCount), arcSourceCount: String(req.sources.arcSourceCount),
    icpRf: req.sources.icpRf, substrateBias: req.sources.substrateBias, ionSource: req.sources.ionSource, combinedModeRequired: req.sources.combinedModeRequired,
    gasLines: String(req.gasSystem.gasLines), processGases: req.gasSystem.processGases.join(', '), mfcRequired: req.gasSystem.mfcRequired,
    throughputClass: req.throughputClass, automation: req.automation, cleanroom: req.cleanroom, specialRequirements: req.specialRequirements ?? '',
  };
}

const STATUS_LABEL: Record<MatchResult['status'], string> = {
  recommended: 'Рекомендовано',
  suitable_with_modifications: 'Подходит с доработками',
  not_suitable: 'Не соответствует обязательным требованиям',
};

function BreakdownBar({ label, value }: { label: string; value: number }) {
  return <div className="text-sm">
    <div className="flex justify-between"><span>{label}</span><span>{value.toFixed(0)}%</span></div>
    <div style={{ background: '#eee', borderRadius: 4, height: 6, marginTop: 2 }}>
      <div style={{ background: value >= 100 ? '#4caf7d' : value > 0 ? '#eda183' : '#cc4b4b', width: `${Math.min(100, Math.max(0, value))}%`, height: 6, borderRadius: 4 }} />
    </div>
  </div>;
}

function ResultCard({ result, onHandoff }: { result: MatchResult; onHandoff: (config: MatchResult['config']) => void }) {
  return <article className="content-card">
    <h3>{result.config.name}</h3>
    <p className="muted small">{result.config.description}</p>
    <p><strong>{STATUS_LABEL[result.status]}</strong>{result.overallScore !== null && ` — ${result.overallScore.toFixed(0)}%`}</p>
    {result.breakdown && <div className="flex flex-col gap-2 mt-3">
      <BreakdownBar label="Процесс" value={result.breakdown.process} />
      <BreakdownBar label="Подложка/изделие" value={result.breakdown.substrate} />
      <BreakdownBar label="Источники" value={result.breakdown.sources} />
      <BreakdownBar label="Газовая система" value={result.breakdown.gas} />
      <BreakdownBar label="Температура" value={result.breakdown.temperature} />
      <BreakdownBar label="Автоматизация" value={result.breakdown.automation} />
      <BreakdownBar label="Производительность" value={result.breakdown.throughput} />
      <BreakdownBar label="Cleanroom" value={result.breakdown.cleanroom} />
    </div>}
    {result.exclusionReasons.length > 0 && <div className="mt-3">
      <h4>Причины исключения</h4>
      <ul className="list-disc">{result.exclusionReasons.map(r => <li key={r}>{r}</li>)}</ul>
    </div>}
    {result.whyItFits.length > 0 && <div className="mt-3">
      <h4>Почему подходит</h4>
      <ul className="list-disc">{result.whyItFits.map(r => <li key={r}>{r}</li>)}</ul>
    </div>}
    {result.requiredModifications.length > 0 && <div className="mt-3">
      <h4>Что потребуется изменить</h4>
      <ul className="list-disc">{result.requiredModifications.map(r => <li key={r}>{r}</li>)}</ul>
    </div>}
    {result.status !== 'not_suitable' && <button type="button" className="button secondary mt-3" onClick={() => onHandoff(result.config)}>
      Передать в Техно-экономическую оценку
    </button>}
  </article>;
}

export function EquipmentSelector() {
  const [form, setForm] = useState<FormState>(defaultForm());
  const [results, setResults] = useState<MatchResult[] | null>(null);
  const [error, setError] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparisonRows, setComparisonRows] = useState<ComparisonRow[] | null>(null);
  const [comparisonError, setComparisonError] = useState('');
  const [handoff, setHandoff] = useState<TechnoEconomicHandoff | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function applyPreset(id: string) {
    const preset = REQUIREMENT_PRESETS.find(p => p.id === id);
    if (preset) { setForm(fromRequirement(preset.requirement)); setResults(null); setError(''); setHandoff(null); }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setResults(null); setHandoff(null);
    try {
      setResults(matchEquipment(toRequirement(form)));
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось выполнить подбор.'); }
  }

  function toggleCompare(id: string) {
    setCompareIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= 3 ? prev : [...prev, id]);
  }

  function runComparison() {
    setComparisonError(''); setComparisonRows(null);
    try { setComparisonRows(compareConfigurations(compareIds)); }
    catch (err) { setComparisonError(err instanceof Error ? err.message : 'Не удалось построить сравнение.'); }
  }

  const compareNames = useMemo(() => compareIds.map(id => EQUIPMENT_CONFIGURATIONS.find(c => c.id === id)?.name ?? id), [compareIds]);

  return <div className="flex flex-col gap-6">
    <section className="content-card">
      <h2>Примеры требований (пресеты)</h2>
      <p className="muted small">Пресеты только заполняют форму - никакого скрытого расчёта.</p>
      <div className="flex flex-wrap gap-2 mt-3">
        {REQUIREMENT_PRESETS.map(p => <button key={p.id} type="button" className="button secondary" onClick={() => applyPreset(p.id)}>{p.label}</button>)}
      </div>
    </section>

    <form onSubmit={submit} className="flex flex-col gap-6">
      <fieldset className="content-card">
        <legend><h2>A. Задача / B. Процесс</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Назначение *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.purpose} onChange={e => set('purpose', e.target.value)}>
              <option value="">— выберите —</option>
              {PURPOSES.map(p => <option key={p} value={p}>{LABELS.purpose[p]}</option>)}
            </select>
          </label>
          <label className="text-sm">Технология *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.technology} onChange={e => set('technology', e.target.value)}>
              <option value="">— выберите —</option>
              {TECHNOLOGIES.map(t => <option key={t} value={t}>{LABELS.technology[t]}</option>)}
            </select>
          </label>
          <label className="text-sm">Материалы/процесс *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.materialClass} onChange={e => set('materialClass', e.target.value)}>
              <option value="">— выберите —</option>
              {MATERIAL_CLASSES.map(m => <option key={m} value={m}>{LABELS.material[m]}</option>)}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="content-card">
        <legend><h2>C. Изделие/подложка</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Тип подложки/изделия *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.substrateType} onChange={e => set('substrateType', e.target.value)}>
              <option value="">— выберите —</option>
              {SUBSTRATE_TYPES.map(s => <option key={s} value={s}>{LABELS.substrate[s]}</option>)}
            </select>
          </label>
          <label className="text-sm">Максимальный размер, мм *
            <input required type="number" step="any" min={0} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.maxSizeMm} onChange={e => set('maxSizeMm', e.target.value)} />
          </label>
        </div>
      </fieldset>

      <fieldset className="content-card">
        <legend><h2>D. Источники плазмы/осаждения</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Количество магнетронов
            <input type="number" min={0} step={1} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.magnetronCount} onChange={e => set('magnetronCount', e.target.value)} />
          </label>
          <label className="text-sm">Количество arc-источников
            <input type="number" min={0} step={1} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.arcSourceCount} onChange={e => set('arcSourceCount', e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap gap-4 mt-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.icpRf} onChange={e => set('icpRf', e.target.checked)} /> ICP/RF</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.substrateBias} onChange={e => set('substrateBias', e.target.checked)} /> Substrate bias</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.ionSource} onChange={e => set('ionSource', e.target.checked)} /> Ion source</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.combinedModeRequired} onChange={e => set('combinedModeRequired', e.target.checked)} /> Комбинированный режим</label>
        </div>
      </fieldset>

      <fieldset className="content-card">
        <legend><h2>E. Газовая система</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Число газовых линий *
            <input required type="number" min={0} step={1} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.gasLines} onChange={e => set('gasLines', e.target.value)} />
          </label>
          <label className="text-sm">Процессные газы (через запятую)
            <input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.processGases} onChange={e => set('processGases', e.target.value)} placeholder="Ar, N2, O2" />
          </label>
          <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" checked={form.mfcRequired} onChange={e => set('mfcRequired', e.target.checked)} /> Требуется MFC</label>
        </div>
      </fieldset>

      <fieldset className="content-card">
        <legend><h2>F. Температура/давление</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Максимальная температура подложки, °C *
            <input required type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.maxProcessTempC} onChange={e => set('maxProcessTempC', e.target.value)} />
          </label>
          <label className="text-sm">Мин. давление, мбар *
            <input required type="number" step="any" min={0} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.minMbar} onChange={e => set('minMbar', e.target.value)} />
          </label>
          <label className="text-sm">Макс. давление, мбар *
            <input required type="number" step="any" min={0} className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.maxMbar} onChange={e => set('maxMbar', e.target.value)} />
          </label>
        </div>
      </fieldset>

      <fieldset className="content-card">
        <legend><h2>G. Автоматизация / H. Производительность / I. Cleanroom</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Автоматизация *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.automation} onChange={e => set('automation', e.target.value)}>
              <option value="">— выберите —</option>
              {AUTOMATION_LEVELS.map(a => <option key={a} value={a}>{LABELS.automation[a]}</option>)}
            </select>
          </label>
          <label className="text-sm">Производительность *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.throughputClass} onChange={e => set('throughputClass', e.target.value)}>
              <option value="">— выберите —</option>
              {THROUGHPUT_CLASSES.map(t => <option key={t} value={t}>{LABELS.throughput[t]}</option>)}
            </select>
          </label>
          <label className="text-sm">Cleanroom *
            <select required className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.cleanroom} onChange={e => set('cleanroom', e.target.value)}>
              <option value="">— выберите —</option>
              {CLEANROOM_CLASSES.map(c => <option key={c} value={c}>{LABELS.cleanroom[c]}</option>)}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="content-card">
        <legend><h2>Особые требования</h2></legend>
        <textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={3} maxLength={2000}
          value={form.specialRequirements} onChange={e => set('specialRequirements', e.target.value)}
          placeholder="Свободное описание дополнительных пожеланий" />
        <p className="muted small mt-2">Свободный текст не участвует в автоматическом расчёте соответствия - только сохраняется и отображается.</p>
      </fieldset>

      <button className="button primary self-start">Подобрать оборудование</button>
      {error && <p role="alert">{error}</p>}
    </form>

    {results && <section className="mt-2" aria-live="polite">
      <h2>J. Результаты подбора</h2>
      <p className="muted small">Платформа не выбирает «победителя» автоматически - решение принимает пользователь.</p>
      <div className="content-grid mt-3">
        {results.map(r => <div key={r.config.id} className="flex flex-col gap-2">
          <ResultCard result={r} onHandoff={config => { const built = buildTechnoEconomicHandoff(config); setHandoff(built); queueEquipmentHandoff(built); }} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={compareIds.includes(r.config.id)} onChange={() => toggleCompare(r.config.id)} disabled={!compareIds.includes(r.config.id) && compareIds.length >= 3} />
            Добавить к сравнению
          </label>
        </div>)}
      </div>
    </section>}

    {compareIds.length > 0 && <section className="content-card">
      <h2>Сравнение конфигураций ({compareNames.join(', ')})</h2>
      <button type="button" className="button secondary mt-2" onClick={runComparison} disabled={compareIds.length < 2}>Сравнить</button>
      {comparisonError && <p role="alert">{comparisonError}</p>}
      {comparisonRows && <div className="mt-4" style={{ overflowX: 'auto' }}>
        <table className="w-full text-sm">
          <thead><tr><th className="text-left">Параметр</th>{compareNames.map(n => <th key={n} className="text-left">{n}</th>)}</tr></thead>
          <tbody>{comparisonRows.map(row => <tr key={row.parameter}><td>{row.parameter}</td>{row.values.map((v, i) => <td key={i}>{v}</td>)}</tr>)}</tbody>
        </table>
      </div>}
    </section>}

    {handoff && <section className="content-card">
      <h2>Передача в Техно-экономическую оценку</h2>
      <p className="muted small">Технические параметры этой конфигурации переданы в Техно-экономическую оценку - откройте её ниже, они уже будут там (с пометкой источника).</p>
      <p className="muted small">{handoff.note}</p>
      <ul className="list-disc mt-3">
        <li>Конфигурация: {handoff.configurationName}</li>
        <li>Процессы: {handoff.supportedPurposes.join(', ')}</li>
        <li>Технологии: {handoff.supportedTechnologies.join(', ')}</li>
        <li>Макс. размер: {handoff.maxChamberSizeMm} мм</li>
        <li>Макс. температура: {handoff.maxProcessTempC}°C</li>
        <li>Источники: {handoff.sourcesSummary}</li>
        <li>Газовые линии (макс.): {handoff.maxGasLines}</li>
        <li>Производительность: {handoff.throughputClasses.join(', ')}</li>
        <li>Автоматизация: {handoff.automationLevels.join(', ')}</li>
        <li>Cleanroom: {handoff.cleanroomSupport.join(', ')}</li>
      </ul>
      <Link className="button primary mt-4" href="/workspace/techno-economic-assessment">Открыть Техно-экономическую оценку</Link>
    </section>}
  </div>;
}
