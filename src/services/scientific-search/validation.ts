import { ScientificSearchError } from './errors';
import { normalizeDoi } from './normalization';
import { publicationTypes, MAX_SEARCH_OFFSET, type ScientificSearchQuery, type SearchContinuation } from './types';
import { processContinuationStore, isValidContinuationToken, queryFingerprint, type ContinuationBinding, type ContinuationStore } from './continuation-store';

function invalid(message: string): never {
  throw new ScientificSearchError('INVALID_QUERY', message, 400);
}

/** The client's `continuation` is an opaque ContinuationStore token. It is resolved only for
 *  combined searches and must be bound to the SAME search parameters and the SAME client
 *  context that created it. Anything else is an explicit error - never a silent restart:
 *   - malformed shape        -> 400 INVALID_CONTINUATION
 *   - unknown/expired/foreign -> 410 CONTINUATION_EXPIRED
 *   - other search's token   -> 409 CONTINUATION_MISMATCH
 *  An absent token (undefined/null) is the only way to start a combined search fresh. */
function resolveContinuation(value: unknown, store: ContinuationStore, binding: ContinuationBinding): SearchContinuation | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isValidContinuationToken(value)) {
    throw new ScientificSearchError('INVALID_CONTINUATION', 'Некорректный токен постраничного просмотра. Выполните поиск заново.', 400);
  }
  const resolution = store.resolve(value, binding);
  if (resolution.status === 'ok') return resolution.state;
  if (resolution.status === 'mismatch') {
    throw new ScientificSearchError('CONTINUATION_MISMATCH', 'Токен постраничного просмотра относится к другому поисковому запросу. Выполните поиск заново.', 409);
  }
  throw new ScientificSearchError('CONTINUATION_EXPIRED', 'Сессия постраничного просмотра истекла или недействительна. Выполните поиск заново.', 410);
}

export function parseSearchQuery(input: unknown, store: ContinuationStore = processContinuationStore, clientId = ''): ScientificSearchQuery {
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
  const hasDoi = flag('hasDoi');
  const hasAbstract = flag('hasAbstract');
  const openAccessOnly = flag('openAccessOnly');
  const parsed: ScientificSearchQuery = {
    query, keywords, doi: doi || '', yearFrom, yearTo, limit, source, sort, offset,
    type: type as ScientificSearchQuery['type'], journalOnly, hasDoi, hasAbstract, openAccessOnly,
  };
  // Only meaningful for source: 'combined' (ignored for single-provider searches).
  if (source === 'combined') {
    parsed.continuation = resolveContinuation(data.continuation, store, { fingerprint: queryFingerprint(parsed), clientId });
  }
  return parsed;
}
