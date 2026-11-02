/** Validation of the FORM of a material (bulk, thin film, coating layer, sputtering target, powder, foil, substrate). The form and its context (deposition process,
 *  substrate) are part of what makes a variant; the INTENDED USE is only a label and never decides a property. */

import { checkKeys, checkQuantity, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { isMaterialId } from './ids';
import { INTENDED_USES, MATERIAL_FORM_KINDS, type AggregateState, type MaterialFormKind } from './types';

const THICKNESS_FORMS: readonly MaterialFormKind[] = ['thin_film', 'coating_layer', 'foil', 'sputtering_target', 'substrate'];
const FILM_FORMS: readonly MaterialFormKind[] = ['thin_film', 'coating_layer'];

export function validateForm(form: unknown, path: string, c: Collector): MaterialFormKind | null {
  if (!isRecord(form)) { c.error('invalid_form', path, `${path}: ожидался объект формы.`); return null; }
  checkKeys(form, ['kind', 'thickness', 'particleSize', 'deposition', 'substrate', 'intendedUse'], path, c, 'invalid_form');
  if (!(MATERIAL_FORM_KINDS as readonly string[]).includes(form.kind as string)) { c.error('invalid_form', `${path}.kind`, `${path}.kind: форма должна быть одной из: ${MATERIAL_FORM_KINDS.join(', ')}.`); return null; }
  const kind = form.kind as MaterialFormKind;
  if (form.thickness !== undefined) {
    if (!THICKNESS_FORMS.includes(kind)) c.error('form_field_not_allowed', `${path}.thickness`, `${path}.thickness: толщина не задаётся для формы «${kind}».`);
    checkQuantity(form.thickness, 'length', `${path}.thickness`, c, 'positive');
  }
  if (form.particleSize !== undefined) {
    if (kind !== 'powder') c.error('form_field_not_allowed', `${path}.particleSize`, `${path}.particleSize: размер частиц задаётся только для порошка.`);
    checkQuantity(form.particleSize, 'length', `${path}.particleSize`, c, 'positive');
  }
  if (form.deposition !== undefined) {
    const p = `${path}.deposition`;
    if (!FILM_FORMS.includes(kind)) c.error('form_field_not_allowed', p, `${p}: технология получения задаётся только для тонкой плёнки и слоя покрытия.`);
    if (!isRecord(form.deposition) || !isNonEmptyString(form.deposition.process)) c.error('invalid_form', p, `${p}: ожидался объект { process } с непустым названием процесса.`);
    else {
      checkKeys(form.deposition, ['process', 'notes'], p, c, 'invalid_form');
      if (form.deposition.notes !== undefined && !isNonEmptyString(form.deposition.notes)) c.error('invalid_form', `${p}.notes`, `${p}.notes: ожидалась непустая строка.`);
    }
  }
  if (form.substrate !== undefined) {
    if (!FILM_FORMS.includes(kind)) c.error('form_field_not_allowed', `${path}.substrate`, `${path}.substrate: подложка задаётся только для тонкой плёнки и слоя покрытия.`);
    if (!isMaterialId(form.substrate)) c.error('invalid_id', `${path}.substrate`, `${path}.substrate: некорректный идентификатор варианта подложки.`);
  }
  if (form.intendedUse !== undefined) {
    const p = `${path}.intendedUse`;
    const uses = form.intendedUse;
    if (!Array.isArray(uses) || uses.length === 0 || !uses.every(u => (INTENDED_USES as readonly string[]).includes(u as string))) c.error('invalid_form', p, `${p}: ожидался непустой список из: ${INTENDED_USES.join(', ')}.`);
    else if (new Set(uses).size !== uses.length) c.error('invalid_form', p, `${p}: значения не должны повторяться.`);
  }
  return kind;
}

export type StateFormVerdict = 'ok' | 'ambiguous' | 'incompatible';

/** Which forms an aggregate state can take - written out, not inferred.
 *  - solid: every form;
 *  - liquid: a volume of liquid (bulk) is fine; a liquid film, coating layer, target or substrate exists (liquid metals, wetting layers) but needs context - ambiguous; a
 *    powder or a foil is made of solid particles / a solid sheet - incompatible;
 *  - gas and plasma: only a volume (bulk); a gas or a plasma is not a film, a layer, a target, a substrate, a powder or a foil - incompatible. */
export const STATE_FORM_COMPATIBILITY: Readonly<Record<AggregateState, Readonly<Record<MaterialFormKind, StateFormVerdict>>>> = Object.freeze({
  solid: Object.freeze({ bulk: 'ok', thin_film: 'ok', coating_layer: 'ok', sputtering_target: 'ok', powder: 'ok', foil: 'ok', substrate: 'ok' }),
  liquid: Object.freeze({ bulk: 'ok', thin_film: 'ambiguous', coating_layer: 'ambiguous', sputtering_target: 'ambiguous', powder: 'incompatible', foil: 'incompatible', substrate: 'ambiguous' }),
  gas: Object.freeze({ bulk: 'ok', thin_film: 'incompatible', coating_layer: 'incompatible', sputtering_target: 'incompatible', powder: 'incompatible', foil: 'incompatible', substrate: 'incompatible' }),
  plasma: Object.freeze({ bulk: 'ok', thin_film: 'incompatible', coating_layer: 'incompatible', sputtering_target: 'incompatible', powder: 'incompatible', foil: 'incompatible', substrate: 'incompatible' }),
});

/** The joint check of the aggregate state of a phase and the form of the material. An ambiguous pair is a warning that asks for context, not an error. */
export function checkStateForm(state: AggregateState, form: MaterialFormKind, path: string, c: Collector): StateFormVerdict {
  const verdict = STATE_FORM_COMPATIBILITY[state][form];
  if (verdict === 'incompatible') c.error('state_form_mismatch', path, `${path}: форма «${form}» несовместима с агрегатным состоянием «${state}».`);
  else if (verdict === 'ambiguous') c.warning('state_form_ambiguous', path, `${path}: сочетание состояния «${state}» и формы «${form}» возможно (например, жидкий металл), но требует пояснения контекста.`);
  return verdict;
}
