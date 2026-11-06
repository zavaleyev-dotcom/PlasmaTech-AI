/** SYNTHETIC series fixtures. The numbers (1, 2, 3 ...) are placeholders to exercise the validators - NOT property values of any real material - and the sources are made up. */
import type { Observation, PointSeries } from '../src/materials';
import { syntheticProvenance } from './materials-property-fixtures';

export const BULK = 'fixture:synthetic-element-bulk';
export const FILM = 'fixture:synthetic-compound-film';

export const q = (value: number, unit: string) => ({ value, unit }) as never;

/** A synthetic observation of a thermal conductivity (W/(m K)) at a temperature in kelvin. */
export const obs = (id: string, kelvin: number, value: number, extra: Partial<Observation> = {}): Observation => ({
  id, temperature: q(kelvin, 'K'), value: { type: 'scalar', value, unit: 'W_mK' }, uncertainty: { kind: 'unknown' }, ...extra,
});

export const bulkSeries = (over: Partial<PointSeries> = {}): PointSeries => ({
  id: 'fixture:series-k-bulk', kind: 'points', variant: BULK, property: 'thermal_conductivity', commonConditions: {}, uncertaintyScope: 'per_observation',
  applicability: { events: [], stability: { kind: 'not_stated' } }, version: 1, updatedAt: '2000-01-01', provenance: syntheticProvenance(),
  points: [obs('p1', 300, 1), obs('p2', 400, 2)], correlation: { kind: 'unknown' }, ...over,
});

/** A film series: the film conditions (thickness, direction) and the film information (history, sweep) are given, so a valid film series has no warnings about them. */
export const filmSeries = (over: Partial<PointSeries> = {}): PointSeries => ({
  ...bulkSeries({ id: 'fixture:series-k-film', variant: FILM }),
  commonConditions: { thickness: q(100, 'nm'), direction: 'in_plane' } as never,
  applicability: { events: [], stability: { kind: 'stated_stable_over_range', source: { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК' } }, thermalHistory: { state: 'as_deposited', cycles: 0 }, sweepDirection: 'heating' },
  ...over,
});

/** A coefficient-of-linear-expansion series (ppm per kelvin). */
export const alphaSeries = (conditions: Record<string, unknown>, kelvin: number[] = [350, 400], over: Partial<PointSeries> = {}): PointSeries => ({
  ...bulkSeries({ id: 'fixture:series-alpha', property: 'linear_expansion_coefficient' }),
  commonConditions: conditions as never,
  points: kelvin.map((t, i) => ({ id: `p${i + 1}`, temperature: q(t, 'K'), value: { type: 'scalar' as const, value: 10 + i, unit: 'ppm_K' as const }, uncertainty: { kind: 'unknown' as const } })),
  ...over,
});
