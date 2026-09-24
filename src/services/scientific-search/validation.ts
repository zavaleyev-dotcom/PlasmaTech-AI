import { ScientificSearchError } from './errors';
import { normalizeDoi } from './normalization';
import {
  publicationTypes, MAX_SEARCH_OFFSET, MAX_COMBINED_SEARCH_DEPTH, MAX_COMBINED_EMITTED_KEYS,
  type ScientificSearchQuery, type SearchContinuation, type Publication,
} from './types';

function invalid(message: string): never {
  throw new ScientificSearchError('INVALID_QUERY', message, 400);
}

/** F20: minimal structural check on a buffered record - this data was produced and echoed
 *  back by THIS app's own previous response, so it is not re-validated as untrusted user
 *  input field-by-field; only checked enough to guarantee the pipeline (dedup/filter/sort)
 *  never crashes on a malformed/tampered value. Anything that fails is dropped from the
 *  buffer rather than failing the whole request - a corrupted continuation degrades to "a few
 *  fewer carried-over records", never a hard error. */
function isPublicationLike(value: unknown): value is Publication {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.title === 'string' && Array.isArray(v.authors)
    && Array.isArray(v.sources) && typeof v.source === 'string';
}

/** F20: the client's own continuation token from a previous response, echoed back verbatim.
 *  Parsed leniently - a missing/malformed continuation is never a 400, it just means "start
 *  this combined search fresh" (offset 0, empty buffer), so a client bug or a stale/foreign
 *  token can never hard-fail a search, only reset its pagination state. */
function parseContinuation(value: unknown): SearchContinuation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const num = (x: unknown): number => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;
  const numOrNull = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  const bool = (x: unknown): boolean => x === true;
  const buffer = Array.isArray(v.buffer) ? v.buffer.filter(isPublicationLike).slice(0, 50) : [];
  // F20 (Codex re-detection #3): `emittedKeys` is a sliding window of the MOST RECENTLY
  // emitted keys, kept with `slice(-N)` - the tail of the array, not the head. A previous
  // version used `slice(0, N)`, which kept the OLDEST entries and silently evicted the newest
  // ones once the array exceeded the cap; that let an already-shown record re-appear on a much
  // later page (its key had been forgotten) instead of ever staying correctly bounded AND
  // correct. Also hard-clamps `crossrefOffset`/`openalexOffset` to MAX_COMBINED_SEARCH_DEPTH -
  // a tampered or foreign continuation token can never make the pipeline believe a provider is
  // further along than the configured bound permits.
  const emittedKeys = Array.isArray(v.emittedKeys) ? v.emittedKeys.filter((k): k is string => typeof k === 'string').slice(-MAX_COMBINED_EMITTED_KEYS) : [];
  return {
    crossrefOffset: Math.min(num(v.crossrefOffset), MAX_COMBINED_SEARCH_DEPTH),
    openalexOffset: Math.min(num(v.openalexOffset), MAX_COMBINED_SEARCH_DEPTH),
    crossrefTotal: numOrNull(v.crossrefTotal), openalexTotal: numOrNull(v.openalexTotal),
    crossrefExhausted: bool(v.crossrefExhausted), openalexExhausted: bool(v.openalexExhausted),
    buffer, emittedKeys,
  };
}

export function parseSearchQuery(input: unknown): ScientificSearchQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Неверный формат поискового запроса.');
  const data = input as Record<string, unknown>;
  function text(name: string, max: number): string {
    const value = data[name] ?? '';
    if (typeof value !== 'string' || value.length > max) invalid(`Поле ${name}: допустимо не более ${max} символов.`);
    return value.trim();
  }
  function year(name: string): number | undefined {
    const value = data[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > new Date().getFullYear() + 1) {
      invalid('Год должен быть целым числом от 1000 до следующего календарного года.');
    }
    return value;
  }
  function flag(name: string): boolean {
    if (data[name] === undefined) return false;
    if (typeof data[name] !== 'boolean') invalid(`Поле ${name} должно быть логическим значением.`);
    return data[name] as boolean;
  }
  const query = text('query', 500);
  const keywords = text('keywords', 500);
  const rawDoi = text('doi', 2048);
  const doi = rawDoi ? normalizeDoi(rawDoi) : '';
  if (rawDoi && !doi) invalid('Введите DOI вида 10.1234/example или ссылку https://doi.org/…');
  if (!doi && !query && !keywords) invalid('Введите тему, ключевые слова или DOI.');
  const yearFrom = year('yearFrom');
  const yearTo = year('yearTo');
  if (yearFrom && yearTo && yearFrom > yearTo) invalid('Год «от» не может быть больше года «до».');
  const limit = data.limit ?? 10;
  if (limit !== 10 && limit !== 25 && limit !== 50) invalid('Выберите 10, 25 или 50 результатов.');
  // F20: offset must be a genuine, non-negative multiple of `limit` (the UI only ever moves by
  // whole pages) - not silently coerced from a fractional/negative value. A well-formed but
  // too-deep request is clamped to the last page inside the bound, never rejected outright, so
  // a stale client request never hard-fails - it just gets capped.
  const rawOffset = data.offset ?? 0;
  if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset % limit !== 0) {
    invalid('Смещение страницы должно быть неотрицательным и кратным выбранному размеру страницы.');
  }
  const maxOffset = Math.floor(MAX_SEARCH_OFFSET / limit) * limit;
  const offset = Math.min(rawOffset, maxOffset);
  const source = data.source ?? 'crossref';
  if (source !== 'crossref' && source !== 'openalex' && source !== 'combined') invalid('Неизвестный научный источник.');
  const sort = data.sort ?? 'relevance';
  if (sort !== 'relevance' && sort !== 'year' && sort !== 'citations' && sort !== 'open-access') invalid('Неизвестный порядок сортировки.');
  const type = text('type', 40);
  if (type && !publicationTypes.some(item => item === type)) invalid('Неизвестный тип публикации.');
  const journalOnly = flag('journalOnly');
  if (journalOnly && type && type !== 'journal-article') invalid('Фильтр journal article несовместим с выбранным типом публикации.');
  // F20: only meaningful for source: 'combined' - parsed regardless of `source` (harmless if
  // present but unused for a single-provider search), never required.
  const continuation = source === 'combined' ? parseContinuation(data.continuation) : undefined;
  return {
    query, keywords, doi: doi || '', yearFrom, yearTo, limit, source, sort, offset, continuation,
    type: type as ScientificSearchQuery['type'], journalOnly,
    hasDoi: flag('hasDoi'), hasAbstract: flag('hasAbstract'), openAccessOnly: flag('openAccessOnly'),
  };
}
