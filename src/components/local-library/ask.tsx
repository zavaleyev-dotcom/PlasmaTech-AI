'use client';
import { useState } from 'react';
import type { AnswerClaim, Citation, FusedChunk, RagDiagnostics, RagStatus, RetrievalMode } from '@/services/rag/types';
import { INSUFFICIENT_DATA_ANSWER } from '@/services/rag/prompt';
import styles from '@/components/scifinder/search.module.css';
interface AskResponse {
  question: string; limit: number; mode: RetrievalMode; status: RagStatus; chunks: FusedChunk[]; citations: Citation[];
  answer: { claims: AnswerClaim[]; configured: boolean; error: string | null };
  diagnostics?: RagDiagnostics;
}
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MODE_LABELS: Record<RetrievalMode, string> = { hybrid: 'Гибридный', semantic: 'По смыслу', lexical: 'По словам' };
const ORIGIN_LABELS: Record<FusedChunk['foundBy'], string> = { lexical: 'FTS', semantic: 'Semantic', both: 'FTS + Semantic' };
export function AskLibrary() {
  const [question, setQuestion] = useState('');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [mode, setMode] = useState<RetrievalMode>('hybrid');
  const [showFragments, setShowFragments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  // Captured at request time, separate from the live `mode` selector: the user may change
  // the selector before the next submit, and comparisons against a stale result must always
  // use the mode that result actually corresponds to, not whatever is currently selected.
  const [requestedMode, setRequestedMode] = useState<RetrievalMode>('hybrid');
  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setResult(null); setRequestedMode(mode);
    try {
      const response = await fetch('/api/library/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, limit, mode }), signal: AbortSignal.timeout(60_000),
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
      Ответ строится только на фрагментах, найденных в вашей локальной библиотеке - лексически (FTS5) и/или по смыслу
      (semantic embeddings, если построены) - без внешних знаний. Если данных недостаточно, так и будет сказано.
    </p>
    <form className={`${styles.publication} ${styles.results}`} onSubmit={e => void ask(e)}>
      <label className={`${styles.field} ${styles.full}`}>Вопрос к библиотеке
        <textarea className={styles.control} rows={3} maxLength={2000} value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Например: какие температуры осаждения AlTiSiN использовались для режущего инструмента?" />
      </label>
      <label className={styles.field}>Поиск
        <select className={styles.control} value={mode} onChange={e => setMode(e.target.value as RetrievalMode)}>
          {(['hybrid', 'semantic', 'lexical'] as const).map(m => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
        </select>
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
      {result.mode !== requestedMode && (requestedMode === 'hybrid' || requestedMode === 'semantic') &&
        <p className={styles.hint}>Семантический индекс пока не построен или недоступен - используется поиск по словам (FTS5).</p>}
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
          {/* F21: explicit, honest distinction - a [n] marker only proves the claim cites a
              real retrieved source (see "Источники" below for its actual excerpt); it is
              never a claim that the statement's truth was semantically checked. No entailment
              check runs in this app (that would require an external LLM call), so every claim
              here is always exactly "retrieved, semantic verification not run" - never
              "verified" or "proven". */}
          <p className={styles.hint}>Каждое утверждение подтверждено только тем, что оно ссылается на реально найденный фрагмент (см. текст фрагмента в «Источники» ниже). Смысловая проверка соответствия утверждения содержимому источника (semantic verification) не выполняется.</p>
          {answer.claims.map((claim, i) => <p key={i}>{claim.text} {claim.citationIds.map(id => `[${id}]`).join('')}</p>)}
        </article>}
        <div>
          <h3>Источники</h3>
          <div className={styles.list}>{result.citations.map(c => <article key={c.chunkId} className={styles.publication}>
            <div className={styles.meta}>[{c.index}] · стр. {c.pageStart}–{c.pageEnd} · {c.year ?? 'Год не указан'} · релевантность {c.score.toFixed(4)}</div>
            <h4>{c.title}</h4>
            <p className={styles.authors}>{c.authors.join('; ') || 'Авторы не указаны'}</p>
            <p className={styles.hint}>Найденный фрагмент (retrieved evidence): «{c.snippet}»</p>
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
          <div className={styles.meta}>
            стр. {chunk.pageStart}–{chunk.pageEnd} · релевантность {chunk.score.toFixed(4)}
            {result.diagnostics && <> · {ORIGIN_LABELS[chunk.foundBy]}</>}
          </div>
          <h4>{chunk.filename}</h4>
          <p>{chunk.snippet}</p>
        </article>)}</div>}
        {result.diagnostics && <details className={`${styles.status} ${styles.results}`}>
          <summary>Диагностика (development)</summary>
          <ul>
            <li>Режим поиска: {result.diagnostics.retrieval.mode}{result.diagnostics.retrieval.fallbackReason ? ` (${result.diagnostics.retrieval.fallbackReason})` : ''}</li>
            <li>Найдено фрагментов: {result.diagnostics.chunksFound} · FTS: {result.diagnostics.retrieval.ftsCandidates} · Semantic: {result.diagnostics.retrieval.semanticCandidates} · после fusion: {result.diagnostics.retrieval.fusedCandidates}</li>
            <li>Документов использовано: {result.diagnostics.documentsUsed.length}</li>
            <li>Размер контекста: {result.diagnostics.contextChars} символов{result.diagnostics.contextTruncated ? ' (обрезан по лимиту)' : ''}</li>
            <li>Время FTS: {result.diagnostics.retrieval.ftsMs} мс · Время semantic: {result.diagnostics.retrieval.semanticMs} мс · Время retrieval всего: {result.diagnostics.retrieval.totalMs} мс</li>
            <li>Время generation: {result.diagnostics.generationMs} мс</li>
            {result.diagnostics.retrieval.embeddingProviderId && <li>Embedding provider/model: {result.diagnostics.retrieval.embeddingProviderId} / {result.diagnostics.retrieval.embeddingModel}</li>}
            {result.diagnostics.retrieval.embeddingCoverage !== null && <li>Покрытие embedding-индекса: {(result.diagnostics.retrieval.embeddingCoverage * 100).toFixed(1)}%{result.diagnostics.retrieval.staleEmbeddingsCount ? ` · устаревших: ${result.diagnostics.retrieval.staleEmbeddingsCount}` : ''}</li>}
            <li>Fused score по чанкам: {result.diagnostics.scores.map(s => s.score.toFixed(4)).join(', ')}</li>
            {result.diagnostics.answerRejectedReason && <li>Ответ отклонён: {result.diagnostics.answerRejectedReason}</li>}
          </ul>
        </details>}
      </>}
    </div>}
  </section>;
}
