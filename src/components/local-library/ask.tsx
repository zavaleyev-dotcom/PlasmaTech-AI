'use client';
import { useState } from 'react';
import type { AnswerClaim, Citation, RagDiagnostics, RagStatus, RetrievedChunk } from '@/services/rag/types';
import { INSUFFICIENT_DATA_ANSWER } from '@/services/rag/prompt';
import styles from '@/components/scifinder/search.module.css';
interface AskResponse {
  question: string; limit: number; status: RagStatus; chunks: RetrievedChunk[]; citations: Citation[];
  answer: { claims: AnswerClaim[]; configured: boolean; error: string | null };
  diagnostics?: RagDiagnostics;
}
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
export function AskLibrary() {
  const [question, setQuestion] = useState('');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [showFragments, setShowFragments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch('/api/library/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, limit }), signal: AbortSignal.timeout(60_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Не удалось получить ответ.');
      setResult(data);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось получить ответ.'); }
    finally { setBusy(false); }
  }
  const answer = result?.answer;
  return <section aria-label="Спросить библиотеку" className={styles.results}>
    <p className={styles.hint}>
      Ответ строится только на фрагментах, найденных в вашей локальной библиотеке через лексический поиск (FTS5) -
      без embeddings и без внешних знаний. Если данных недостаточно, так и будет сказано.
    </p>
    <form className={`${styles.publication} ${styles.results}`} onSubmit={e => void ask(e)}>
      <label className={`${styles.field} ${styles.full}`}>Вопрос к библиотеке
        <textarea className={styles.control} rows={3} maxLength={2000} value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Например: какие температуры осаждения AlTiSiN использовались для режущего инструмента?" />
      </label>
      <label className={styles.field}>Сколько фрагментов искать
        <select className={styles.control} value={limit} onChange={e => setLimit(Number(e.target.value))}>
          {[4, DEFAULT_LIMIT, 12, MAX_LIMIT].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <button className="button primary" disabled={busy || !question.trim()}>{busy ? 'Ищем и отвечаем…' : 'Спросить'}</button>
    </form>
    {error && <p role="alert" className={`${styles.status} ${styles.error}`}>{error}</p>}
    {result && <div className={styles.results} aria-live="polite">
      {(result.status === 'unavailable' || result.status === 'index_error') &&
        <p role="alert" className={`${styles.status} ${styles.error}`}>{answer?.error}</p>}
      {result.status !== 'unavailable' && result.status !== 'index_error' && !result.chunks.length &&
        <p className={styles.status}>В проиндексированной библиотеке недостаточно данных для уверенного ответа.</p>}
      {!!result.chunks.length && answer && <>
        {result.status === 'not_configured' && <p className={styles.hint}>
          Генерация ответа не настроена (нет ключа генеративной модели на сервере). Ниже показаны найденные источники и фрагменты -
          проверьте их вручную.
        </p>}
        {result.status === 'generation_error' && <p role="alert" className={`${styles.status} ${styles.error}`}>{answer.error} Ниже показаны найденные источники.</p>}
        {result.status === 'insufficient_evidence' && <p className={styles.status}>{INSUFFICIENT_DATA_ANSWER} Ниже показаны найденные фрагменты для проверки.</p>}
        {result.status === 'answered' && !!answer.claims.length && <article className={styles.publication}>
          <h3>Ответ</h3>
          {/* Citation markers are built here from each claim's own citationIds - never taken
              from the model's text - so the model cannot forge a trusted-looking [n]. */}
          {answer.claims.map((claim, i) => <p key={i}>{claim.text} {claim.citationIds.map(id => `[${id}]`).join('')}</p>)}
        </article>}
        <div>
          <h3>Источники</h3>
          <div className={styles.list}>{result.citations.map(c => <article key={c.chunkId} className={styles.publication}>
            <div className={styles.meta}>[{c.index}] · стр. {c.pageStart}–{c.pageEnd} · {c.year ?? 'Год не указан'}</div>
            <h4>{c.title}</h4>
            <p className={styles.authors}>{c.authors.join('; ') || 'Авторы не указаны'}</p>
            <dl className={styles.details}>
              <div><dt>DOI</dt><dd>{c.doi ? <a className={styles.link} href={`https://doi.org/${encodeURIComponent(c.doi)}`} target="_blank" rel="noreferrer">{c.doi}</a> : 'Не указан'}</dd></div>
              <div><dt>Файл</dt><dd>{c.filename}</dd></div>
            </dl>
            <a className={`button secondary ${styles.results}`} href={`/api/library/pdf?id=${c.documentId}#page=${c.pageStart}`} target="_blank" rel="noreferrer">Открыть PDF</a>
          </article>)}</div>
        </div>
        <button type="button" className="button secondary" onClick={() => setShowFragments(v => !v)}>
          {showFragments ? 'Скрыть найденные фрагменты' : 'Показать найденные фрагменты'}
        </button>
        {showFragments && <div className={styles.list}>{result.chunks.map(chunk => <article key={chunk.chunkId} className={styles.publication}>
          <div className={styles.meta}>стр. {chunk.pageStart}–{chunk.pageEnd} · релевантность {chunk.score.toFixed(4)}</div>
          <h4>{chunk.filename}</h4>
          <p>{chunk.snippet}</p>
        </article>)}</div>}
        {result.diagnostics && <details className={`${styles.status} ${styles.results}`}>
          <summary>Диагностика (development)</summary>
          <ul>
            <li>Найдено фрагментов: {result.diagnostics.chunksFound}</li>
            <li>Документов использовано: {result.diagnostics.documentsUsed.length}</li>
            <li>Размер контекста: {result.diagnostics.contextChars} символов{result.diagnostics.contextTruncated ? ' (обрезан по лимиту)' : ''}</li>
            <li>Время retrieval: {result.diagnostics.retrievalMs} мс</li>
            <li>Время generation: {result.diagnostics.generationMs} мс</li>
            <li>FTS score по чанкам: {result.diagnostics.scores.map(s => s.score.toFixed(4)).join(', ')}</li>
            {result.diagnostics.answerRejectedReason && <li>Ответ отклонён: {result.diagnostics.answerRejectedReason}</li>}
          </ul>
        </details>}
      </>}
    </div>}
  </section>;
}
