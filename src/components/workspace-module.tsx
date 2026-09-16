'use client';

import { useState, type FormEvent } from 'react';
import type { Tool } from '@/lib/content';
import { workspaceService, type WorkspaceResult } from '@/services/workspace';
import { Icon } from './icon';

export function WorkspaceModule({ tool, example }: { tool: Tool; example: string }) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<WorkspaceResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function updateInput(value: string) {
    setInput(value);
    setResult(null);
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await workspaceService.run(tool, input));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось подготовить пример. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content-grid">
      <section className="content-card">
        <h2>Ваша задача</h2>
        <form onSubmit={submit} className="flex flex-col gap-4 mt-5">
          <label htmlFor="module-task" className="text-sm">Опишите задачу</label>
          <textarea
            id="module-task"
            className="w-full resize-y rounded-md border border-[#dce0e5] p-3 text-base leading-relaxed focus:outline-2 focus:outline-[#eda183]"
            rows={6}
            maxLength={4000}
            required
            disabled={busy}
            value={input}
            onChange={event => updateInput(event.target.value)}
            placeholder={tool.placeholder}
            aria-describedby="module-demo-note"
          />
          <p id="module-demo-note" className="muted small">Запрос не отправляется на сервер и не сохраняется. Результат — фиксированный учебный пример.</p>
          <button className="button primary self-start" disabled={busy || !input.trim()}>
            {busy ? 'Подготовка…' : 'Показать пример'} <Icon name="sparkles" size={17} />
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
        <div className="demo-result">
          <h3>Демонстрационный пример задачи</h3>
          <p>{example}</p>
          <button type="button" className="button secondary mt-4" disabled={busy} onClick={() => updateInput(example)}>
            Использовать пример
          </button>
        </div>
      </section>
      <section className="content-card" aria-labelledby="module-result-heading" aria-busy={busy}>
        <h2 id="module-result-heading">Результат <span className="mode-badge">DEMO</span></h2>
        <div aria-live="polite" aria-atomic="true">
          {result ? (
            <div className="demo-result">
              <h3>{result.title}</h3>
              <ul className="list-disc">{result.items.map(item => <li key={item}>{item}</li>)}</ul>
              <p>{result.notice}</p>
            </div>
          ) : <p className="mt-5">{busy ? 'Подготовка примера…' : 'Введите задачу или используйте демонстрационный пример. Здесь появится образец результата.'}</p>}
        </div>
      </section>
    </div>
  );
}
