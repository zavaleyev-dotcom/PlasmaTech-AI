/** Stable, deterministic identifiers and content fingerprints. No clock, no randomness: the same input gives the same id and the same fingerprint on every
 *  machine and in every run.
 *
 *  An id is `<namespace>:<slug>`. The namespace keeps shipped reference data (`ref`), the user's own data (`user`) and test fixtures (`fixture`) apart. The slug is
 *  chosen by the author of the record; this module only VALIDATES it (and derives element ids from element symbols), it never invents one, and it never assigns an
 *  external designation (CAS, UNS, GOST...) - those exist only as sourced `designations` on an identity. */

import { isElementSymbol } from './elements';
import { MaterialsError } from './errors';

export const MATERIAL_NAMESPACES = Object.freeze(['ref', 'user', 'fixture'] as const);
export type MaterialNamespace = typeof MATERIAL_NAMESPACES[number];

const SLUG = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const MAX_ID_LENGTH = 96;

export interface ParsedMaterialId { readonly namespace: MaterialNamespace; readonly slug: string }

export function parseMaterialId(id: unknown): ParsedMaterialId | null {
  if (typeof id !== 'string' || id.length > MAX_ID_LENGTH) return null;
  const separator = id.indexOf(':');
  if (separator < 1) return null;
  const namespace = id.slice(0, separator);
  const slug = id.slice(separator + 1);
  if (!(MATERIAL_NAMESPACES as readonly string[]).includes(namespace) || !SLUG.test(slug)) return null;
  return Object.freeze({ namespace: namespace as MaterialNamespace, slug });
}

export const isMaterialId = (id: unknown): id is string => parseMaterialId(id) !== null;

export function materialId(namespace: MaterialNamespace, slug: string): string {
  const id = `${namespace}:${slug}`;
  if (!isMaterialId(id)) throw new MaterialsError('invalid_id', `Недопустимый идентификатор материала «${id}»: ожидается <ref|user|fixture>:<строчные латинские буквы, цифры, «-», «_», «.»>.`);
  return id;
}

/** `ref:element-ti` for the symbol `Ti`: derived from the verified symbol list only. */
export function elementMaterialId(symbol: string): string {
  if (!isElementSymbol(symbol)) throw new MaterialsError('invalid_symbol', `«${String(symbol)}» не является символом химического элемента.`);
  return materialId('ref', `element-${symbol.toLowerCase()}`);
}

/** Canonical JSON: object keys sorted, `undefined` omitted, finite numbers only - the same value always gives the same text, whatever the order of the keys. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new MaterialsError('invalid_material', 'В записи материала встретилось нечисловое значение (NaN или бесконечность).');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default: throw new MaterialsError('invalid_material', `В записи материала недопустимый тип значения: ${typeof value}.`);
  }
}

const FNV_OFFSET = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK_64 = (BigInt(1) << BigInt(64)) - BigInt(1);

/** FNV-1a (64 bit) of the canonical JSON, as 16 hex digits. A fingerprint of CONTENT for detecting duplicates: it is not an identifier and not a security hash. */
export function contentFingerprint(value: unknown): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(canonicalJson(value))) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  return hash.toString(16).padStart(16, '0');
}
