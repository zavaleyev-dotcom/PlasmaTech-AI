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
  const [type, setType] = useState<ScientificSearchQuery['type']>('');
  const [journalOnly, setJournalOnly] = useState(false);
  const [hasDoi, setHasDoi] = useState(false);
  const [hasAbstract, setHasAbstract] = useState(false);
  const [result, setResult] = useState<ScientificSearchResult | null>(null);
  const [error, setError] = useState<SearchErrorBody['error'] | null>(null);
  const [busy, setBusy] = useState(false);
  const lastRequest = useRef<ScientificSearchQuery | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function search(request: ScientificSearchQuery) {
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
      setError({ code: 'INVALID_QUERY', message: 'Год «от» не может быть больше года «до».', retryable: false });
      return;
    }
    void search({
      query, keywords, doi, limit, source: 'crossref', type, journalOnly, hasDoi, hasAbstract,
      yearFrom: yearFrom ? Number(yearFrom) : undefined,
      yearTo: yearTo ? Number(yearTo) : undefined,
    });
  }

  function example() {
    setQuery('AlTiSiN coating cutting tools'); setKeywords(''); setDoi('');
    setYearFrom(''); setYearTo(''); setType(''); setJournalOnly(false);
    setHasDoi(false); setHasAbstract(false); setLimit(10); setError(null); setResult(null);
  }

  return (
    <>
      <div className="notice"><Icon name="search" /><span>Реальный библиографический поиск в Crossref. Отображаются метаданные источника без AI-аннотаций и выводов.</span></div>
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
              <select className={styles.control} defaultValue="crossref"><option value="crossref">Crossref</option><option value="openalex" disabled>OpenAlex — подготовлен, не активирован</option></select>
            </label>
            <label className={`${styles.field} ${styles.full}`}>Тип публикации
              <select className={styles.control} value={journalOnly ? 'journal-article' : type} disabled={journalOnly || busy} onChange={event => setType(event.target.value as ScientificSearchQuery['type'])}>
                <option value="">Все типы</option>{publicationTypes.map(value => <option value={value} key={value}>{typeLabels[value]} · {value}</option>)}
              </select>
            </label>
            <div className={`${styles.checks} ${styles.full}`}>
              <label><input type="checkbox" checked={journalOnly} onChange={event => { setJournalOnly(event.target.checked); setType(''); }} />Только journal article</label>
              <label><input type="checkbox" checked={hasDoi} onChange={event => setHasDoi(event.target.checked)} />Наличие DOI</label>
              <label><input type="checkbox" checked={hasAbstract} onChange={event => setHasAbstract(event.target.checked)} />Наличие abstract</label>
            </div>
            <p className={`${styles.hint} ${styles.full}`}>Тип journal-article не подтверждает рецензирование. Abstract может отсутствовать в метаданных. Фильтры применяются после нажатия «Найти публикации».</p>
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
          {busy && <div className={`${styles.status} ${styles.actions}`}><span className={styles.spinner}><Icon name="atom" /></span>Поиск публикаций в Crossref…</div>}
          {result && <p className={styles.hint}>Совпадений в Crossref: {result.total.toLocaleString('ru-RU')}. Загружено: {result.retrieved}; удалено дублей: {result.duplicatesRemoved}; исключено фильтрами: {result.filteredOut}; показано: {result.returned}.<br />Запрос: {result.query.doi || [result.query.query, result.query.keywords].filter(Boolean).join(' ')}. Это первая выборка до {result.query.limit} записей; общее число не означает точное тематическое соответствие каждой публикации.</p>}
        </div>
        {error && <div className={`${styles.status} ${styles.error}`} role="alert"><p>{error.message}</p>{error.retryable && <button className="button secondary mt-4" disabled={busy} onClick={() => lastRequest.current && void search(lastRequest.current)}>Повторить запрос</button>}</div>}
        {!busy && !error && !result && <p className={styles.status}>Введите тему, ключевые слова или DOI и нажмите «Найти публикации».</p>}
        {result && result.returned === 0 && <p className={`${styles.status} mt-4`}>Ничего не найдено. Уточните запрос, проверьте DOI или ослабьте фильтры.</p>}
        {result && <div className={styles.list}>{result.publications.map((publication, index) => <PublicationCard key={publication.id} publication={publication} index={index} />)}</div>}
      </section>
    </>
  );
}
