/** Validation of the scientific provenance of a value: what kind of source, who wrote it, where the value stands in it, how it was obtained, and whether anyone
 *  actually compared the record with the primary source. Nothing is invented and nothing is promoted: a well-formed DOI proves a FORMAT, not that the publication
 *  exists, and "verified" is a statement made by a named person on a date - never inferred. */

import { normalizeDoi, safeUrl } from '@/services/scientific-search/normalization';
import { checkKeys, isIsoDate, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { IDENTIFIER_TYPES, SOURCE_TYPES, VALUE_STATUSES, VERIFICATION_STATUSES, type ValueStatus } from './property-types';

export const MIN_SOURCE_YEAR = 1500;
export const MAX_SOURCE_YEAR = 2100;

/** ISBN-10 / ISBN-13 check digit (hyphens and spaces ignored). Format only: an ISBN-13 must start with the ISBN prefix 978 or 979 (any other EAN-13 - a bare
 *  13-digit number, an ISSN-based 977... code - is not an ISBN even with a correct check digit); the existence of the book is never checked. */
export function isValidIsbn(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const s = value.replace(/[\s-]/g, '');
  if (/^\d{9}[\dXx]$/.test(s)) {
    const sum = [...s].reduce((acc, ch, i) => acc + (ch === 'X' || ch === 'x' ? 10 : Number(ch)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  if (/^97[89]\d{10}$/.test(s)) {
    const sum = [...s].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
}

const IDENTIFIER_RULES: Record<string, (value: string) => boolean> = {
  doi: v => normalizeDoi(v) !== null,
  isbn: isValidIsbn,
  url: v => safeUrl(v) !== null,
  standard_number: v => v.trim().length > 0,
  other: v => v.trim().length > 0,
};

function collectSource(source: unknown, status: ValueStatus | null, path: string, c: Collector): { identifiable: boolean; userData: boolean } {
  const result = { identifiable: false, userData: false };
  if (!isRecord(source)) { c.error('invalid_provenance', path, `${path}: ожидалось описание источника.`); return result; }
  checkKeys(source, ['type', 'authors', 'title', 'year', 'identifiers'], path, c, 'invalid_provenance');
  if (!(SOURCE_TYPES as readonly string[]).includes(source.type as string)) c.error('invalid_provenance', `${path}.type`, `${path}.type: тип источника — один из: ${SOURCE_TYPES.join(', ')}.`);
  result.userData = source.type === 'user_data';
  let hasAuthors = false;
  if (source.authors !== undefined) {
    if (!Array.isArray(source.authors) || source.authors.length === 0 || !source.authors.every(isNonEmptyString)) c.error('invalid_provenance', `${path}.authors`, `${path}.authors: ожидался непустой список непустых строк (авторы так, как указаны в источнике).`);
    else hasAuthors = true;
  }
  if (source.title !== undefined && !isNonEmptyString(source.title)) c.error('invalid_provenance', `${path}.title`, `${path}.title: ожидалась непустая строка.`);
  if (source.year !== undefined && (typeof source.year !== 'number' || !Number.isInteger(source.year) || source.year < MIN_SOURCE_YEAR || source.year > MAX_SOURCE_YEAR)) c.error('invalid_provenance', `${path}.year`, `${path}.year: год — целое число от ${MIN_SOURCE_YEAR} до ${MAX_SOURCE_YEAR}.`);
  let identifiers = 0;
  if (source.identifiers !== undefined) {
    if (!Array.isArray(source.identifiers) || source.identifiers.length === 0) c.error('invalid_identifier', `${path}.identifiers`, `${path}.identifiers: ожидался непустой список идентификаторов.`);
    else {
      const seen = new Set<string>();
      source.identifiers.forEach((id, i) => {
        const p = `${path}.identifiers[${i}]`;
        if (!isRecord(id)) { c.error('invalid_identifier', p, `${p}: ожидался объект { type, value }.`); return; }
        checkKeys(id, ['type', 'value'], p, c, 'invalid_identifier');
        if (!(IDENTIFIER_TYPES as readonly string[]).includes(id.type as string) || typeof id.value !== 'string') { c.error('invalid_identifier', p, `${p}: type — один из ${IDENTIFIER_TYPES.join(', ')}, value — строка.`); return; }
        if (!IDENTIFIER_RULES[id.type as string](id.value)) { c.error('invalid_identifier', `${p}.value`, `${p}.value: некорректный формат идентификатора типа «${String(id.type)}».`); return; }
        const key = `${String(id.type)}:${id.type === 'doi' ? normalizeDoi(id.value) : id.value.trim().toLowerCase()}`;
        if (seen.has(key)) { c.error('invalid_identifier', p, `${p}: идентификатор повторяется.`); return; }
        seen.add(key);
        identifiers += 1;
        if (id.type === 'doi' || id.type === 'isbn' || id.type === 'url') c.info('identifier_unchecked', p, `${p}: формат идентификатора корректен; существование публикации и совпадение с ней записи НЕ проверялись.`);
      });
    }
  }
  result.identifiable = identifiers > 0 || hasAuthors;
  const checked = status === 'measured' || status === 'evaluated';
  if (checked) {
    if (source.type === 'user_data') c.error('invalid_provenance', `${path}.type`, `${path}.type: источник «user_data» допустим только для значения со статусом user_input.`);
    if (source.title === undefined) c.error('invalid_provenance', `${path}.title`, `${path}.title: для значения со статусом «${status}» название источника обязательно.`);
    if (source.year === undefined) c.error('invalid_provenance', `${path}.year`, `${path}.year: для значения со статусом «${status}» год источника обязателен.`);
    if (!result.identifiable) c.error('source_unidentifiable', path, `${path}: источник нельзя найти — укажите авторов или проверяемый идентификатор (DOI, ISBN, номер стандарта, URL).`);
  }
  if (status === 'model_estimate' && !isNonEmptyString(source.title) && !(Array.isArray(source.identifiers) && source.identifiers.length > 0)) c.error('source_unidentifiable', path, `${path}: для оценки по модели укажите источник модели (название или идентификатор).`);
  if (status === 'user_input' && source.type !== 'user_data') c.error('invalid_provenance', `${path}.type`, `${path}.type: для значения со статусом user_input источник — «user_data».`);
  return result;
}

/** Validates a provenance record; returns the declared status when it is a valid one. */
export function collectProvenance(provenance: unknown, path: string, c: Collector): ValueStatus | null {
  if (!isRecord(provenance)) { c.error('invalid_provenance', path, `${path}: ожидалось описание происхождения значения.`); return null; }
  checkKeys(provenance, ['status', 'source', 'locator', 'method', 'verification'], path, c, 'invalid_provenance');
  const statusOk = (VALUE_STATUSES as readonly string[]).includes(provenance.status as string);
  if (!statusOk) c.error('invalid_provenance', `${path}.status`, `${path}.status: статус значения — один из: ${VALUE_STATUSES.join(', ')}.`);
  const status = statusOk ? provenance.status as ValueStatus : null;
  collectSource(provenance.source, status, `${path}.source`, c);

  if (provenance.locator !== undefined) {
    const p = `${path}.locator`;
    if (!isRecord(provenance.locator)) c.error('invalid_provenance', p, `${p}: ожидался объект.`);
    else {
      checkKeys(provenance.locator, ['page', 'table', 'figure', 'equation', 'section'], p, c, 'invalid_provenance');
      const entries = Object.entries(provenance.locator).filter(([k]) => ['page', 'table', 'figure', 'equation', 'section'].includes(k));
      if (entries.length === 0 && Object.keys(provenance.locator).length === 0) c.error('invalid_provenance', p, `${p}: пустое указание места — задайте страницу, таблицу, рисунок, уравнение или раздел.`);
      for (const [k, v] of entries) if (!isNonEmptyString(v)) c.error('invalid_provenance', `${p}.${k}`, `${p}.${k}: ожидалась непустая строка.`);
    }
  } else if (status === 'measured' || status === 'evaluated') c.warning('missing_locator', `${path}.locator`, `${path}.locator: не указаны страница, таблица, рисунок или уравнение — значение труднее проверить по первоисточнику.`);

  if (provenance.method !== undefined && !isNonEmptyString(provenance.method)) c.error('invalid_provenance', `${path}.method`, `${path}.method: ожидалась непустая строка.`);
  if (provenance.method === undefined) {
    if (status === 'measured' || status === 'model_estimate') c.error('missing_method', `${path}.method`, `${path}.method: для статуса «${status}» метод получения значения обязателен.`);
    else if (status === 'evaluated') c.info('missing_method', `${path}.method`, `${path}.method: метод оценки не указан.`);
  }

  // verification: a statement by a named person on a date - and the honest default is "unverified"
  const vPath = `${path}.verification`;
  const v = provenance.verification;
  if (!isRecord(v)) { c.error('invalid_provenance', vPath, `${vPath}: ожидался объект { status } (статус сверки с первоисточником задаётся явно).`); return status; }
  checkKeys(v, ['status', 'verifiedBy', 'verifiedAt', 'note'], vPath, c, 'invalid_provenance');
  if (!(VERIFICATION_STATUSES as readonly string[]).includes(v.status as string)) { c.error('invalid_provenance', `${vPath}.status`, `${vPath}.status: один из: ${VERIFICATION_STATUSES.join(', ')}.`); return status; }
  if (v.note !== undefined && !isNonEmptyString(v.note)) c.error('invalid_provenance', `${vPath}.note`, `${vPath}.note: ожидалась непустая строка.`);
  if (v.status === 'verified_against_source') {
    if (!isNonEmptyString(v.verifiedBy)) c.error('verification_inconsistent', `${vPath}.verifiedBy`, `${vPath}.verifiedBy: сверку выполняет названный человек — укажите, кто сверил.`);
    if (!isIsoDate(v.verifiedAt)) c.error('verification_inconsistent', `${vPath}.verifiedAt`, `${vPath}.verifiedAt: укажите дату сверки (ГГГГ-ММ-ДД).`);
    if (status === 'user_input') c.error('verification_inconsistent', vPath, `${vPath}: значение пользователя не имеет первоисточника для сверки (используйте not_applicable).`);
  } else {
    if (v.verifiedBy !== undefined || v.verifiedAt !== undefined) c.error('verification_inconsistent', vPath, `${vPath}: verifiedBy и verifiedAt допустимы только при статусе verified_against_source.`);
    if (v.status === 'not_applicable' && status !== 'user_input') c.error('verification_inconsistent', `${vPath}.status`, `${vPath}.status: «not_applicable» допустим только для значения со статусом user_input.`);
    if (v.status === 'unverified' && status === 'user_input') c.error('verification_inconsistent', `${vPath}.status`, `${vPath}.status: для значения пользователя сверка с первоисточником неприменима (not_applicable).`);
    if (v.status === 'unverified') c.info('unverified_value', vPath, `${vPath}: запись не сверена с первоисточником — значение нельзя считать научно подтверждённым.`);
  }
  return status;
}
