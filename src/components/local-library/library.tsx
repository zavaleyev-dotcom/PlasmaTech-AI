'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { filterLibrary } from '@/services/local-library/filter';
import { documentTypes, type IndexProgress, type LibraryQuery, type PublicLibraryRecord } from '@/services/local-library/types';
import { ContentSearch } from './content-search';
import { AskLibrary } from './ask';
import styles from '@/components/scifinder/search.module.css';
interface Snapshot { records: PublicLibraryRecord[]; indexedAt: string | null; errors: { relativePath: string; message: string }[]; progress: IndexProgress }
export function LocalLibrary() {
  const [mode, setMode] = useState<'metadata' | 'content' | 'ask'>('metadata');
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState<LibraryQuery>({ sort: 'title' });
  const [page, setPage] = useState(1);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/library', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить индекс.'); }
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    if (!data?.progress.running) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [data?.progress.running, load]);
  async function refresh() {
    setStarting(true); setError('');
    try {
      const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обновить индекс.'); }
    finally { setStarting(false); }
  }
  function change(key: keyof LibraryQuery, value: string) { setQuery(q => ({ ...q, [key]: value })); setPage(1); }
  const records = useMemo(() => filterLibrary(data?.records ?? [], query), [data?.records, query]);
  const folders = useMemo(() => [...new Set(data?.records.map(r => r.sourceFolder))].sort((a, b) => a.localeCompare(b)), [data?.records]);
  const years = useMemo(() => [...new Set(data?.records.flatMap(r => r.year === null ? [] : [r.year]))].sort((a, b) => b - a), [data?.records]);
  const pages = Math.max(1, Math.ceil(records.length / 50));
  const currentPage = Math.min(page, pages);
  return <>
    <div className={styles.actions} aria-label="Режим поиска"><button className={`button ${mode === 'metadata' ? 'primary' : 'secondary'}`} aria-pressed={mode === 'metadata'} onClick={() => setMode('metadata')}>Поиск по метаданным</button><button className={`button ${mode === 'content' ? 'primary' : 'secondary'}`} aria-pressed={mode === 'content'} onClick={() => setMode('content')}>Поиск по содержимому</button><button className={`button ${mode === 'ask' ? 'primary' : 'secondary'}`} aria-pressed={mode === 'ask'} onClick={() => setMode('ask')}>Спросить библиотеку</button></div>
    {mode === 'content' ? <ContentSearch /> : mode === 'ask' ? <AskLibrary /> : <div className={styles.results}>
    <div className={styles.actions}><button className="button primary" disabled={starting || data?.progress.running} onClick={() => void refresh()}>{starting || data?.progress.running ? 'Индексирование…' : 'Обновить индекс'}</button><span className={styles.hint}>PDF доступны только для чтения. Обогащение через внешние сервисы не выполняется.</span></div>
    {error && <div role="alert" className={`${styles.status} ${styles.error}`}>{error}<button className="button secondary" onClick={() => void load()}>Повторить загрузку</button></div>}
    {!data && !error && <p role="status">Загрузка индекса…</p>}
    {data && <>
      <div className={styles.results} role="status"><p>В индексе: {data.records.length} PDF · Без ошибок чтения: {data.records.filter(r => !r.error).length} · С ошибками: {data.records.filter(r => r.error).length}</p><p className={styles.hint}>Последнее индексирование: {data.indexedAt ? new Date(data.indexedAt).toLocaleString('ru-RU') : 'ещё не выполнялось'}</p>
        {data.progress.running && <p>Обработано {data.progress.processed} из {data.progress.discovered} PDF. Можно продолжать пользоваться платформой.</p>}
        {data.progress.error && <p role="alert">{data.progress.error}</p>}
      </div>
      <div className={`${styles.publication} ${styles.results}`}><div className={styles.form}>
        <label className={`${styles.field} ${styles.full}`}>Поиск по названию, автору, DOI и имени файла<input className={styles.control} value={query.search ?? ''} onChange={e => change('search', e.target.value)} type="search" /></label>
        <label className={styles.field}>Тип документа<select className={styles.control} value={query.documentType ?? ''} onChange={e => change('documentType', e.target.value)}><option value="">Все типы</option>{documentTypes.map(type => <option key={type}>{type}</option>)}</select></label>
        <label className={styles.field}>Исходная папка<select className={styles.control} value={query.sourceFolder ?? ''} onChange={e => change('sourceFolder', e.target.value)}><option value="">Все папки</option>{folders.map(folder => <option key={folder}>{folder}</option>)}</select></label>
        <label className={styles.field}>Год публикации<select className={styles.control} value={query.year ?? ''} onChange={e => change('year', e.target.value)}><option value="">Все годы</option>{years.map(year => <option key={year}>{year}</option>)}</select></label>
        <label className={styles.field}>Сортировка<select className={styles.control} value={query.sort} onChange={e => change('sort', e.target.value)}><option value="title">По названию</option><option value="year">По году: сначала новые</option><option value="modified">По дате изменения: сначала новые</option></select></label>
      </div></div>
      <section className={styles.results} aria-label="Документы библиотеки"><div className={styles.resultsHeader}><h2>Документы</h2><span>Найдено: {records.length}</span></div>
        {!records.length && <p className={styles.status}>{data.indexedAt ? 'Ничего не найдено. Измените условия поиска.' : 'Нажмите «Обновить индекс», чтобы прочитать локальную библиотеку.'}</p>}
        <div className={styles.list}>{records.slice((currentPage - 1) * 50, currentPage * 50).map(record => <article className={styles.publication} key={record.id}>
          <div className={styles.meta}><span>{record.documentType}</span><span>{record.year ?? 'Год не указан'}</span></div><h3>{record.title}</h3><p className={styles.authors}>{record.authors.join('; ') || 'Авторы не указаны'}</p>
          <dl className={styles.details}><div><dt>DOI</dt><dd>{record.doi ? <a className={styles.link} href={`https://doi.org/${encodeURIComponent(record.doi)}`} target="_blank" rel="noreferrer">{record.doi}</a> : 'Не найден'}</dd></div><div><dt>Исходная папка</dt><dd>{record.sourceFolder}</dd></div><div><dt>Имя PDF</dt><dd>{record.filename}</dd></div><div><dt>Изменён</dt><dd>{record.modifiedDate ? new Date(record.modifiedDate).toLocaleDateString('ru-RU') : 'Неизвестно'}</dd></div></dl>
          {record.error && <p className={styles.error}>{record.error}</p>}
        </article>)}</div>
        {pages > 1 && <div className={`${styles.actions} ${styles.results}`}><button className="button secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>Страница {currentPage} из {pages}</span><button className="button secondary" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Далее</button></div>}
      </section>
      {data.errors.length > 0 && <details className={`${styles.status} ${styles.results}`}><summary>Ошибки чтения файлов и каталогов: {data.errors.length}</summary><ul>{data.errors.map((item, i) => <li key={`${item.relativePath}-${i}`} style={{ overflowWrap: 'anywhere' }}>{item.relativePath}: {item.message}</li>)}</ul></details>}
      <p className={styles.hint}>Название и авторы берутся из метаданных PDF, если они доступны. Год не выводится из даты создания файла. Тип определяется по папкам и может нуждаться в уточнении. Для сканов без текстового слоя OCR не выполняется.</p>
    </>}
    </div>}
  </>;
}
