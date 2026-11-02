/** Validation of a material identity and of a material variant (identity + composition + phase + structure + form), the report of MISSING data, and the validated,
 *  frozen constructors. Nothing is defaulted: a field that was not given stays absent, and `describeMissingData` says so. */

import { deepFreeze } from '@/physics';
import { checkKeys, checkSource, isNonEmptyString } from './checks';
import { validateComposition } from './composition';
import { Collector, isRecord, MaterialsError, type ValidationIssue, type ValidationReport } from './errors';
import { checkStateForm, validateForm } from './form';
import { isMaterialId } from './ids';
import { validatePhase, validateStructure } from './phase';
import { flattenStack, validateStack } from './stack';
import { AGGREGATE_STATES, MATERIAL_KINDS, type AggregateState, type MaterialIdentity, type MaterialKind, type MaterialPhase, type MaterialVariant } from './types';

const KINDS_WITH_PHASE: readonly MaterialKind[] = ['element', 'compound', 'alloy', 'ceramic'];

export function collectIdentity(identity: unknown, path: string, c: Collector): MaterialKind | null {
  if (!isRecord(identity)) { c.error('invalid_name', path, `${path}: ожидался объект идентичности материала.`); return null; }
  checkKeys(identity, ['id', 'kind', 'nameRu', 'nameEn', 'synonyms', 'designations'], path, c, 'invalid_material');
  if (!isMaterialId(identity.id)) c.error('invalid_id', `${path}.id`, `${path}.id: идентификатор должен иметь вид <ref|user|fixture>:<слаг>, слаг — строчные латинские буквы, цифры, «-», «_», «.».`);
  const kindOk = (MATERIAL_KINDS as readonly string[]).includes(identity.kind as string);
  if (!kindOk) c.error('invalid_kind', `${path}.kind`, `${path}.kind: вид материала должен быть одним из: ${MATERIAL_KINDS.join(', ')}.`);
  if (!isNonEmptyString(identity.nameRu)) c.error('invalid_name', `${path}.nameRu`, `${path}.nameRu: русское название обязательно.`);
  if (identity.nameEn !== undefined && !isNonEmptyString(identity.nameEn)) c.error('invalid_name', `${path}.nameEn`, `${path}.nameEn: ожидалась непустая строка.`);
  if (identity.synonyms !== undefined) {
    const s = identity.synonyms;
    if (!Array.isArray(s) || !s.every(isNonEmptyString)) c.error('invalid_name', `${path}.synonyms`, `${path}.synonyms: ожидался список непустых строк.`);
    else if (new Set(s.map(x => x.trim().toLowerCase())).size !== s.length) c.error('invalid_name', `${path}.synonyms`, `${path}.synonyms: синонимы не должны повторяться.`);
  }
  if (identity.designations !== undefined) {
    if (!Array.isArray(identity.designations)) c.error('invalid_designation', `${path}.designations`, `${path}.designations: ожидался список.`);
    else identity.designations.forEach((d, i) => {
      const p = `${path}.designations[${i}]`;
      if (!isRecord(d)) { c.error('invalid_designation', p, `${p}: ожидался объект { system, value, source }.`); return; }
      checkKeys(d, ['system', 'value', 'source'], p, c, 'invalid_material');
      if (!isNonEmptyString(d.system) || !isNonEmptyString(d.value)) c.error('invalid_designation', p, `${p}: system и value — непустые строки.`);
      if (d.source === undefined) c.error('designation_unsourced', `${p}.source`, `${p}: обозначение (${String(d.system)}) без подтверждающего источника не принимается.`);
      else checkSource(d.source, `${p}.source`, c);
    });
  }
  return kindOk ? (identity.kind as MaterialKind) : null;
}

/** `kind` is the kind of the identity this variant belongs to (when known); without it only the shape of the variant is checked. */
export function collectVariant(variant: unknown, kind: MaterialKind | null, path: string, c: Collector): void {
  if (!isRecord(variant)) { c.error('invalid_material', path, `${path}: ожидался объект варианта материала.`); return; }
  checkKeys(variant, ['id', 'identity', 'composition', 'phase', 'structure', 'form'], path, c, 'invalid_material');
  if (!isMaterialId(variant.id)) c.error('invalid_id', `${path}.id`, `${path}.id: некорректный идентификатор варианта.`);
  if (!isMaterialId(variant.identity)) c.error('invalid_id', `${path}.identity`, `${path}.identity: некорректный идентификатор идентичности материала.`);
  const compositionKind = kind ?? inferKind(variant.composition);
  if (compositionKind) validateComposition(compositionKind, variant.composition, `${path}.composition`, c);
  else c.error('invalid_composition', `${path}.composition`, `${path}.composition: тип состава не распознан.`);
  const isCoating = isRecord(variant.composition) && variant.composition.type === 'coating_system';
  if (isCoating) validateStack(isRecord(variant.composition) ? variant.composition.stack : undefined, `${path}.composition.stack`, c);

  const phaseRequired = compositionKind ? KINDS_WITH_PHASE.includes(compositionKind) : variant.phase !== undefined;
  if (variant.phase !== undefined) {
    if (compositionKind && !phaseRequired) c.error('phase_not_applicable', `${path}.phase`, `${path}.phase: у композита и системы покрытий общей фазы нет — фазы заданы у их компонент (вариантов).`);
    else validatePhase(variant.phase, `${path}.phase`, c);
  } else if (phaseRequired && compositionKind) c.error('phase_required', `${path}.phase`, `${path}.phase: для материала вида «${compositionKind}» фаза обязательна (кристаллический порядок можно задать как unknown).`);
  if (variant.structure !== undefined) {
    if (compositionKind === 'coating_system') c.error('structure_not_applicable', `${path}.structure`, `${path}.structure: у системы покрытий микроструктура задаётся у её слоёв (вариантов).`);
    else validateStructure(variant.structure, isRecord(variant.phase) ? variant.phase as unknown as MaterialPhase : undefined, `${path}.structure`, c);
  }
  const formKind = validateForm(variant.form, `${path}.form`, c);
  if (formKind && compositionKind === 'coating_system' && formKind !== 'coating_layer' && formKind !== 'thin_film') c.error('form_kind_mismatch', `${path}.form.kind`, `${path}.form.kind: система покрытий — это thin_film или coating_layer (не «${formKind}»).`);
  // aggregate state and form must fit together (a gas is not a powder)
  if (formKind && isRecord(variant.phase) && (AGGREGATE_STATES as readonly string[]).includes(variant.phase.state as string)) checkStateForm(variant.phase.state as AggregateState, formKind, `${path}.form.kind`, c);
  if (compositionKind === 'coating_system' && isRecord(variant.form) && isRecord(variant.composition)) {
    // ONE source of geometry: the stack. A separate thickness of the whole system would be a second, possibly contradictory value (a measured thickness of its own
    // needs its own semantics and provenance - a later stage), and the same holds for the substrate.
    if (variant.form.thickness !== undefined) c.error('form_field_not_allowed', `${path}.form.thickness`, `${path}.form.thickness: толщина системы покрытий выводится только из стека (totalThickness); отдельное значение допускало бы противоречие с суммой слоёв.`);
    const stack = variant.composition.stack;
    if (isRecord(stack) && typeof stack.substrate === 'string' && typeof variant.form.substrate === 'string' && stack.substrate !== variant.form.substrate) {
      c.error('substrate_conflict', `${path}.form.substrate`, `${path}.form.substrate («${variant.form.substrate}») не совпадает с подложкой стека («${stack.substrate}»): подложка должна быть одна.`);
    }
  }
}

function inferKind(composition: unknown): MaterialKind | null {
  if (!isRecord(composition)) return null;
  switch (composition.type) {
    case 'element': return 'element';
    case 'alloy': return 'alloy';
    case 'composite': return 'composite';
    case 'coating_system': return 'coating_system';
    case 'stoichiometric': return 'compound';
    default: return null;
  }
}

export function validateIdentity(identity: unknown): ValidationReport {
  const c = new Collector();
  collectIdentity(identity, 'identity', c);
  return c.report();
}

/** Validates a variant. Pass the kind of its identity to also check the kind <-> composition match; without it, the kind is taken from the composition type. */
export function validateVariant(variant: unknown, kind?: MaterialKind): ValidationReport {
  const c = new Collector();
  collectVariant(variant, kind ?? null, 'variant', c);
  return c.report();
}

export interface MissingDatum { readonly path: string; readonly what: string }

/** What a variant does NOT say - listed, never filled in. Absence is not an answer (for instance, a missing crystal structure of a crystalline phase). */
export function describeMissingData(variant: MaterialVariant): readonly MissingDatum[] {
  const out: MissingDatum[] = [];
  const add = (path: string, what: string): void => { out.push({ path, what }); };
  const { phase, structure, form, composition } = variant;
  if (phase) {
    if (phase.order === 'unknown') add('phase.order', 'кристаллический порядок не известен');
    if ((phase.order === 'crystalline' || phase.order === 'partially_crystalline') && !phase.crystalStructure) add('phase.crystalStructure', 'кристаллическая структура не указана');
    if (phase.order !== 'unknown' && phase.order !== 'not_applicable' && !phase.source) add('phase.source', 'утверждение о порядке не подтверждено источником');
    if (phase.state === 'solid') {
      if (!structure) add('structure', 'микроструктура не описана');
      else {
        if (!structure.porosity) add('structure.porosity', 'пористость не указана');
        if (!structure.grainSize && (phase.order === 'crystalline' || phase.order === 'partially_crystalline' || phase.order === 'unknown')) add('structure.grainSize', 'размер зерна не указан');
      }
    }
  }
  if ((form.kind === 'thin_film' || form.kind === 'coating_layer')) {
    if (!form.thickness && composition.type !== 'coating_system') add('form.thickness', 'толщина плёнки не указана');
    if (!form.deposition) add('form.deposition', 'технология получения не указана');
    if (!form.substrate && composition.type !== 'coating_system') add('form.substrate', 'подложка не указана');   // a coating system has ONE substrate datum, reported below
  }
  if (form.kind === 'powder' && !form.particleSize) add('form.particleSize', 'размер частиц не указан');
  if (composition.type === 'coating_system') {
    for (const { layer, position } of flattenStack(composition.stack)) if (!layer.thickness) add(`composition.stack[layer ${layer.id} @${position}].thickness`, `толщина слоя «${layer.id}» не указана`);
    if (!composition.stack.substrate && !form.substrate) add('composition.stack.substrate', 'подложка стека не указана');
  }
  return Object.freeze(out.map(d => Object.freeze(d)));
}

function failOnErrors(what: string, issues: readonly ValidationIssue[]): void {
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length > 0) throw new MaterialsError('invalid_material', `${what}: ${errors.length} ошибок. Первая — ${errors[0].path}: ${errors[0].message}`, issues);
}

/** A validated, deep-frozen copy of an identity. Throws MaterialsError with ALL the issues if the record is invalid. */
export function createIdentity(input: MaterialIdentity): MaterialIdentity {
  const report = validateIdentity(input);
  failOnErrors('Идентичность материала некорректна', report.issues);
  return deepFreeze(structuredClone(input));
}

/** A validated, deep-frozen copy of a variant (see validateVariant). */
export function createVariant(input: MaterialVariant, kind?: MaterialKind): MaterialVariant {
  const report = validateVariant(input, kind);
  failOnErrors('Вариант материала некорректен', report.issues);
  return deepFreeze(structuredClone(input));
}
