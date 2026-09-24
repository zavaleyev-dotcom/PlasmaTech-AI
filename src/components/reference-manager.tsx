'use client';

import { useState } from 'react';
import {
  REFERENCE_TYPES, REFERENCE_TYPE_LABELS, CITATION_STYLES, CITATION_STYLE_LABELS,
  DOCUMENT_PROFILES, FORMATTING_PROFILES,
  createReference, removeReference, updateReference, duplicateReference, moveReference,
  checkReferenceList, buildBibliography, formatInText, referenceNumber,
  type Reference, type ReferenceType, type CitationStyle, type DocumentProfileId,
} from '@/services/workspace/references';
// F19: the SAME shared DOI normalizer used everywhere else (SciFinder search dedup,
// scifinder-import.ts, references.ts's own duplicate check) - never a second regexp.
import { normalizeDoi } from '@/services/scientific-search/normalization';

interface ReferenceManagerProps {
  references: Reference[];
  onChangeReferences: (refs: Reference[]) => void;
  citationStyle: CitationStyle;
  onChangeCitationStyle: (style: CitationStyle) => void;
  profileId: DocumentProfileId;
  onChangeProfileId: (id: DocumentProfileId) => void;
}

function emptyDraft(type: ReferenceType): Reference {
  return createReference(type);
}

export function ReferenceManager({ references, onChangeReferences, citationStyle, onChangeCitationStyle, profileId, onChangeProfileId }: ReferenceManagerProps) {
  const [draft, setDraft] = useState<Reference | null>(null);
  const [citedIds, setCitedIds] = useState<Set<string>>(new Set());

  const isEditingExisting = draft ? references.some(r => r.id === draft.id) : false;

  function startAdd() {
    setDraft(emptyDraft('journal_article'));
  }
  function startEdit(ref: Reference) {
    setDraft({ ...ref, authors: [...ref.authors] });
  }
  function cancelDraft() {
    setDraft(null);
  }
  function saveDraft() {
    if (!draft) return;
    if (isEditingExisting) onChangeReferences(updateReference(references, draft.id, draft));
    else onChangeReferences([...references, draft]);
    setDraft(null);
  }

  function setDraftField<K extends keyof Reference>(key: K, value: Reference[K]) {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev));
  }

  function toggleCited(id: string) {
    setCitedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const check = checkReferenceList(references, Array.from(citedIds));
  const bibliography = buildBibliography(references, citationStyle);

  return <section className="content-card">
    <h2>Источники и оформление</h2>
    <p className="muted small">
      Только реально введённые вами данные - без автоматического поиска литературы, без обращения к Crossref/DOI-серверам и без выдуманных источников.
      DOI проверяется только по формату, без внешнего запроса.
    </p>

    <div className="content-grid mt-3">
      <label className="text-sm">Стиль оформления ссылок
        <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={citationStyle} onChange={e => onChangeCitationStyle(e.target.value as CitationStyle)}>
          {CITATION_STYLES.map(s => <option key={s} value={s}>{CITATION_STYLE_LABELS[s]}</option>)}
        </select>
      </label>
      <label className="text-sm">Профиль оформления документа
        <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={profileId} onChange={e => onChangeProfileId(e.target.value as DocumentProfileId)}>
          {DOCUMENT_PROFILES.map(p => <option key={p} value={p}>{FORMATTING_PROFILES[p].label}</option>)}
        </select>
      </label>
    </div>
    <p className="muted small mt-1">{FORMATTING_PROFILES[profileId].description} Профиль не заявляет соответствие требованиям конкретного журнала.</p>

    <div className="mt-4">
      <h3>Список источников ({references.length})</h3>
      {references.length === 0 && <p className="muted small">Источники ещё не добавлены.</p>}
      <ul className="flex flex-col gap-3 mt-2">
        {bibliography.entries.map(({ reference, text }, displayIndex) => {
          const number = referenceNumber(references, reference.id);
          return <li key={reference.id} className="rounded-md border border-[#dce0e5] p-3">
            <div className="flex justify-between items-start gap-2">
              <div>
                <p className="small"><strong>{REFERENCE_TYPE_LABELS[reference.type]}</strong>{bibliography.numbered && number !== null ? ` · №${number} в списке` : ` · позиция ${displayIndex + 1} в APA-списке`}
                  {reference.provenance?.source === 'scifinder' && <span className="mode-badge" style={{ marginLeft: '0.5em' }}>Источник: SciFinder ({reference.provenance.provider})</span>}
                </p>
                <p className="mt-1">{text}</p>
                <p className="muted small mt-1">В тексте: {formatInText(references, reference.id, citationStyle)}</p>
              </div>
              <label className="text-xs flex items-center gap-1 whitespace-nowrap">
                <input type="checkbox" checked={citedIds.has(reference.id)} onChange={() => toggleCited(reference.id)} />
                процитировано
              </label>
            </div>
            <div className="flex gap-2 mt-2 flex-wrap">
              <button type="button" className="button secondary" onClick={() => startEdit(reference)}>Редактировать</button>
              <button type="button" className="button secondary" onClick={() => onChangeReferences(duplicateReference(references, reference.id))}>Дублировать</button>
              <button type="button" className="button secondary" onClick={() => onChangeReferences(moveReference(references, reference.id, 'up'))}>▲</button>
              <button type="button" className="button secondary" onClick={() => onChangeReferences(moveReference(references, reference.id, 'down'))}>▼</button>
              <button type="button" className="button secondary" onClick={() => { onChangeReferences(removeReference(references, reference.id)); setCitedIds(prev => { const n = new Set(prev); n.delete(reference.id); return n; }); }}>Удалить</button>
            </div>
          </li>;
        })}
      </ul>
    </div>

    {(check.errors.length > 0 || check.warnings.length > 0) && <div className="mt-3">
      {check.errors.length > 0 && <div role="alert" className="content-card">
        <h4>Ошибки в списке источников</h4>
        <ul className="list-disc">{check.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
      </div>}
      {check.warnings.length > 0 && <div className="content-card mt-2">
        <h4>Предупреждения</h4>
        <ul className="list-disc">{check.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
      </div>}
    </div>}

    {!draft && <button type="button" className="button primary mt-3" onClick={startAdd}>Добавить источник</button>}

    {draft && <div className="content-card mt-3">
      <h3>{isEditingExisting ? 'Редактирование источника' : 'Новый источник'}</h3>
      <div className="content-grid mt-2">
        <label className="text-sm">Тип
          <select className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.type} onChange={e => setDraftField('type', e.target.value as ReferenceType)}>
            {REFERENCE_TYPES.map(t => <option key={t} value={t}>{REFERENCE_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="text-sm">Год<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.year ?? ''} onChange={e => setDraftField('year', e.target.value.trim() ? Number(e.target.value) : undefined)} /></label>
        <label className="text-sm">Том<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.volume ?? ''} onChange={e => setDraftField('volume', e.target.value || undefined)} /></label>
        <label className="text-sm">Номер (issue)<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.issue ?? ''} onChange={e => setDraftField('issue', e.target.value || undefined)} /></label>
        <label className="text-sm">Страницы<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.pages ?? ''} onChange={e => setDraftField('pages', e.target.value || undefined)} /></label>
        <label className="text-sm">DOI<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.doi ?? ''} onChange={e => setDraftField('doi', e.target.value || undefined)}
          onBlur={() => { const normalized = draft.doi ? normalizeDoi(draft.doi) : null; if (normalized) setDraftField('doi', normalized); }}
          placeholder="10.xxxx/... (также принимает doi: и ссылки doi.org - будут приведены к каноническому виду)" /></label>
        <label className="text-sm">URL<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.url ?? ''} onChange={e => setDraftField('url', e.target.value || undefined)} /></label>
        <label className="text-sm">Дата обращения<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.accessDate ?? ''} onChange={e => setDraftField('accessDate', e.target.value || undefined)} /></label>
        <label className="text-sm">Язык<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.language ?? ''} onChange={e => setDraftField('language', e.target.value || undefined)} /></label>
      </div>
      <label className="text-sm block mt-2">Название<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.title ?? ''} onChange={e => setDraftField('title', e.target.value || undefined)} /></label>
      <label className="text-sm block mt-2">Журнал / конференция / издательство<input className="w-full rounded-md border border-[#dce0e5] p-3 mt-1" value={draft.containerTitle ?? ''} onChange={e => setDraftField('containerTitle', e.target.value || undefined)} /></label>
      <label className="text-sm block mt-2">Авторы (по одному в строке)
        <textarea className="w-full resize-y rounded-md border border-[#dce0e5] p-3 mt-1" rows={3} value={draft.authors.join('\n')}
          onChange={e => setDraftField('authors', e.target.value.split('\n').map(a => a.trim()).filter(Boolean))} />
      </label>
      <div className="flex gap-2 mt-3">
        <button type="button" className="button primary" onClick={saveDraft}>Сохранить</button>
        <button type="button" className="button secondary" onClick={cancelDraft}>Отмена</button>
      </div>
    </div>}
  </section>;
}
