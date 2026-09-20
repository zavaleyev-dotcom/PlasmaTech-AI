'use client';

import { useState } from 'react';
import { MIN_INPUT_CHARS, MAX_INPUT_CHARS, type MatchType, type SimilarityMatch, type SimilarityScope } from '@/services/workspace/anti-plagiarism';

const MATCH_TYPE_LABELS: Record<MatchType, string> = {
  exact: 'Точное совпадение',
  near_exact: 'Почти дословное совпадение',
  similar: 'Высокая схожесть',
  self_repeat: 'Повтор внутри текста',
};

type CheckState = 'idle' | 'loading' | 'done' | 'empty_corpus' | 'error';

export function SimilarityCheck() {
  const [text, setText] = useState('');
  const [state, setState] = useState<CheckState>('idle');
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<SimilarityMatch[]>([]);
  const [scope, setScope] = useState<SimilarityScope | null>(null);
  const [disclaimer, setDisclaimer] = useState('');

  function reset() {
    setText(''); setState('idle'); setError(''); setMatches([]); setScope(null); setDisclaimer('');
  }

  async function check(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setMatches([]); setScope(null);
    if (!text.trim()) { setError('Введите текст для проверки.'); return; }
    if (text.trim().length < MIN_INPUT_CHARS) { setError(`Текст слишком короткий для проверки (минимум ${MIN_INPUT_CHARS} символов).`); return; }
    if (text.length > MAX_INPUT_CHARS) { setError(`Текст слишком длинный (максимум ${MAX_INPUT_CHARS} символов).`); return; }

    setState('loading');
    try {
      const response = await fetch('/api/workspace/anti-plagiarism', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Не удалось выполнить проверку.');
      setMatches(body.matches);
      setScope(body.scope);
      setDisclaimer(body.disclaimer);
      setState(body.scope?.corpusEmpty ? 'empty_corpus' : 'done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выполнить проверку.');
      setState('error');
    }
  }

  return <section className="content-card flex flex-col gap-4">
    <h2>Проверка схожести</h2>
    <p className="muted small">Проверка выполняется только по локальному корпусу PlasmaTech-AI (загруженные документы этого проекта) - это не проверка по всему интернету и не Antiplagiat.ru.</p>

    <form onSubmit={check} className="flex flex-col gap-3">
      <textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3" rows={8} maxLength={MAX_INPUT_CHARS}
        value={text} onChange={e => setText(e.target.value)} placeholder="Вставьте текст для проверки схожести с локальным корпусом" />
      <div className="flex gap-2">
        <button className="button primary" disabled={state === 'loading'}>{state === 'loading' ? 'Проверка…' : 'Проверить'}</button>
        <button type="button" className="button secondary" onClick={reset}>Очистить</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>

    {state === 'empty_corpus' && <p role="alert">Проверка невозможна: локальный корпус PlasmaTech-AI пуст (нет проиндексированных документов). Загрузите и проиндексируйте документы библиотеки, чтобы проверка стала доступна.</p>}

    {scope && state !== 'empty_corpus' && <div aria-live="polite">
      <h3>Сводка проверки</h3>
      <ul className="list-disc">
        <li>Документов в корпусе: {scope.corpusSize.documents}, chunks: {scope.corpusSize.chunks}</li>
        <li>Реально проверено документов: {scope.documentsChecked}, chunks: {scope.chunksChecked}</li>
        <li>Предложений во входном тексте: {scope.sentencesChecked}, абзацев: {scope.paragraphsChecked}</li>
        <li>Точных совпадений: {scope.exactMatches}</li>
        <li>Почти дословных совпадений: {scope.nearExactMatches}</li>
        <li>Совпадений высокой схожести: {scope.similarMatches}</li>
        <li>Повторов внутри текста: {scope.selfRepeats}</li>
        <li>Доля текста, покрытая найденными совпадениями в проверенном локальном корпусе: {(scope.coveredFraction * 100).toFixed(1)}%</li>
      </ul>

      {matches.length === 0 ? <p>Совпадений не найдено.</p> : <div className="flex flex-col gap-3 mt-3">
        {matches.map((m, i) => <article key={i} className="content-card">
          <p><strong>{MATCH_TYPE_LABELS[m.type]}</strong> - similarity: {(m.score * 100).toFixed(0)}%</p>
          <p className="muted small">Ваш фрагмент:</p>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{m.inputSpan}</pre>
          <p className="muted small">{m.type === 'self_repeat' ? 'Повторяется с фрагментом того же текста:' : 'Совпавший фрагмент источника:'}</p>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{m.sourceSpan}</pre>
          {m.type !== 'self_repeat' && <p className="muted small">
            Источник: {m.documentTitle ?? m.relativePath ?? '—'}{m.pageStart !== null && ` (стр. ${m.pageStart}${m.pageEnd !== null && m.pageEnd !== m.pageStart ? `–${m.pageEnd}` : ''})`}
          </p>}
        </article>)}
      </div>}

      <p className="muted small mt-3">{disclaimer}</p>
    </div>}
  </section>;
}
