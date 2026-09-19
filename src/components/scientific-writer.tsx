'use client';

import { useEffect, useState } from 'react';
import {
  DOCUMENT_TYPES, WRITER_MODES, LANGUAGES, DOCUMENT_TYPE_LABELS, WRITER_MODE_LABELS,
  validateInput, buildEvidenceReport, buildLocalScaffold,
  type ScientificWriterInput, type DocumentType, type WriterMode, type Language,
  type EvidenceReport, type ScaffoldSection, type PreservationCheck,
} from '@/services/workspace/scientific-writer';

const REWRITE_LIKE_MODES: readonly WriterMode[] = ['rewrite', 'edit', 'translate_ru_en', 'translate_en_ru'];

interface FormState {
  documentType: DocumentType; mode: WriterMode; targetLanguage: Language;
  title: string; researchField: string; goal: string; researchObject: string;
  methods: string; results: string; conclusions: string; keywords: string;
  sourceText: string; additionalRequirements: string;
}

function defaultForm(): FormState {
  return {
    documentType: 'article', mode: 'draft', targetLanguage: 'en',
    title: '', researchField: '', goal: '', researchObject: '', methods: '', results: '', conclusions: '', keywords: '',
    sourceText: '', additionalRequirements: '',
  };
}

function toInput(form: FormState): ScientificWriterInput {
  const opt = (v: string) => v.trim() ? v.trim() : undefined;
  return {
    documentType: form.documentType, mode: form.mode, targetLanguage: form.targetLanguage,
    title: opt(form.title), researchField: opt(form.researchField), goal: opt(form.goal),
    researchObject: opt(form.researchObject), methods: opt(form.methods), results: opt(form.results),
    conclusions: opt(form.conclusions), keywords: opt(form.keywords), sourceText: opt(form.sourceText),
    additionalRequirements: opt(form.additionalRequirements),
  };
}

type GenerationState = 'idle' | 'loading' | 'done' | 'error' | 'not_configured';

interface GenerationResult {
  generatedText: string;
  evidence: EvidenceReport;
  preservation: PreservationCheck | null;
  changes: string[] | null;
}

export function ScientificWriter() {
  const [form, setForm] = useState<FormState>(defaultForm());
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);
  const [validationError, setValidationError] = useState('');
  const [state, setState] = useState<GenerationState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [scaffold, setScaffold] = useState<ScaffoldSection[] | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<EvidenceReport | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch('/api/workspace/scientific-writer').then(r => r.json()).then(body => setProviderConfigured(!!body.configured)).catch(() => setProviderConfigured(false));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function reset() {
    setForm(defaultForm());
    setValidationError(''); setState('idle'); setErrorMessage(''); setScaffold(null); setEvidencePreview(null); setResult(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError(''); setErrorMessage(''); setResult(null); setScaffold(null); setEvidencePreview(null);
    const input = toInput(form);
    try {
      validateInput(input);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Некорректные данные.');
      return;
    }

    const evidence = buildEvidenceReport(input);
    if (!REWRITE_LIKE_MODES.includes(form.mode)) {
      setScaffold(buildLocalScaffold(input, evidence));
      setEvidencePreview(evidence);
    }

    setState('loading');
    try {
      const response = await fetch('/api/workspace/scientific-writer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === 'not_configured') { setState('not_configured'); return; }
        throw new Error(body.error ?? 'Не удалось сформировать текст.');
      }
      setResult({ generatedText: body.generatedText, evidence: body.evidence, preservation: body.preservation, changes: body.changes });
      setState('done');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Не удалось сформировать текст.');
      setState('error');
    }
  }

  async function copyResult() {
    const text = result?.generatedText ?? scaffold?.map(s => `## ${s.heading}\n${s.text}`).join('\n\n') ?? '';
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable - nothing to fall back to */ }
  }

  const isRewriteLike = REWRITE_LIKE_MODES.includes(form.mode);

  return <div className="flex flex-col gap-6">
    {providerConfigured === false && <p role="status" className="content-card">
      ИИ-провайдер не настроен (нет OPENAI_API_KEY). Локальная сборка структуры из ваших данных всё равно доступна ниже - без ИИ-генерации текста.
    </p>}

    <form onSubmit={submit} className="flex flex-col gap-6">
      <fieldset className="content-card">
        <legend><h2>Тип документа, режим, язык</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Тип документа
            <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.documentType} onChange={e => set('documentType', e.target.value as DocumentType)}>
              {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="text-sm">Режим работы
            <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.mode} onChange={e => set('mode', e.target.value as WriterMode)}>
              {WRITER_MODES.map(m => <option key={m} value={m}>{WRITER_MODE_LABELS[m]}</option>)}
            </select>
          </label>
          <label className="text-sm">Целевой язык
            <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={form.targetLanguage} onChange={e => set('targetLanguage', e.target.value as Language)}>
              {LANGUAGES.map(l => <option key={l} value={l}>{l === 'ru' ? 'Русский' : 'English'}</option>)}
            </select>
          </label>
        </div>
      </fieldset>

      {isRewriteLike ? <fieldset className="content-card">
        <legend><h2>Исходный текст</h2></legend>
        <textarea required className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-2" rows={10} maxLength={20_000}
          value={form.sourceText} onChange={e => set('sourceText', e.target.value)}
          placeholder="Вставьте текст для переписывания, редактирования или перевода" />
      </fieldset> : <fieldset className="content-card">
        <legend><h2>Данные для черновика</h2></legend>
        <div className="content-grid mt-3">
          <label className="text-sm">Название / тема<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" maxLength={500} value={form.title} onChange={e => set('title', e.target.value)} /></label>
          <label className="text-sm">Область исследования<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" maxLength={500} value={form.researchField} onChange={e => set('researchField', e.target.value)} /></label>
          <label className="text-sm">Ключевые слова<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" maxLength={500} value={form.keywords} onChange={e => set('keywords', e.target.value)} /></label>
        </div>
        <div className="flex flex-col gap-3 mt-3">
          <label className="text-sm">Цель<textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} maxLength={20_000} value={form.goal} onChange={e => set('goal', e.target.value)} /></label>
          <label className="text-sm">Объект исследования<textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} maxLength={20_000} value={form.researchObject} onChange={e => set('researchObject', e.target.value)} /></label>
          <label className="text-sm">Методы<textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={3} maxLength={20_000} value={form.methods} onChange={e => set('methods', e.target.value)} /></label>
          <label className="text-sm">Основные результаты<textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={3} maxLength={20_000} value={form.results} onChange={e => set('results', e.target.value)} /></label>
          <label className="text-sm">Выводы<textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} maxLength={20_000} value={form.conclusions} onChange={e => set('conclusions', e.target.value)} /></label>
        </div>
      </fieldset>}

      <fieldset className="content-card">
        <legend><h2>Дополнительные требования</h2></legend>
        <textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={2} maxLength={20_000} value={form.additionalRequirements} onChange={e => set('additionalRequirements', e.target.value)}
          placeholder="Стиль, объём, особые пожелания" />
      </fieldset>

      <div className="flex gap-2">
        <button className="button primary" disabled={state === 'loading'}>{state === 'loading' ? 'Обработка…' : 'Сформировать'}</button>
        <button type="button" className="button secondary" onClick={reset}>Очистить</button>
        {(result || scaffold) && <button type="button" className="button secondary" onClick={copyResult}>Копировать результат</button>}
      </div>
      {validationError && <p role="alert">{validationError}</p>}
    </form>

    {state === 'not_configured' && <section className="content-card">
      <p role="alert">ИИ-генерация недоступна: OPENAI_API_KEY не настроен на сервере. Ниже показана только локальная структура, собранная из введённых вами данных - это не текст, сгенерированный ИИ.</p>
    </section>}
    {state === 'error' && <section className="content-card"><p role="alert">{errorMessage}</p></section>}

    {result && <section className="content-card" aria-live="polite">
      <h2>Результат (сгенерировано ИИ)</h2>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{result.generatedText}</pre>
      <h3 className="mt-3">Использованные данные</h3>
      <p className="muted small">Предоставлено: {result.evidence.provided.join(', ') || '—'}</p>
      <p className="muted small">Не задано: {result.evidence.missing.join(', ') || '—'}</p>
      {result.preservation && <>
        <h3 className="mt-3">Проверка сохранности чисел и терминов</h3>
        <p className={result.preservation.ok ? 'muted small' : undefined} role={result.preservation.ok ? undefined : 'alert'}>
          {result.preservation.ok ? 'Все числа и защищённые технические термины исходного текста сохранены.'
            : `Внимание: не найдены в результате - числа: ${result.preservation.missingNumbers.join(', ') || '—'}; термины: ${result.preservation.missingTerms.join(', ') || '—'}.`}
        </p>
      </>}
      {result.changes && <>
        <h3 className="mt-3">Существенные изменения</h3>
        <ul className="list-disc">{result.changes.map(c => <li key={c}>{c}</li>)}</ul>
      </>}
      {isRewriteLike && <>
        <h3 className="mt-3">Исходный текст</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{form.sourceText}</pre>
      </>}
    </section>}

    {scaffold && !result && <section className="content-card" aria-live="polite">
      <h2>Локальная структура (без ИИ)</h2>
      <p className="muted small">Собрано напрямую из введённых вами данных, без генерации текста.</p>
      {scaffold.map(section => <div key={section.heading} className="mt-3">
        <h3>{section.heading}</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{section.text}</pre>
      </div>)}
      {evidencePreview && <p className="muted small mt-3">Не задано: {evidencePreview.missing.join(', ') || '—'}</p>}
    </section>}

    <p className="muted small">Scientific Writer не заменяет проверку научных фактов: любые утверждения, цифры, цитаты и ссылки должны быть проверены автором перед публикацией. Система никогда не придумывает цитаты, DOI, авторов, журналы или экспериментальные результаты.</p>
  </div>;
}
