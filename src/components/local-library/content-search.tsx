'use client';
import { useCallback, useEffect, useState } from 'react';
import type { ContentHit, TextOverview } from '@/services/library-text/types';
import styles from '@/components/scifinder/search.module.css';
export function ContentSearch() {
  const [overview, setOverview] = useState<TextOverview | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''); const [searched, setSearched] = useState('');
  const [result, setResult] = useState<{ hits: ContentHit[]; total: number; offset: number; offsetCapped?: boolean; atMaxOffset?: boolean; rankingDegraded?: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const load = useCallback(async () => {
    try { const response = await fetch('/api/library/text', { cache: 'no-store', signal: AbortSignal.timeout(15000) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setOverview(data); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось прочитать текстовый индекс.'); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => { if (!overview?.progress?.running) return; const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load, overview?.progress?.running]);
  async function action(method: 'POST' | 'DELETE') {
    setBusy(true); setError('');
    try { const response = await fetch('/api/library/text', { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить действие.'); }
    finally { setBusy(false); }
  }
  async function search(text: string, start = 0) {
    setSearching(true); setError('');
    try {
      const response = await fetch(`/api/library/text?q=${encodeURIComponent(text)}&offset=${start}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      // F09: pagination state (the range shown, and whether "Далее" stays enabled) is driven
      // entirely by `data.offset` - the offset the BACKEND actually served - never by `start`,
      // the offset this request merely ASKED for. Once the backend caps deep pagination, every
      // further "next page" click keeps asking for a larger `start`, but every response keeps
      // reporting the SAME real `data.offset` - so the displayed range stays honest (e.g.
      // "501-520 of N") instead of drifting to a fabricated "521-540 of N" over rows that were
      // never actually fetched from that position.
      setResult(data); setSearched(text);
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : 'Ошибка поиска.'); }
    finally { setSearching(false); }
  }
  const progress = overview?.progress;
  return <section aria-label="Поиск по содержимому">
    <div className={`${styles.actions} ${styles.results}`}><button className="button primary" disabled={busy || progress?.running} onClick={() => void action('POST')}>Обновить текстовый индекс</button>
      {progress?.running && <button className="button secondary" disabled={busy || progress.stopRequested} onClick={() => void action('DELETE')}>{progress.stopRequested ? 'Останавливается…' : 'Остановить индексирование'}</button>}
    </div>
    <p className={styles.hint}>Текст извлекается локально, только по вашей команде. Готовые неизменённые PDF используются повторно. Сканам без текстового слоя потребуется OCR на отдельном этапе.</p>
    {error && <p role="alert" className={`${styles.status} ${styles.error}`}>{error}</p>}
    {overview && <div role="status" className={styles.status}>
      <p>Документов в текстовом индексе: {overview.stats.documents} · С текстом: {overview.stats.successful} · Пропущено / без текста: {overview.stats.skipped} · Ошибок: {overview.stats.errors}</p>
      <p>Фрагментов: {overview.stats.chunks} · Символов: {overview.stats.characters.toLocaleString('ru-RU')} · Объём текста: {(overview.stats.textBytes / 1024 / 1024).toFixed(1)} МБ</p>
      {progress && <><p>{progress.running ? 'Индексирование' : progress.cancelled ? 'Остановлено' : 'Последний запуск'}: {progress.processed} из {progress.total} · Осталось: {Math.max(0, progress.total - progress.processed)} · Повторно использовано: {progress.reused} · Ошибок в запуске: {progress.errors}</p>{progress.error && <p>{progress.error}</p>}</>}
    </div>}
    <form className={`${styles.publication} ${styles.results}`} onSubmit={e => { e.preventDefault(); void search(query); }}>
      <label className={styles.field}>Слова или фраза в тексте PDF<input className={styles.control} type="search" value={query} onChange={e => setQuery(e.target.value)} maxLength={500} placeholder={'Например: "diamond like carbon"'} /></label>
      <p className={styles.hint}>Все слова должны встречаться в одном фрагменте. Для точной фразы используйте двойные кавычки. Поиск лексический, без AI; результаты упорядочены по совпадению слов.</p>
      <button className="button primary" disabled={searching || !query.trim()}>{searching ? 'Поиск…' : 'Найти в содержимом'}</button>
    </form>
    {result && <div className={styles.results} aria-live="polite"><h2>Найдено фрагментов: {result.total}</h2><p className={styles.hint}>Запрос: {searched}. Один документ может содержать несколько подходящих фрагментов.</p>
      {!result.hits.length && <p className={styles.status}>Ничего не найдено. Попробуйте другие слова или обновите текстовый индекс.</p>}
      <div className={styles.list}>{result.hits.map(hit => <article key={hit.chunkId} className={styles.publication}><div className={styles.meta}>Страницы {hit.pageStart}–{hit.pageEnd} · {hit.year ?? 'Год не указан'}</div><h3>{hit.title}</h3><p className={styles.authors}>{hit.authors.join('; ') || 'Авторы не указаны'}</p><p>{hit.snippet}</p><dl className={styles.details}><div><dt>DOI</dt><dd>{hit.doi ? <a className={styles.link} href={`https://doi.org/${encodeURIComponent(hit.doi)}`} target="_blank" rel="noreferrer">{hit.doi}</a> : 'Не указан'}</dd></div><div><dt>Исходная папка</dt><dd>{hit.sourceFolder}</dd></div><div><dt>Имя PDF</dt><dd>{hit.filename}</dd></div><div><dt>Путь относительно библиотеки</dt><dd>{hit.relativePath}</dd></div></dl><a className={`button secondary ${styles.results}`} href={`/api/library/pdf?id=${hit.id}#page=${hit.pageStart}`} target="_blank" rel="noreferrer">Открыть исходный PDF</a></article>)}</div>
      {result.total > 20 && <div className={`${styles.actions} ${styles.results}`}>
        <button className="button secondary" disabled={searching || result.offset === 0} onClick={() => void search(searched, result.offset - 20)}>Назад</button>
        <span>{result.offset + 1}–{Math.min(result.offset + 20, result.total)} из {result.total}</span>
        {/* F09: disabled the moment THIS page's response reports atMaxOffset - before any
            click could ever request an offset the backend would just clamp back down again
            (which previously produced a duplicate page silently mislabeled with a fake range). */}
        <button className="button secondary" disabled={searching || result.offset + 20 >= result.total || result.atMaxOffset} onClick={() => void search(searched, result.offset + 20)}>Далее</button>
      </div>}
      {result.atMaxOffset && <p className={styles.hint}>Показана только первая часть результатов — при таком количестве совпадений более глубокая навигация недоступна. Уточните запрос словами, чтобы сузить выдачу.</p>}
      {result.rankingDegraded && <p className={styles.hint}>При таком количестве совпадений результаты показаны в порядке хранения, а не по релевантности. Уточните запрос словами, чтобы сузить выдачу и получить ранжирование по релевантности.</p>}
    </div>}
    {!!overview?.errors.length && <details className={`${styles.status} ${styles.results}`}><summary>Пропуски и ошибки: {overview.errors.length}</summary><ul>{overview.errors.map(e => <li key={e.relativePath} style={{ overflowWrap: 'anywhere' }}>{e.relativePath}: {e.error}</li>)}</ul></details>}
  </section>;
}
