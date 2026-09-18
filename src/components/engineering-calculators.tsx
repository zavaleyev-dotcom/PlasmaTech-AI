'use client';

import { useState, type FormEvent } from 'react';
import {
  calculateMeanFreePath, depositionUnitLabel, solveDeposition,
  type DepositionSolveFor, type GasPreset, type PressureUnit, type RateUnit, type ThicknessUnit, type TimeUnit,
} from '@/services/workspace/engineering-calculators';
import { Icon } from './icon';

const SOLVE_FOR_LABEL: Record<DepositionSolveFor, string> = { thickness: 'Толщину покрытия', rate: 'Скорость осаждения', time: 'Время осаждения' };
const GAS_LABEL: Record<GasPreset, string> = { argon: 'Аргон (Ar)', nitrogen: 'Азот (N₂)', custom: 'Другой газ' };

function DepositionCalculator() {
  const [solveFor, setSolveFor] = useState<DepositionSolveFor>('time');
  const [thickness, setThickness] = useState('1000');
  const [thicknessUnit, setThicknessUnit] = useState<ThicknessUnit>('nm');
  const [rate, setRate] = useState('10');
  const [rateUnit, setRateUnit] = useState<RateUnit>('nm_per_min');
  const [time, setTime] = useState('100');
  const [timeUnit, setTimeUnit] = useState<TimeUnit>('min');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof solveDeposition> | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setResult(null);
    try {
      setResult(solveDeposition({
        solveFor,
        thickness: thickness.trim() ? Number(thickness) : undefined, thicknessUnit,
        rate: rate.trim() ? Number(rate) : undefined, rateUnit,
        time: time.trim() ? Number(time) : undefined, timeUnit,
      }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить расчёт.'); }
  }

  return <div className="content-grid">
    <section className="content-card">
      <h2>Толщина, скорость и время осаждения</h2>
      <p className="muted small">d = v × t. Введите два известных значения - третье будет рассчитано.</p>
      <form onSubmit={submit} className="flex flex-col gap-4 mt-5">
        <label className="text-sm">Что рассчитать
          <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-2" value={solveFor} onChange={e => setSolveFor(e.target.value as DepositionSolveFor)}>
            {(['time', 'thickness', 'rate'] as const).map(v => <option key={v} value={v}>{SOLVE_FOR_LABEL[v]}</option>)}
          </select>
        </label>
        {solveFor !== 'thickness' && <label className="text-sm">Толщина покрытия
          <div className="flex gap-2 mt-2">
            <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3" value={thickness} onChange={e => setThickness(e.target.value)} />
            <select className="rounded-md border border-[#dce0e5] p-3" value={thicknessUnit} onChange={e => setThicknessUnit(e.target.value as ThicknessUnit)}><option value="nm">нм</option><option value="um">мкм</option></select>
          </div>
        </label>}
        {solveFor !== 'rate' && <label className="text-sm">Скорость осаждения
          <div className="flex gap-2 mt-2">
            <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3" value={rate} onChange={e => setRate(e.target.value)} />
            <select className="rounded-md border border-[#dce0e5] p-3" value={rateUnit} onChange={e => setRateUnit(e.target.value as RateUnit)}><option value="nm_per_min">нм/мин</option><option value="nm_per_s">нм/с</option><option value="um_per_h">мкм/ч</option></select>
          </div>
        </label>}
        {solveFor !== 'time' && <label className="text-sm">Время осаждения
          <div className="flex gap-2 mt-2">
            <input type="number" step="any" className="w-full rounded-md border border-[#dce0e5] p-3" value={time} onChange={e => setTime(e.target.value)} />
            <select className="rounded-md border border-[#dce0e5] p-3" value={timeUnit} onChange={e => setTimeUnit(e.target.value as TimeUnit)}><option value="s">с</option><option value="min">мин</option><option value="h">ч</option></select>
          </div>
        </label>}
        <button className="button primary self-start">Рассчитать <Icon name="sparkles" size={17} /></button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
    <section className="content-card" aria-live="polite">
      <h2>Результат</h2>
      {result ? <div className="demo-result">
        <h3>{SOLVE_FOR_LABEL[result.solveFor]}: {result.value.toPrecision(6)} {depositionUnitLabel(result.unit)}</h3>
        <p className="muted small">{result.formula}</p>
      </div> : <p className="mt-5">Заполните два значения и нажмите «Рассчитать».</p>}
    </section>
  </div>;
}

function MeanFreePathCalculator() {
  const [pressure, setPressure] = useState('1');
  const [pressureUnit, setPressureUnit] = useState<PressureUnit>('pa');
  const [temperatureC, setTemperatureC] = useState('20');
  const [gas, setGas] = useState<GasPreset>('argon');
  const [customDiameterPm, setCustomDiameterPm] = useState('350');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof calculateMeanFreePath> | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(''); setResult(null);
    try {
      setResult(calculateMeanFreePath({
        pressure: Number(pressure), pressureUnit,
        temperatureC: Number(temperatureC), gas,
        customDiameterPm: gas === 'custom' ? Number(customDiameterPm) : undefined,
      }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить расчёт.'); }
  }

  return <div className="content-grid">
    <section className="content-card">
      <h2>Средняя длина свободного пробега в вакууме</h2>
      <p className="muted small">λ = kT / (√2·π·d²·p) - кинетическая теория газов.</p>
      <form onSubmit={submit} className="flex flex-col gap-4 mt-5">
        <label className="text-sm">Давление
          <div className="flex gap-2 mt-2">
            <input type="number" step="any" required className="w-full rounded-md border border-[#dce0e5] p-3" value={pressure} onChange={e => setPressure(e.target.value)} />
            <select className="rounded-md border border-[#dce0e5] p-3" value={pressureUnit} onChange={e => setPressureUnit(e.target.value as PressureUnit)}><option value="pa">Па</option><option value="mbar">мбар</option><option value="torr">Торр</option></select>
          </div>
        </label>
        <label className="text-sm">Температура, °C
          <input type="number" step="any" required className="w-full rounded-md border border-[#dce0e5] p-3 mt-2" value={temperatureC} onChange={e => setTemperatureC(e.target.value)} />
        </label>
        <label className="text-sm">Газ
          <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-2" value={gas} onChange={e => setGas(e.target.value as GasPreset)}>
            {(['argon', 'nitrogen', 'custom'] as const).map(g => <option key={g} value={g}>{GAS_LABEL[g]}</option>)}
          </select>
        </label>
        {gas === 'custom' && <label className="text-sm">Диаметр молекулы, пм
          <input type="number" step="any" required className="w-full rounded-md border border-[#dce0e5] p-3 mt-2" value={customDiameterPm} onChange={e => setCustomDiameterPm(e.target.value)} />
        </label>}
        <button className="button primary self-start">Рассчитать <Icon name="sparkles" size={17} /></button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
    <section className="content-card" aria-live="polite">
      <h2>Результат</h2>
      {result ? <div className="demo-result">
        <h3>λ ≈ {result.meanFreePathMm.toPrecision(4)} мм ({result.meanFreePathM.toExponential(3)} м)</h3>
        <p className="muted small">{result.formula}</p>
      </div> : <p className="mt-5">Заполните параметры и нажмите «Рассчитать».</p>}
    </section>
  </div>;
}

export function EngineeringCalculators() {
  const [tab, setTab] = useState<'deposition' | 'mean-free-path'>('deposition');
  return <div>
    <p className="muted small mb-4">
      Реальные инженерные расчёты. Все значения вычисляются локально по стандартным формулам вакуумно-плазменных технологий -
      запрос никуда не отправляется.
    </p>
    <div className="flex gap-3 mb-6">
      <button type="button" className={`button ${tab === 'deposition' ? 'primary' : 'secondary'}`} aria-pressed={tab === 'deposition'} onClick={() => setTab('deposition')}>Осаждение (толщина/скорость/время)</button>
      <button type="button" className={`button ${tab === 'mean-free-path' ? 'primary' : 'secondary'}`} aria-pressed={tab === 'mean-free-path'} onClick={() => setTab('mean-free-path')}>Длина свободного пробега</button>
    </div>
    {tab === 'deposition' ? <DepositionCalculator /> : <MeanFreePathCalculator />}
  </div>;
}
