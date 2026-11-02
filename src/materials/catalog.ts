/** Validation of a CATALOG - identities plus variants: unique ids, every reference resolves in the right ROLE, the kind of each variant matches its identity, and no
 *  reference cycles (a composite that contains itself, a film on its own substrate...). Duplicate content under different ids is reported, never merged.
 *
 *  A validator never throws on corrupted DATA: every access to a record goes through a structural check first, and the answer is always a ValidationReport. */

import { deepFreeze } from '@/physics';
import { checkKeys } from './checks';
import { Collector, isRecord, MaterialsError, type ValidationReport } from './errors';
import { contentFingerprint } from './ids';
import { MAX_STACK_DEPTH } from './stack';
import { collectIdentity, collectVariant } from './variant';
import type { MaterialCatalog, MaterialKind } from './types';

/** The role a reference plays - kept, never guessed from the id: the same variant may be the substrate AND a layer material of one system, and the two are different
 *  things (a coating system may stand on a coated substrate, but may not be a layer of itself or of another system). */
export type ReferenceRole = 'constituent' | 'stack_substrate' | 'form_substrate' | 'layer_material' | 'gradient_from' | 'gradient_to';

export interface VariantReference { readonly id: string; readonly role: ReferenceRole; readonly path: string }

const MAX_WALKED_NODES = 100000;

/** The variants a record refers to, with the role and the place of every reference. Safe on any input: a malformed part simply contributes no references (it is
 *  reported by the structural validators). Order is deterministic. */
export function variantReferences(variant: unknown): readonly VariantReference[] {
  const out: VariantReference[] = [];
  if (!isRecord(variant)) return out;
  const push = (id: unknown, role: ReferenceRole, path: string): void => { if (typeof id === 'string') out.push({ id, role, path }); };
  const composition = variant.composition;
  if (isRecord(composition)) {
    if (composition.type === 'composite' && Array.isArray(composition.constituents)) composition.constituents.forEach((x, i) => { if (isRecord(x)) push(x.material, 'constituent', `composition.constituents[${i}].material`); });
    if (composition.type === 'coating_system' && isRecord(composition.stack)) {
      push(composition.stack.substrate, 'stack_substrate', 'composition.stack.substrate');
      let visited = 0;
      const walk = (elements: unknown, path: string, depth: number): void => {
        if (!Array.isArray(elements) || depth > MAX_STACK_DEPTH + 1) return;
        elements.forEach((element, i) => {
          visited += 1;
          if (visited > MAX_WALKED_NODES || !isRecord(element)) return;
          const p = `${path}[${i}]`;
          if (element.type === 'layer' && isRecord(element.layer)) {
            const layer = element.layer;
            if (layer.kind === 'uniform') push(layer.material, 'layer_material', `${p}.layer.material`);
            else if (layer.kind === 'gradient') { push(layer.from, 'gradient_from', `${p}.layer.from`); push(layer.to, 'gradient_to', `${p}.layer.to`); }
          } else if (element.type === 'period') walk(element.elements, `${p}.elements`, depth + 1);
        });
      };
      walk(composition.stack.elements, 'composition.stack.elements', 1);
    }
  }
  if (isRecord(variant.form)) push(variant.form.substrate, 'form_substrate', 'form.substrate');
  return out;
}

/** The ids only (with repetitions, in order). */
export const referencedVariantIds = (variant: unknown): readonly string[] => variantReferences(variant).map(r => r.id);

const LAYER_POSITION_ROLES: readonly ReferenceRole[] = ['layer_material', 'gradient_from', 'gradient_to'];

const compositionTypeOf = (variant: unknown): string | undefined => (isRecord(variant) && isRecord(variant.composition) && typeof variant.composition.type === 'string' ? variant.composition.type : undefined);

export function validateCatalog(catalog: unknown): ValidationReport {
  const c = new Collector();
  if (!isRecord(catalog) || !Array.isArray(catalog.identities) || !Array.isArray(catalog.variants)) {
    c.error('invalid_material', 'catalog', 'catalog: ожидался объект { identities, variants }.');
    return c.report();
  }
  checkKeys(catalog, ['identities', 'variants'], 'catalog', c, 'invalid_material');
  const identityKinds = new Map<string, MaterialKind>();
  catalog.identities.forEach((identity, i) => {
    const kind = collectIdentity(identity, `identities[${i}]`, c);
    const id = isRecord(identity) ? identity.id : undefined;
    if (typeof id === 'string') {
      if (identityKinds.has(id)) c.error('duplicate_id', `identities[${i}].id`, `identities[${i}].id: идентичность «${id}» уже есть в каталоге.`);
      else if (kind) identityKinds.set(id, kind);
    }
  });
  const variants = new Map<string, Record<string, unknown>>();
  const fingerprints = new Map<string, string>();
  catalog.variants.forEach((variant, i) => {
    const p = `variants[${i}]`;
    const identityId = isRecord(variant) ? variant.identity : undefined;
    const kind = typeof identityId === 'string' ? identityKinds.get(identityId) ?? null : null;
    collectVariant(variant, kind, p, c);
    if (!isRecord(variant) || typeof variant.id !== 'string') return;
    if (typeof identityId === 'string' && !identityKinds.has(identityId)) c.error('missing_reference', `${p}.identity`, `${p}.identity: идентичность «${identityId}» не найдена в каталоге.`);
    if (variants.has(variant.id)) { c.error('duplicate_id', `${p}.id`, `${p}.id: вариант «${variant.id}» уже есть в каталоге.`); return; }
    variants.set(variant.id, variant);
    try {
      const { id: _id, ...content } = variant;
      void _id;
      const fp = contentFingerprint(content);
      const earlier = fingerprints.get(fp);
      if (earlier) c.warning('duplicate_id', p, `${p}: содержимое совпадает с вариантом «${earlier}» — вероятный дубликат под другим идентификатором (записи не объединяются).`);
      else fingerprints.set(fp, variant.id);
    } catch { /* a record that cannot be canonicalised already has an error */ }
  });

  // references: every one must resolve, and must be allowed in its ROLE
  const graph = new Map<string, readonly string[]>();
  for (const [id, variant] of variants) {
    const refs = variantReferences(variant);
    graph.set(id, refs.map(r => r.id));
    for (const ref of refs) {
      const target = variants.get(ref.id);
      if (!target) { c.error('missing_reference', `${id}.${ref.path}`, `${id}.${ref.path}: ссылка на несуществующий вариант «${ref.id}».`); continue; }
      // a layer (or an end of a graded layer) is a material, not a coating system: nested systems are flattened into one stack. A coating system as a SUBSTRATE is fine.
      if (LAYER_POSITION_ROLES.includes(ref.role) && compositionTypeOf(target) === 'coating_system') {
        c.error('nested_coating_system', `${id}.${ref.path}`, `${id}.${ref.path}: слой ссылается на систему покрытий «${ref.id}» (роль ${ref.role}); вложенные системы раскрываются в один стек.`);
      }
    }
  }
  // cycles over ALL reference roles: iterative depth-first search, colours 0 = new, 1 = on the current path, 2 = done
  const colour = new Map<string, 0 | 1 | 2>();
  for (const start of [...graph.keys()].sort()) {
    if (colour.get(start)) continue;
    const path: string[] = [];
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    colour.set(start, 1); path.push(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const refs = (graph.get(top.id) ?? []).filter(r => graph.has(r));
      if (top.next >= refs.length) { colour.set(top.id, 2); stack.pop(); path.pop(); continue; }
      const ref = refs[top.next]; top.next += 1;
      if (colour.get(ref) === 1) { c.error('reference_cycle', top.id, `Циклическая ссылка: ${[...path.slice(path.indexOf(ref)), ref].join(' → ')}.`); continue; }
      if (!colour.get(ref)) { colour.set(ref, 1); path.push(ref); stack.push({ id: ref, next: 0 }); }
    }
  }
  return c.report();
}

/** A validated, deep-frozen copy of a catalog. Throws MaterialsError with all the issues if there is any error. */
export function createCatalog(input: MaterialCatalog): MaterialCatalog {
  const report = validateCatalog(input);
  const errors = report.issues.filter(i => i.severity === 'error');
  if (errors.length > 0) throw new MaterialsError('invalid_material', `Каталог материалов некорректен: ${errors.length} ошибок. Первая — ${errors[0].path}: ${errors[0].message}`, report.issues);
  return deepFreeze(structuredClone(input));
}
