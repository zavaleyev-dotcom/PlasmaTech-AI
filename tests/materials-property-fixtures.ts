/** SYNTHETIC property fixtures. The numbers (1, 2, 3 ...) are placeholders chosen to exercise the validators - they are NOT property values of any real material, and
 *  the sources, authors and DOIs below are made up for tests (the DOI has a valid FORMAT and points at nothing). */
import type { PropertyRecord } from '../src/materials';

export const syntheticSource = () => ({
  type: 'journal_article' as const, authors: ['СИНТЕТИЧЕСКИЙ АВТОР'], title: 'СИНТЕТИЧЕСКАЯ СТАТЬЯ (не существует)', year: 2000,
  identifiers: [{ type: 'doi' as const, value: '10.0000/synthetic.fixture' }],
});

export const syntheticProvenance = () => ({
  status: 'measured' as const, source: syntheticSource(), locator: { table: 'Table S1' }, method: 'СИНТЕТИЧЕСКИЙ метод', verification: { status: 'unverified' as const },
});

const q = (value: number, unit: string) => ({ value, unit }) as never;

/** A synthetic density of a synthetic variant. */
export const densityRecord = (over: Partial<PropertyRecord> = {}): PropertyRecord => ({
  id: 'fixture:rec-density-1', variant: 'fixture:synthetic-element-bulk', property: 'density',
  value: { type: 'scalar', value: 1, unit: 'kg_m3' }, uncertainty: { kind: 'unknown' },
  conditions: { temperature: q(300, 'K') }, provenance: syntheticProvenance(), version: 1, updatedAt: '2000-01-01', ...over,
});

export const conductivityRecord = (over: Partial<PropertyRecord> = {}): PropertyRecord => ({
  id: 'fixture:rec-k-1', variant: 'fixture:synthetic-element-bulk', property: 'thermal_conductivity',
  value: { type: 'scalar', value: 2, unit: 'W_mK' }, uncertainty: { kind: 'standard', u: 0.5, origin: 'stated_in_source' },
  conditions: { temperature: q(300, 'K') }, provenance: syntheticProvenance(), version: 1, updatedAt: '2000-01-01', ...over,
});

// ---------- registry fixtures (M1.3.3): synthetic records over the synthetic catalog of materials-fixtures.ts ----------

const t = (value: number, unit: string) => ({ value, unit }) as never;
export const BULK = 'fixture:synthetic-element-bulk';
export const FILM = 'fixture:synthetic-compound-film';
export const TARGET = 'fixture:synthetic-compound-target';

/** A thermal conductivity of a variant at a temperature (synthetic numbers: arbitrary placeholders, not data). */
export function kRecord(id: string, variant: string, value: number, extra: Partial<PropertyRecord> = {}): PropertyRecord {
  const film = variant === FILM;
  return {
    id, variant, property: 'thermal_conductivity', value: { type: 'scalar', value, unit: 'W_mK' }, uncertainty: { kind: 'standard', u: 0.5, origin: 'stated_in_source' },
    conditions: film ? { temperature: t(300, 'K'), thickness: t(100, 'nm'), direction: 'in_plane' } as never : { temperature: t(300, 'K') } as never,
    provenance: { ...syntheticProvenance(), source: { ...syntheticSource(), identifiers: [{ type: 'doi', value: `10.0000/synthetic.${id.split(':')[1]}` }] } },
    version: 1, updatedAt: '2000-01-01', ...extra,
  };
}
