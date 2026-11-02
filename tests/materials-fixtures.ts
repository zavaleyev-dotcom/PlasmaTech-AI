/** SYNTHETIC test fixtures for the materials package. Everything here is made up to exercise the validators: ids are in the `fixture:` namespace, names say
 *  "СИНТЕТИЧЕСКИЙ", compositions and thicknesses are arbitrary and are NOT reference data about any real material. They contain no physical property values. */
import type { MaterialCatalog, MaterialIdentity, MaterialVariant } from '../src/materials';

const q = (value: number, unit: string) => ({ value, unit }) as never;

export const identity = (id: string, kind: MaterialIdentity['kind'], nameRu = `СИНТЕТИЧЕСКИЙ материал ${id}`): MaterialIdentity => ({ id: `fixture:${id}`, kind, nameRu });

export const solidCrystal = (): NonNullable<MaterialVariant['phase']> => ({ state: 'solid', order: 'crystalline', crystalStructure: { latticeSystem: 'cubic' } });
export const bulk = (): MaterialVariant['form'] => ({ kind: 'bulk' });

export const syntheticElement = (): MaterialVariant => ({
  id: 'fixture:synthetic-element-bulk', identity: 'fixture:synthetic-element', composition: { type: 'element', symbol: 'Ti' }, phase: solidCrystal(), form: bulk(),
});
export const syntheticAlloy = (): MaterialVariant => ({
  id: 'fixture:synthetic-alloy-bulk', identity: 'fixture:synthetic-alloy',
  composition: { type: 'alloy', basis: 'atomic', constituents: [{ symbol: 'Fe', fraction: { value: 0.7 } }, { symbol: 'Ni', fraction: { value: 0.2 } }, { symbol: 'Cr', fraction: { value: 0.1 } }] },
  phase: solidCrystal(), form: bulk(),
});
export const syntheticCompound = (): MaterialVariant => ({
  id: 'fixture:synthetic-compound-film', identity: 'fixture:synthetic-compound',
  composition: { type: 'stoichiometric', stoichiometry: 'stoichiometric', species: [{ symbol: 'Ti', count: 1 }, { symbol: 'N', count: 1 }] },
  phase: solidCrystal(), form: { kind: 'thin_film', thickness: q(100, 'nm'), deposition: { process: 'СИНТЕТИЧЕСКИЙ процесс' } },
});
export const syntheticTarget = (): MaterialVariant => ({ ...syntheticCompound(), id: 'fixture:synthetic-compound-target', form: { kind: 'sputtering_target', thickness: q(6, 'mm'), intendedUse: ['sputtering_target'] } });

/** A multilayer system: adhesion layer, then 5 repetitions of a two-layer package, then a cap, on a synthetic substrate. */
export const syntheticSystemCatalog = (): MaterialCatalog => ({
  identities: [identity('synthetic-element', 'element'), identity('synthetic-compound', 'compound'), identity('synthetic-alloy', 'alloy'), identity('synthetic-substrate', 'element'), identity('synthetic-system', 'coating_system')],
  variants: [
    syntheticElement(), syntheticCompound(), syntheticAlloy(),
    { id: 'fixture:synthetic-substrate-bulk', identity: 'fixture:synthetic-substrate', composition: { type: 'element', symbol: 'Si' }, phase: { state: 'solid', order: 'unknown' }, form: { kind: 'substrate', thickness: q(500, 'um') } },
    {
      id: 'fixture:synthetic-system-film', identity: 'fixture:synthetic-system',
      composition: {
        type: 'coating_system',
        stack: {
          substrate: 'fixture:synthetic-substrate-bulk',
          elements: [
            { type: 'layer', layer: { kind: 'uniform', id: 'adhesion', role: 'adhesion', material: 'fixture:synthetic-element-bulk', thickness: q(20, 'nm') }, interfaceToNext: { kind: 'sharp' } },
            { type: 'period', repeat: 5, interfaceBetweenRepeats: { kind: 'diffuse', width: q(1, 'nm') }, elements: [
              { type: 'layer', layer: { kind: 'uniform', id: 'a', role: 'functional', material: 'fixture:synthetic-compound-film', thickness: q(10, 'nm') }, interfaceToNext: { kind: 'sharp', roughness: q(0.5, 'nm') } },
              { type: 'layer', layer: { kind: 'gradient', id: 'g', from: 'fixture:synthetic-compound-film', to: 'fixture:synthetic-element-bulk', profile: 'СИНТЕТИЧЕСКИЙ', thickness: q(5, 'nm') } },
            ] },
            { type: 'layer', layer: { kind: 'uniform', id: 'cap', role: 'capping', material: 'fixture:synthetic-alloy-bulk', thickness: q(30, 'nm') } },
          ],
        },
      },
      form: { kind: 'coating_layer', deposition: { process: 'СИНТЕТИЧЕСКИЙ процесс' } },
    },
  ],
});
