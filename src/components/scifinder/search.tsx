'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { publicationTypes, type ScientificSearchQuery, type ScientificSearchResult, type SearchErrorBody } from '@/services/scientific-search/types';
import { PublicationCard } from './publication-card';
import styles from './search.module.css';

const typeLabels: Record<string, string> = {
  'journal-article': 'Журнальная статья', 'proceedings-article': 'Статья конференции',
  'book-chapter': 'Глава книги', book: 'Книга', 'posted-content': 'Размещённый материал / препринт',
  report: 'Отчёт', dissertation: 'Диссертация', dataset: 'Набор данных',
};

export function SciFinderSearch() {
  const [query, setQuery] = useState('');
  const [keywords, setKeywords] = useState('');
  const [doi, setDoi] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [limit, setLimit] = useState<10 | 25 | 50>(10);
  const [source, setSource] = useState<ScientificSearchQuery['source']>('crossref');
  const [sort, setSort] = useState<ScientificSearchQuery['sort']>('relevance');
  const [openAccessOnly, setOpenAccessOnly] = useState(false);
  const [type, setType] = useState<ScientificSearchQuery['type']>('');
  const [journalOnly, setJournalOnly] = useState(false);
  const [hasDoi, setHasDoi] = useState(false);
  const [hasAbstract, setHasAbstract] = useState(false);
  const [result, setResult] = useState<ScientificSearchResult | null>(null);
  const [error, setError] = useState<SearchErrorBody['error'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const lastRequest = useRef<ScientificSearchQuery | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  // F20: combined-mode-only continuation history, one entry per page - this app is fully
  // stateless server-side, so the state that makes combined (Crossref + OpenAlex) pagination
  // correct (each provider's own cursor/exhaustion, and the carry-over buffer of already-
  // fetched-but-not-yet-shown unique records) has to be cached somewhere between requests,
  // and the client is the only place that persists across them. `combinedHistory.current[i]`
  // is the token to send when REQUESTING page i (index 0 is always undefined - a fresh
  // start); after fetching page i, its response's own `continuation` becomes the token for
  // page i+1. "Назад" simply replays the ALREADY-CACHED token for the previous page instead
  // of trying to invert the forward continuation arithmetic (which combined pagination does
  // not support - only the client's own page history makes "back" deterministic here).
  const combinedHistory = useRef<Array<ScientificSearchResult['continuation']>>([undefined]);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function search(request: ScientificSearchQuery, targetPage = 0) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    lastRequest.current = request;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/scifinder/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
      });
      const body: ScientificSearchResult | SearchErrorBody = await response.json();
      if (!response.ok || 'error' in body) {
        setError('error' in body ? body.error : { code: 'SEARCH_ERROR', message: 'Не удалось выполнить поиск. Повторите запрос.', retryable: true });
      } else {
        setResult(body);
        setPage(targetPage);
        if (request.source === 'combined') combinedHistory.current[targetPage + 1] = body.continuation;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setError({
        code: 'CONNECTION_ERROR', retryable: true,
        message: error instanceof Error && error.name === 'TimeoutError'
          ? 'Время ожидания истекло. Повторите поиск.'
          : 'Не удалось связаться с сервером. Проверьте соединение и повторите поиск.',
      });
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (yearFrom && yearTo && Number(yearFrom) > Number(yearTo)) {
      setResult(null);
      setError({ code: 'INVALID_QUERY', message: 'Год «от» не может быть больше года «до».', retryable: false });
      return;
    }
    // F20: any NEW search (the form itself, not a page navigation) always starts at offset 0
    // (single-provider) / a fresh, empty continuation (combined) - a fresh query resets
    // pagination state entirely, it never continues from wherever the previous query left off.
    combinedHistory.current = [undefined];
    void search({
      query, keywords, doi, limit, source, sort, openAccessOnly, type, journalOnly, hasDoi, hasAbstract, offset: 0,
      yearFrom: yearFrom ? Number(yearFrom) : undefined,
      yearTo: yearTo ? Number(yearTo) : undefined,
    }, 0);
  }

  // F20: Previous/Next re-issue the EXACT same query, only the offset changes - so filters,
  // sort and source stay fixed while paging (this is a page navigation, not a new search).
  // Single-provider (crossref/openalex) only - combined mode uses goToCombinedPage below.
  function goToOffset(offset: number) {
    if (!lastRequest.current) return;
    void search({ ...lastRequest.current, offset });
  }

  // F20: combined-mode page navigation - replays the cached continuation for `targetPage`
  // (already known for "back", or the one just received for "next"), never recomputes it.
  function goToCombinedPage(targetPage: number) {
    if (!lastRequest.current) return;
    void search({ ...lastRequest.current, continuation: combinedHistory.current[targetPage] }, targetPage);
  }

  function example() {
    setQuery('AlTiSiN coating cutting tools'); setKeywords(''); setDoi('');
    setYearFrom(''); setYearTo(''); setType(''); setJournalOnly(false);
    setOpenAccessOnly(false); setSort('relevance'); setHasDoi(false); setHasAbstract(false); setLimit(10); setError(null); setResult(null);
    combinedHistory.current = [undefined]; setPage(0);
  }

  return (
    <>
      <div className="notice"><Icon name="search" /><span>Реальный библиографический поиск в Crossref и OpenAlex. Отображаются метаданные источника без AI-аннотаций и выводов.</span></div>
      <section className="content-card" aria-label="Поиск научных публикаций">
        <form onSubmit={submit}>
          <fieldset disabled={busy} className={styles.form}>
            <legend className="sr-only">Параметры поиска</legend>
            <label className={`${styles.field} ${styles.full}`}>Тема исследования / поисковый запрос
              <input className={styles.control} value={query} onChange={event => setQuery(event.target.value)} maxLength={500} placeholder="Например: AlTiSiN coating cutting tools" />
            </label>
            <label className={styles.field}>Дополнительные ключевые слова
              <input className={styles.control} value={keywords} onChange={event => setKeywords(event.target.value)} maxLength={500} placeholder="PVD, wear resistance, magnetron sputtering" />
            </label>
            <label className={styles.field}>DOI для точного поиска
              <input className={styles.control} value={doi} onChange={event => setDoi(event.target.value)} maxLength={2048} placeholder="10.… или https://doi.org/…" aria-describedby="doi-search-note" />
            </label>
            <p className={`${styles.hint} ${styles.full}`} id="doi-search-note">При заполненном DOI тема и ключевые слова не используются. Фильтры применяются и к точному поиску. Crossref находит DOI, зарегистрированные в Crossref.</p>
            <label className={styles.field}>Год публикации от
              <input type="number" min={1000} max={new Date().getFullYear() + 1} step={1} className={styles.control} value={yearFrom} onChange={event => setYearFrom(event.target.value)} placeholder="Например: 2015" />
            </label>
            <label className={styles.field}>Год публикации до
              <input type="number" min={1000} max={new Date().getFullYear() + 1} step={1} className={styles.control} value={yearTo} onChange={event => setYearTo(event.target.value)} placeholder="Например: 2026" />
            </label>
            <label className={styles.field}>Количество результатов
              <select className={styles.control} value={limit} onChange={event => setLimit(Number(event.target.value) as 10 | 25 | 50)}>{[10, 25, 50].map(value => <option key={value} value={value}>{value}</option>)}</select>
            </label>
            <label className={styles.field}>Источник
              <select className={styles.control} value={source} onChange={event => setSource(event.target.value as ScientificSearchQuery['source'])}><option value="crossref">Crossref</option><option value="openalex">OpenAlex</option><option value="combined">Crossref + OpenAlex</option></select>
            </label>
            <label className={`${styles.field} ${styles.full}`}>Тип публикации
              <select className={styles.control} value={journalOnly ? 'journal-article' : type} disabled={journalOnly || busy} onChange={event => setType(event.target.value as ScientificSearchQuery['type'])}>
                <option value="">Все типы</option>{publicationTypes.map(value => <option value={value} key={value}>{typeLabels[value]} · {value}</option>)}
              </select>
            </label>
            <label className={styles.field}>Сортировка загруженных результатов
              <select className={styles.control} value={sort} onChange={event => setSort(event.target.value as ScientificSearchQuery['sort'])}>
                <option value="relevance">По релевантности</option><option value="year">По году: сначала новые</option><option value="citations">По числу цитирований</option><option value="open-access">Сначала Open Access</option>
              </select>
            </label>
            <div className={`${styles.checks} ${styles.full}`}>
              <label><input type="checkbox" checked={openAccessOnly} onChange={event => setOpenAccessOnly(event.target.checked)} />Только Open Access</label>
              <label><input type="checkbox" checked={journalOnly} onChange={event => { setJournalOnly(event.target.checked); setType(''); }} />Только journal article</label>
              <label><input type="checkbox" checked={hasDoi} onChange={event => setHasDoi(event.target.checked)} />Наличие DOI</label>
              <label><input type="checkbox" checked={hasAbstract} onChange={event => setHasAbstract(event.target.checked)} />Наличие abstract</label>
            </div>
            <p className={`${styles.hint} ${styles.full}`}>Тип journal-article не подтверждает рецензирование. Abstract может отсутствовать в метаданных. Фильтры и сортировка применяются после нажатия «Найти публикации».</p>
            <div className={`${styles.actions} ${styles.full}`}>
              <button className="button primary" disabled={busy || !(query.trim() || keywords.trim() || doi.trim())}>
                <Icon name="search" size={18} />{busy ? 'Поиск…' : 'Найти публикации'}
              </button>
              <button type="button" className="button secondary" onClick={example}>Заполнить пример запроса</button>
            </div>
          </fieldset>
        </form>
      </section>
      <section className={styles.results} aria-label="Результаты поиска" aria-busy={busy}>
        <div className={styles.resultsHeader}><h2>Публикации</h2>{result && <span className="muted small">Показано: {result.returned}</span>}</div>
        <div role="status" aria-live="polite">
          {busy && <div className={`${styles.status} ${styles.actions}`}><span className={styles.spinner}><Icon name="atom" /></span>Поиск публикаций в выбранных источниках…</div>}
          {result && <div className={styles.hint}>
            {result.sourceStats.map(stat => <p key={stat.source}>{stat.source === 'crossref' ? 'Crossref' : 'OpenAlex'}: {stat.error ? 'недоступен' : `совпадений ${stat.total?.toLocaleString('ru-RU')}, загружено ${stat.retrieved}`}.</p>)}
            <p>Загружено всего: {result.retrieved}; удалено дублей: {result.duplicatesRemoved}; уникальных: {result.uniqueRetrieved}; исключено фильтрами: {result.filteredOut}; показано: {result.returned}.</p>
            <p>Запрос: {result.query.doi || [result.query.query, result.query.keywords].filter(Boolean).join(' ')}. Загружается до {result.query.limit} записей из каждого источника. Счётчики источников пересекаются и не равны числу уникальных публикаций.</p>
            <p>Сортировка действует на загруженную выборку. Совместная релевантность объединяет позиции в выдачах источников; неизвестные годы и цитирования идут в конце. Статус OA известен только из метаданных OpenAlex.</p>
          </div>}
        </div>
        {result && result.warnings.length > 0 && <div className="notice" role="status"><div>{result.warnings.map(warning => <p key={warning}>{warning}</p>)}<button className="button secondary mt-4" disabled={busy} onClick={() => lastRequest.current && void search(lastRequest.current)}>Повторить запрос</button></div></div>}
        {error && <div className={`${styles.status} ${styles.error}`} role="alert"><p>{error.message}</p>{error.retryable && <button className="button secondary mt-4" disabled={busy} onClick={() => lastRequest.current && void search(lastRequest.current)}>Повторить запрос</button>}</div>}
        {!busy && !error && !result && <p className={styles.status}>Введите тему, ключевые слова или DOI и нажмите «Найти публикации».</p>}
        {result && result.returned === 0 && page === 0 && <p className={`${styles.status} mt-4`}>Ничего не найдено. Уточните запрос, проверьте DOI или ослабьте фильтры.</p>}
        {result && result.returned === 0 && page > 0 && <p className={`${styles.status} mt-4`}>На этой странице результатов больше нет.</p>}
        {result && <div className={styles.list}>{result.publications.map((publication, index) => <PublicationCard key={publication.id} publication={publication} index={index} />)}</div>}
        {/* F20: combined mode pages by its own client-cached continuation (goToCombinedPage);
            single-provider mode keeps its simpler offset-based navigation (goToOffset) -
            these are genuinely different pagination mechanisms, never forced into one. */}
        {result && result.source === 'combined' && (page > 0 || result.hasMore) && <div className={`${styles.actions} ${styles.full} mt-4`}>
          <button type="button" className="button secondary" disabled={busy || page === 0} onClick={() => goToCombinedPage(page - 1)}>← Назад</button>
          <span className="muted small">Страница {page + 1}</span>
          <button type="button" className="button secondary" disabled={busy || !result.hasMore} onClick={() => goToCombinedPage(page + 1)}>Далее →</button>
        </div>}
        {result && result.source !== 'combined' && (result.offset > 0 || result.hasMore) && <div className={`${styles.actions} ${styles.full} mt-4`}>
          <button type="button" className="button secondary" disabled={busy || result.offset === 0} onClick={() => goToOffset(Math.max(0, result.offset - result.query.limit))}>← Назад</button>
          <span className="muted small">Страница {Math.floor(result.offset / result.query.limit) + 1}</span>
          <button type="button" className="button secondary" disabled={busy || !result.hasMore} onClick={() => goToOffset(result.offset + result.query.limit)}>Далее →</button>
        </div>}
      </section>
    </>
  );
}
