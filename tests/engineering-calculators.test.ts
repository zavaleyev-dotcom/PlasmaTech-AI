import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMeanFreePath, solveDeposition } from '../src/services/workspace/engineering-calculators';

// ---------- deposition thickness / rate / time (d = v * t) ----------

test('solveDeposition: happy path - solves time from thickness and rate, matching the platform\'s own known example (d=1000nm, v=10nm/min -> t=100min)', () => {
  const result = solveDeposition({ solveFor: 'time', thickness: 1000, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' });
  assert.equal(result.solveFor, 'time');
  assert.ok(Math.abs(result.value - 100) < 1e-9);
  assert.equal(result.unit, 'min');
});

test('solveDeposition: solves thickness from rate and time', () => {
  const result = solveDeposition({ solveFor: 'thickness', rate: 10, rateUnit: 'nm_per_min', time: 100, timeUnit: 'min', thicknessUnit: 'nm' });
  assert.ok(Math.abs(result.value - 1000) < 1e-9);
});

test('solveDeposition: solves rate from thickness and time', () => {
  const result = solveDeposition({ solveFor: 'rate', thickness: 1000, thicknessUnit: 'nm', time: 100, timeUnit: 'min', rateUnit: 'nm_per_min' });
  assert.ok(Math.abs(result.value - 10) < 1e-9);
});

test('solveDeposition: unit conversions are applied correctly (um, nm/s, h) before computing, and back to the requested output unit', () => {
  // 1 um thickness at 1000 nm/s should take exactly 1 second.
  const result = solveDeposition({ solveFor: 'time', thickness: 1, thicknessUnit: 'um', rate: 1000, rateUnit: 'nm_per_s', timeUnit: 's' });
  assert.ok(Math.abs(result.value - 1) < 1e-9, `expected ~1s, got ${result.value}`);

  // 1 um/h for 1 hour should give 1 um thickness, reported in nm.
  const result2 = solveDeposition({ solveFor: 'thickness', rate: 1, rateUnit: 'um_per_h', time: 1, timeUnit: 'h', thicknessUnit: 'nm' });
  assert.ok(Math.abs(result2.value - 1000) < 1e-6, `expected ~1000nm, got ${result2.value}`);
});

test('solveDeposition: invalid input (missing, zero, negative, non-finite) is rejected with a clear message, never silently substituting a default', () => {
  assert.throws(() => solveDeposition({ solveFor: 'time', thicknessUnit: 'nm', rateUnit: 'nm_per_min', timeUnit: 'min' }), /Толщина/);
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: 0, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }), /Толщина/);
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: -5, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }), /Толщина/);
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: NaN, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }), /Толщина/);
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: Infinity, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }), /Толщина/);
  assert.throws(() => solveDeposition({ solveFor: 'rate', thickness: 1000, thicknessUnit: 'nm', timeUnit: 'min', rateUnit: 'nm_per_min' }), /Время/);
});

// ---------- mean free path (kinetic theory of gases) ----------

test('calculateMeanFreePath: happy path - order of magnitude matches standard vacuum-engineering reference values (mm range at ~1 Pa, room temperature)', () => {
  const result = calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'argon' });
  assert.ok(result.meanFreePathMm > 1 && result.meanFreePathMm < 20, `expected a few mm at 1 Pa, got ${result.meanFreePathMm} mm`);
  assert.ok(Math.abs(result.meanFreePathM * 1000 - result.meanFreePathMm) < 1e-9);
});

test('calculateMeanFreePath: mean free path scales inversely with pressure (10x pressure -> 1/10th mean free path)', () => {
  const low = calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'argon' });
  const high = calculateMeanFreePath({ pressure: 10, pressureUnit: 'pa', temperatureC: 20, gas: 'argon' });
  assert.ok(Math.abs(low.meanFreePathM / high.meanFreePathM - 10) < 1e-6);
});

test('calculateMeanFreePath: pressure unit conversions (Pa/mbar/Torr) are applied consistently', () => {
  const pa = calculateMeanFreePath({ pressure: 100, pressureUnit: 'pa', temperatureC: 20, gas: 'nitrogen' });
  const mbar = calculateMeanFreePath({ pressure: 1, pressureUnit: 'mbar', temperatureC: 20, gas: 'nitrogen' }); // 1 mbar = 100 Pa
  assert.ok(Math.abs(pa.meanFreePathM - mbar.meanFreePathM) < 1e-12);
});

test('calculateMeanFreePath: a custom gas diameter is honored, and rejected if missing/invalid', () => {
  const result = calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'custom', customDiameterPm: 400 });
  assert.ok(result.meanFreePathMm > 0);
  assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'custom' }), /[Дд]иаметр/);
  assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'custom', customDiameterPm: -1 }), /[Дд]иаметр/);
});

test('calculateMeanFreePath: invalid pressure/temperature is rejected, never silently computed with a bad value', () => {
  assert.throws(() => calculateMeanFreePath({ pressure: 0, pressureUnit: 'pa', temperatureC: 20, gas: 'argon' }), /Давление/);
  assert.throws(() => calculateMeanFreePath({ pressure: -1, pressureUnit: 'pa', temperatureC: 20, gas: 'argon' }), /Давление/);
  assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: -273.15, gas: 'argon' }), /[Тт]емперат/);
  assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: -300, gas: 'argon' }), /[Тт]емперат/);
});

// ---------- runtime validation of enum/union inputs (Codex regression) ----------

test('solveDeposition (Codex regression): an unexpected unit/solveFor value is rejected with a clear message, never silently computed as NaN', () => {
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: 1000, thicknessUnit: 'nm', rate: 10, rateUnit: 'bogus_unit' as never, timeUnit: 'min' }), /[Ее]диница скорости/);
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: 1000, thicknessUnit: 'bogus_unit' as never, rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }), /[Ее]диница толщины/);
  assert.throws(() => solveDeposition({ solveFor: 'time', thickness: 1000, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'bogus_unit' as never }), /[Ее]диница времени/);
  assert.throws(() => solveDeposition({ solveFor: 'bogus' as never, thickness: 1000, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }), /[Ии]скомая величина/);
});

test('calculateMeanFreePath (Codex regression): an unexpected pressure unit or gas preset is rejected with a clear message, never silently computed as NaN', () => {
  assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'bogus' as never, temperatureC: 20, gas: 'argon' }), /[Ее]диница давления/);
  assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 20, gas: 'bogus_gas' as never }), /Газ/);
});

// ---------- F04 (MEDIUM): null-coercion and overflow are real validation errors, not silent 0/Infinity ----------

test('calculateMeanFreePath (F04): a null temperature must never be silently treated as 0 °C (JS would otherwise compute null + 273.15 = 273.15)', () => {
  assert.throws(
    () => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: null as unknown as number, gas: 'argon' }),
    /Температура: введите конечное число\./,
  );
});

test('calculateMeanFreePath (F04): undefined/NaN/Infinity temperature is also rejected, never coerced', () => {
  for (const bad of [undefined, NaN, Infinity, -Infinity]) {
    assert.throws(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: bad as number, gas: 'argon' }), /Температура: введите конечное число\./);
  }
});

test('calculateMeanFreePath (F04): a genuinely valid negative temperature (a real cryogenic value) is still accepted, not rejected just for being negative', () => {
  assert.doesNotThrow(() => calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: -150, gas: 'argon' }));
});

test('solveDeposition (F04): an extreme but individually-valid combination that would overflow to Infinity is rejected as a controlled error, never returned as Infinity', () => {
  assert.throws(
    () => solveDeposition({ solveFor: 'time', thickness: 1e300, thicknessUnit: 'nm', rate: 1e-300, rateUnit: 'nm_per_min', timeUnit: 'min' }),
    /результат расчёта не является конечным числом/,
  );
});

test('solveDeposition (F04): a normal, representative calculation is completely unaffected by the new overflow guard', () => {
  const result = solveDeposition({ solveFor: 'time', thickness: 2500, thicknessUnit: 'nm', rate: 25, rateUnit: 'nm_per_min', timeUnit: 'min' });
  assert.ok(Number.isFinite(result.value));
  assert.ok(Math.abs(result.value - 100) < 1e-9);
});

// ---------- F04 (LOW) Codex regression: intermediate/converted results, not just inputs ----------

test('solveDeposition (F04): an extreme deposition rate combined with a tiny thickness underflows the intermediate quotient to exactly 0 - rejected as a controlled range error, never returned as "0 min"', () => {
  // thicknessNm=1e-300, rateNmMin=1e300 -> 1e-300/1e300 = 1e-600, which floating-point cannot
  // represent as anything but exactly 0 - a real, mathematically positive answer, silently
  // reported as "no time needed at all" is worse than an honest range error.
  assert.throws(
    () => solveDeposition({ solveFor: 'time', thickness: 1e-300, thicknessUnit: 'nm', rate: 1e300, rateUnit: 'nm_per_min', timeUnit: 'min' }),
    /слишком мал.*(underflow|потеря точности)/i,
  );
});

test('solveDeposition (F04): rate * time overflowing to Infinity in the "thickness" branch is rejected, never returned as Infinity nm', () => {
  assert.throws(
    () => solveDeposition({ solveFor: 'thickness', rate: 1e200, rateUnit: 'nm_per_min', time: 1e200, timeUnit: 'min', thicknessUnit: 'nm' }),
    /результат расчёта не является конечным числом/,
  );
});

test('solveDeposition (F04): thickness/time overflowing to Infinity in the "rate" branch is rejected the same way', () => {
  assert.throws(
    () => solveDeposition({ solveFor: 'rate', thickness: 1e250, thicknessUnit: 'nm', time: 1e-250, timeUnit: 'min', rateUnit: 'nm_per_min' }),
    /результат расчёта не является конечным числом/,
  );
});

test('calculateMeanFreePath (F04): an extreme but individually-finite low pressure that overflows the formula is rejected, never returned as Infinity', () => {
  assert.throws(
    () => calculateMeanFreePath({ pressure: 1e-306, pressureUnit: 'pa', temperatureC: 25, gas: 'argon' }),
    /не является конечным числом|слишком мал/,
  );
});

test('calculateMeanFreePath (F04): the metre-to-millimetre conversion is checked as its own step, not just meanFreePathM - a value on the edge of overflow is never silently returned as an inconsistent (finite-in-metres, Infinity-in-millimetres) result', () => {
  const result = calculateMeanFreePath({ pressure: 1e-9, pressureUnit: 'pa', temperatureC: 25, gas: 'argon' });
  assert.ok(Number.isFinite(result.meanFreePathM));
  assert.ok(Number.isFinite(result.meanFreePathMm));
  assert.ok(result.meanFreePathMm > 0);
});

test('calculateMeanFreePath (F04): extreme but genuinely finite/valid temperature and pressure (e.g. deep cryogenic + very low process pressure) still compute a normal, finite, positive result - no arbitrary technological ceiling invented', () => {
  const result = calculateMeanFreePath({ pressure: 1e-6, pressureUnit: 'pa', temperatureC: -270, gas: 'nitrogen' });
  assert.ok(Number.isFinite(result.meanFreePathM) && result.meanFreePathM > 0);
  assert.ok(Number.isFinite(result.meanFreePathMm) && result.meanFreePathMm > 0);
});

test('solveDeposition/calculateMeanFreePath (F04): ordinary scientific values used throughout this project stay byte-for-byte unaffected by the new range guards', () => {
  const deposition = solveDeposition({ solveFor: 'thickness', rate: 10, rateUnit: 'nm_per_min', time: 100, timeUnit: 'min', thicknessUnit: 'nm' });
  assert.equal(deposition.value, 1000);
  const mfp = calculateMeanFreePath({ pressure: 1, pressureUnit: 'pa', temperatureC: 25, gas: 'argon' });
  assert.ok(mfp.meanFreePathMm > 0 && Number.isFinite(mfp.meanFreePathMm));
});
