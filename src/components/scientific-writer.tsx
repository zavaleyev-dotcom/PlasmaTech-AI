'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DOCUMENT_TYPES, WRITER_MODES, LANGUAGES, DOCUMENT_TYPE_LABELS, WRITER_MODE_LABELS,
  validateInput, buildEvidenceReport, buildLocalScaffold,
  type ScientificWriterInput, type DocumentType, type WriterMode, type Language,
  type EvidenceReport, type ScaffoldSection,
} from '@/services/workspace/scientific-writer';
import {
  checkProviderStatus, classifyBodyReadFailure, classifyGenerationException, classifyGenerationResponse, classifyUnexpectedSuccess, describeProviderStatus, parseGenerationBody, readResponseBody, type ProviderStatus,
} from '@/services/workspace/scientific-writer-status';
import { SimilarityCheck } from './anti-plagiarism';
import { ReferenceManager } from './reference-manager';
import { peekPendingReferences, clearPendingReferences } from '@/services/workspace/scifinder-import';
import {
  applyGenerationOutcome, createAutosave, createDraftPersistence, createGenerationGuard, defaultDraftContent, defaultDraftForm, detectDraftStore, isResultStale,
  type Autosave, type DraftContent, type DraftForm, type DraftGenerationResult, type DraftPersistence, type GenerationOutcome, type SaveOutcome,
} from '@/services/workspace/scientific-writer-draft-store';
import { loadReferences, saveReferences, mergeReferencesById } from '@/services/workspace/scientific-writer-references-store';
import type { Reference, CitationStyle, DocumentProfileId } from '@/services/workspace/references';

const REWRITE_LIKE_MODES: readonly WriterMode[] = ['rewrite', 'edit', 'translate_ru_en', 'translate_en_ru'];

type FormState = DraftForm;

const defaultForm = defaultDraftForm;

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

type GenerationState = 'idle' | 'loading' | 'done' | 'not_configured' | 'unavailable' | 'error';
type ExportState = 'idle' | 'generating' | 'done' | 'error';

type GenerationResult = DraftGenerationResult;

/** The state of the local draft shown to the user. The draft lives only in this browser: it is not sent anywhere, not encrypted and not backed up. */
type DraftStatus =
  | { kind: 'loading' } | { kind: 'new' } | { kind: 'restored'; savedAt: string } | { kind: 'saved'; savedAt: string }
  | { kind: 'unreadable' } | { kind: 'unavailable' } | { kind: 'read_failed' } | { kind: 'conflict' }
  | { kind: 'failed'; reason: 'quota' | 'error' | 'quarantine_failed' | 'quarantine_occupied' };

const timeOf = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };

export function ScientificWriter() {
  const [form, setForm] = useState<FormState>(defaultForm());
  // What is KNOWN about the AI provider: configured / not configured (only when the server said so) / the check itself failed (and why).
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({ kind: 'checking' });
  const [validationError, setValidationError] = useState('');
  const [state, setState] = useState<GenerationState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [scaffold, setScaffold] = useState<ScaffoldSection[] | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<EvidenceReport | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [exportFormat, setExportFormat] = useState<'docx' | 'pdf'>('docx');
  const [exportState, setExportState] = useState<ExportState>('idle');
  const [exportError, setExportError] = useState('');
  const [references, setReferences] = useState<Reference[]>([]);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>('apa');
  const [profileId, setProfileId] = useState<DocumentProfileId>('generic_article');
  // Guards the auto-save effect below from firing (and overwriting real saved data with an
  // empty array) before the load-on-mount effect has actually run once.
  const referencesHydrated = useRef(false);
  // Local draft (P1 fix): the form, the structure, the result and the options are restored after navigating away, a refresh or reopening the tab.
  const [generatedFrom, setGeneratedFrom] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>({ kind: 'loading' });
  const persistence = useRef<DraftPersistence | null>(null);
  const autosave = useRef<Autosave | null>(null);
  const latestContent = useRef<DraftContent>(defaultDraftContent());
  const generationGuard = useRef(createGenerationGuard());
  const content = useMemo<DraftContent>(() => ({ form, citationStyle, profileId, exportFormat, scaffold, evidencePreview, result, generatedFrom }),
    [form, citationStyle, profileId, exportFormat, scaffold, evidencePreview, result, generatedFrom]);

  const announce = useCallback((outcome: SaveOutcome): void => {
    if (outcome.ok) setDraftStatus({ kind: 'saved', savedAt: outcome.savedAt });
    else if (outcome.reason === 'unavailable') setDraftStatus({ kind: 'unavailable' });
    else if (outcome.reason === 'quota' || outcome.reason === 'error' || outcome.reason === 'quarantine_failed' || outcome.reason === 'quarantine_occupied') setDraftStatus({ kind: 'failed', reason: outcome.reason });
  }, []);

  // Applies a successfully read draft to the screen.
  const applyRestored = useCallback((d: Extract<ReturnType<DraftPersistence['hydrate']>, { status: 'restored' }>['draft']): void => {
    setForm(d.form); setCitationStyle(d.citationStyle); setProfileId(d.profileId); setExportFormat(d.exportFormat);
    setScaffold(d.scaffold); setEvidencePreview(d.evidencePreview); setResult(d.result); setGeneratedFrom(d.generatedFrom);
    setDraftStatus({ kind: 'restored', savedAt: d.savedAt });
  }, []);

  const showLoaded = useCallback((loaded: ReturnType<DraftPersistence['hydrate']>): void => {
    if (loaded.status === 'restored') applyRestored(loaded.draft);
    else if (loaded.status === 'unavailable') setDraftStatus({ kind: 'unavailable' });
    else if (loaded.status === 'read_failed') setDraftStatus({ kind: 'read_failed' });
    else if (loaded.status === 'empty') setDraftStatus({ kind: 'new' });
    else setDraftStatus({ kind: 'unreadable' });
  }, [applyRestored]);

  // Restore on mount (browser only: nothing touches storage during server rendering). Saving opens only after a SUCCESSFUL read of what was stored, so the initial empty
  // values can never overwrite a saved draft, and a failed read never opens writing. On leaving (unmount, `pagehide`) whatever is still waiting is saved at once.
  useEffect(() => {
    const t = setTimeout(() => {
      const p = createDraftPersistence(detectDraftStore);          // the function itself: every retry looks for the storage again
      persistence.current = p;
      autosave.current = createAutosave(p, announce);
      const loaded = p.hydrate();
      showLoaded(loaded);
      // typing that happened while an EMPTY/unreadable draft was being read is not lost (a restored draft is never replaced by the content of the first render)
      if (loaded.status !== 'restored') autosave.current.update(latestContent.current);
    }, 0);
    const leave = () => autosave.current?.flush();
    window.addEventListener('pagehide', leave);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pagehide', leave);
      autosave.current?.flush();
      autosave.current = null; persistence.current = null;
    };
  }, [announce, showLoaded]);

  // Automatic saving a moment after the last change.
  useEffect(() => {
    latestContent.current = content;
    autosave.current?.update(content);
  }, [content]);

  // Another attempt to read the stored draft after a failed read. If the user has already typed something, the stored draft is NOT adopted (it would replace their text); it is
  // put aside in the backup slot before the first new save.
  function retryRead() {
    const p = persistence.current;
    if (!p) return;
    const pristine = JSON.stringify(latestContent.current) === JSON.stringify(defaultDraftContent());
    const loaded = p.hydrate({ keepExisting: !pristine });
    if (loaded.status === 'restored' && !pristine) { setDraftStatus({ kind: 'conflict' }); autosave.current?.update(latestContent.current); return; }
    showLoaded(loaded);
    if (p.isHydrated()) autosave.current?.update(latestContent.current);
  }

  const runStatusCheck = useCallback((): void => {
    setProviderStatus({ kind: 'checking' });
    void checkProviderStatus().then(setProviderStatus);
  }, []);

  useEffect(() => {
    const t = setTimeout(runStatusCheck, 0);
    return () => clearTimeout(t);
  }, [runStatusCheck]);

  // F02 fix: references (manual AND SciFinder-imported) now live in Scientific Writer's own
  // durable local store, not only in React state - so they survive unmount/remount. On mount:
  // restore whatever was already saved, merge in anything queued from SciFinder since last
  // time, and only mark that queue as delivered once the merge is confirmed durably saved -
  // never based merely on having handed it to this component once.
  useEffect(() => {
    const t = setTimeout(() => {
      const saved = loadReferences();
      const pending = peekPendingReferences();
      if (pending.length > 0) {
        const merged = mergeReferencesById(saved, pending);
        setReferences(merged);
        if (saveReferences(merged)) clearPendingReferences(pending.map(r => r.id));
        // else: leave the queue intact - the merged view is still shown this session, and the
        // next mount will retry persisting/clearing it.
      } else {
        setReferences(saved);
      }
      referencesHydrated.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Every subsequent change (manual add/edit/delete, or a later SciFinder import) is saved
  // immediately - references never rely on an explicit "Save" action to survive navigation.
  useEffect(() => {
    if (!referencesHydrated.current) return;
    saveReferences(references);
  }, [references]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  // Clears the DRAFT of this tool (after a confirmation): the form, the structure, the result and the options. The bibliography and the data of other tools are not touched.
  function clearDraft() {
    if (!window.confirm('Очистить черновик? Будут удалены введённые данные, структура и результат НаучПисателя из этого браузера. Библиография и данные других инструментов не затрагиваются. Действие нельзя отменить.')) return;
    generationGuard.current.invalidate();                       // an answer that is still on its way must not bring the cleared draft back
    autosave.current?.cancel();                                 // a waiting save must not write the deleted draft back
    const outcome = persistence.current ? persistence.current.clear() : null;
    setForm(defaultForm()); setCitationStyle('apa'); setProfileId('generic_article'); setExportFormat('docx'); setGeneratedFrom(null);
    setValidationError(''); setState('idle'); setErrorMessage(''); setScaffold(null); setEvidencePreview(null); setResult(null); setExportState('idle'); setExportError('');
    if (!outcome) setDraftStatus({ kind: 'unavailable' });
    else if (outcome.ok) setDraftStatus({ kind: 'new' });
    else if (outcome.reason === 'not_hydrated') setDraftStatus({ kind: 'read_failed' });
    else if (outcome.reason === 'unavailable') setDraftStatus({ kind: 'unavailable' });
    else setDraftStatus({ kind: 'failed', reason: outcome.reason });
  }

  // The shown result is replaced only by a newer SUCCESSFUL one (see applyGenerationOutcome): an error or an invalid input leaves the previous result, its structure and the
  // snapshot it was made for exactly as they were.
  function applyOutcome(outcome: GenerationOutcome) {
    const next = applyGenerationOutcome({ scaffold: latestContent.current.scaffold, evidencePreview: latestContent.current.evidencePreview, result: latestContent.current.result, generatedFrom: latestContent.current.generatedFrom }, outcome);
    setScaffold(next.scaffold); setEvidencePreview(next.evidencePreview); setResult(next.result); setGeneratedFrom(next.generatedFrom);
  }

  async function generate(input: ScientificWriterInput, snapshot: string, local: { scaffold: ScaffoldSection[] | null; evidence: EvidenceReport | null }) {
    const token = generationGuard.current.begin();
    setState('loading');
    const failure: GenerationOutcome = { kind: 'failure', scaffold: local.scaffold, evidencePreview: local.evidence, snapshot };
    const fail = (f: { state: 'not_configured' | 'unavailable' | 'error'; message: string }) => { setErrorMessage(f.message); setState(f.state); applyOutcome(failure); };
    let response: Response;
    try {
      response = await fetch('/api/workspace/scientific-writer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
    } catch (error) {
      if (!generationGuard.current.isCurrent(token)) return;
      fail(classifyGenerationException(error));                 // no answer at all: the network, a stopped server, a timeout - said as exactly that
      return;
    }
    const read = await readResponseBody(response);               // an error page is "not JSON"; a timeout or a dropped connection while reading is neither "bad JSON" nor "no connection"
    if (!generationGuard.current.isCurrent(token)) return;       // the draft was cleared or a newer request started: this answer is outdated and is not applied
    if (read.kind === 'read_failed') { fail(classifyBodyReadFailure(read.failure)); return; }
    const body = read.kind === 'json' ? read.value : undefined;
    if (!response.ok) { fail(classifyGenerationResponse(response.status, body)); return; }
    // A successful answer is applied only if it is complete and well-formed as a whole; otherwise nothing of it is used and the previous result stays untouched.
    const parsed = parseGenerationBody(body);
    if (!parsed) { fail(classifyUnexpectedSuccess()); return; }
    applyOutcome({ kind: 'success', snapshot, scaffold: local.scaffold, evidencePreview: local.evidence, result: parsed });
    setState('done');
  }

  // One path for "Сформировать" and "Повторить". Nothing shown is cleared before the new request has finished.
  async function start() {
    setValidationError(''); setErrorMessage('');
    const input = toInput(form);
    try {
      validateInput(input);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Некорректные данные.');
      applyOutcome({ kind: 'invalid_input' });                // the previous result stays
      return;
    }
    const evidence = buildEvidenceReport(input);
    const local = REWRITE_LIKE_MODES.includes(form.mode) ? { scaffold: null, evidence: null } : { scaffold: buildLocalScaffold(input, evidence), evidence };
    await generate(input, JSON.stringify(form), local);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await start();
  }

  async function retry() {
    await start();
  }

  async function copyResult() {
    const text = result?.generatedText ?? scaffold?.map(s => `## ${s.heading}\n${s.text}`).join('\n\n') ?? '';
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable - nothing to fall back to */ }
  }

  function buildExportPayload() {
    const referenceFields = { references: references.length ? references : undefined, citationStyle, profileId };
    if (result) {
      return {
        documentType: form.documentType, title: form.title || undefined, generatedByAI: true,
        sections: [{ heading: '', text: result.generatedText }],
        providedFields: result.evidence.provided, missingFields: result.evidence.missing, warnings: result.warnings,
        ...referenceFields,
      };
    }
    if (scaffold) {
      return {
        documentType: form.documentType, title: form.title || undefined, generatedByAI: false,
        sections: scaffold.map(s => ({ heading: s.heading, text: s.text })),
        providedFields: evidencePreview?.provided ?? [], missingFields: evidencePreview?.missing ?? [], warnings: [] as string[],
        ...referenceFields,
      };
    }
    return null;
  }

  async function exportDocument() {
    const payload = buildExportPayload();
    if (!payload) return;
    setExportState('generating'); setExportError('');
    try {
      const response = await fetch('/api/workspace/scientific-writer/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: payload, format: exportFormat }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Не удалось сформировать файл.');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      const filename = match ? decodeURIComponent(match[1]) : `document.${exportFormat}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setExportState('done');
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Не удалось сформировать файл.');
      setExportState('error');
    }
  }

  const isRewriteLike = REWRITE_LIKE_MODES.includes(form.mode);
  const resultStale = isResultStale(generatedFrom, form);
  const canExport = !!(result || scaffold);

  return <div className="flex flex-col gap-6">
    {describeProviderStatus(providerStatus) !== null && <div role="status" className="content-card" data-testid="provider-status">
      <p>{describeProviderStatus(providerStatus)}</p>
      {providerStatus.kind === 'check_failed' && <button type="button" className="button secondary mt-2" onClick={runStatusCheck}>Проверить снова</button>}
    </div>}

    <section className="content-card" role="status" aria-live="polite" data-testid="draft-status">
      <p className="small">
        <strong>Черновик сохраняется автоматически только в этом браузере</strong> (локально, на сервер и в сторонние сервисы не отправляется). Он не шифруется и не копируется в резерв:
        доступен всем, кто работает в этом профиле браузера, и пропадёт при очистке данных сайта.
      </p>
      <p className="muted small">
        {draftStatus.kind === 'loading' && 'Проверяю сохранённый черновик…'}
        {draftStatus.kind === 'new' && 'Сохранённого черновика нет — изменения будут сохраняться автоматически.'}
        {draftStatus.kind === 'restored' && `Черновик восстановлен (сохранён в ${timeOf(draftStatus.savedAt)}).`}
        {draftStatus.kind === 'saved' && `Сохранено в ${timeOf(draftStatus.savedAt)}.`}
        {draftStatus.kind === 'unavailable' && 'Локальное хранилище браузера недоступно: черновик пока не сохраняется и пропадёт при обновлении страницы. Введённые данные остаются на экране; если доступ был временно закрыт, можно повторить попытку.'}
        {draftStatus.kind === 'read_failed' && 'Не удалось прочитать сохранённый черновик (возможно, временно). Сохранение приостановлено, чтобы не затереть его; ранее сохранённые данные не удалены.'}
        {draftStatus.kind === 'conflict' && 'Найден ранее сохранённый черновик, но вы уже начали новый ввод. Он не загружен и будет перемещён в отдельную ячейку хранилища перед первым новым сохранением.'}
        {draftStatus.kind === 'unreadable' && 'Ранее сохранённый черновик повреждён или создан другой версией и не загружен. Он будет перемещён в отдельную ячейку хранилища перед первым новым сохранением.'}
        {draftStatus.kind === 'failed' && draftStatus.reason === 'quota' && 'Не удалось сохранить: хранилище браузера переполнено. Данные на экране не потеряны, но при закрытии страницы они пропадут; освободите место или сохраните текст отдельно.'}
        {draftStatus.kind === 'failed' && draftStatus.reason === 'error' && 'Не удалось сохранить черновик. Данные на экране не потеряны; повторная попытка будет при следующем изменении.'}
        {draftStatus.kind === 'failed' && draftStatus.reason === 'quarantine_occupied' && 'Резервная ячейка уже занята другим сохранённым документом, который не удаляется автоматически. Новые изменения не сохраняются, чтобы не уничтожить данные. Скопируйте нужный текст отдельно.'}
        {draftStatus.kind === 'failed' && draftStatus.reason === 'quarantine_failed' && 'Ранее сохранённые нераспознанные данные нельзя безопасно отложить, поэтому новые изменения не сохраняются, чтобы не стереть их.'}
      </p>
      {(draftStatus.kind === 'read_failed' || draftStatus.kind === 'unavailable') && <button type="button" className="button secondary mt-2" onClick={retryRead}>Повторить чтение черновика</button>}
    </section>

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

      <div className="flex gap-2 flex-wrap">
        <button className="button primary" disabled={state === 'loading'}>{state === 'loading' ? 'Обработка…' : 'Сформировать'}</button>
        <button type="button" className="button secondary" onClick={clearDraft}>Очистить черновик</button>
        {(result || scaffold) && <button type="button" className="button secondary" onClick={copyResult}>Копировать результат</button>}
      </div>
      {validationError && <p role="alert">{validationError}</p>}
    </form>

    {state === 'not_configured' && <section className="content-card">
      <p role="alert">{errorMessage} {result ? 'Прежний успешный результат сохранён и показан ниже.' : 'Ниже показана только локальная структура, собранная из введённых вами данных - это не текст, сгенерированный ИИ.'}</p>
    </section>}
    {state === 'unavailable' && <section className="content-card">
      <p role="alert">{errorMessage}</p>
      <button type="button" className="button secondary mt-2" onClick={retry}>Повторить</button>
    </section>}
    {state === 'error' && <section className="content-card">
      <p role="alert">{errorMessage}</p>
      <button type="button" className="button secondary mt-2" onClick={retry}>Повторить</button>
    </section>}

    {result && <section className="content-card" aria-live="polite">
      <h2>Результат (сгенерировано ИИ)</h2>
      {resultStale && <p role="status" className="muted small">Данные формы изменены после генерации: этот результат получен для прежних данных. Нажмите «Сформировать», чтобы обновить.</p>}
      {result.warnings.length > 0 && <div role="alert" className="content-card">
        <h3>Предупреждения проверки</h3>
        <ul className="list-disc">{result.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      </div>}
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
      {resultStale && <p role="status" className="muted small">Данные формы изменены после сборки структуры: она получена для прежних данных. Нажмите «Сформировать», чтобы обновить.</p>}
      <p className="muted small">Собрано напрямую из введённых вами данных, без генерации текста.</p>
      {scaffold.map(section => <div key={section.heading} className="mt-3">
        <h3>{section.heading}</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{section.text}</pre>
      </div>)}
      {evidencePreview && <p className="muted small mt-3">Не задано: {evidencePreview.missing.join(', ') || '—'}</p>}
    </section>}

    <section className="content-card">
      <h2>Экспорт документа</h2>
      <p className="muted small">Экспортируется именно текущий результат ({result ? 'сгенерированный ИИ' : scaffold ? 'локальная структура без ИИ' : 'пока отсутствует'}) - сначала нажмите «Сформировать» выше.</p>
      <div className="flex gap-2 items-end mt-3">
        <label className="text-sm">Формат
          <select className="rounded-md border border-[#dce0e5] p-3 mt-1 block" value={exportFormat} onChange={e => setExportFormat(e.target.value as 'docx' | 'pdf')}>
            <option value="docx">DOCX</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        <button type="button" className="button primary" disabled={!canExport || exportState === 'generating'} onClick={exportDocument}>
          {exportState === 'generating' ? 'Формирование…' : 'Экспортировать'}
        </button>
      </div>
      {exportState === 'done' && <p role="status" className="mt-2">Файл сформирован и скачан.</p>}
      {exportState === 'error' && <p role="alert" className="mt-2">{exportError}</p>}
    </section>

    <ReferenceManager
      references={references} onChangeReferences={setReferences}
      citationStyle={citationStyle} onChangeCitationStyle={setCitationStyle}
      profileId={profileId} onChangeProfileId={setProfileId}
    />

    <SimilarityCheck />

    <p className="muted small">Scientific Writer не заменяет проверку научных фактов: любые утверждения, цифры, цитаты и ссылки должны быть проверены автором перед публикацией. Система никогда не придумывает цитаты, DOI, авторов, журналы или экспериментальные результаты.</p>
  </div>;
}
