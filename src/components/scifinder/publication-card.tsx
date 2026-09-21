'use client';

import { useState } from 'react';
import type { Publication } from '@/services/scientific-search/types';
import { doiUrl } from '@/services/scientific-search/normalization';
import { queuePublicationForScientificWriter } from '@/services/workspace/scifinder-import';
import styles from './search.module.css';

type ImportState = 'idle' | 'added' | 'duplicate';

export function PublicationCard({ publication, index }: { publication: Publication; index: number }) {
  const [importState, setImportState] = useState<ImportState>('idle');

  function addToScientificWriter() {
    const outcome = queuePublicationForScientificWriter(publication);
    setImportState(outcome.status === 'queued' ? 'added' : 'duplicate');
  }

  const fields = [
    ['Год', publication.year], ['Журнал / источник', publication.journal],
    ['Тип публикации', publication.type], ['Издатель', publication.publisher],
    ['Цитирований (OpenAlex)', publication.citationCount],
    ['Open Access', publication.openAccess === null ? null : publication.openAccess ? 'Да' : 'Нет'],
  ];
  return (
    <article className={styles.publication}>
      <div className={styles.meta}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span className="mode-badge">{publication.sources.map(source => source === 'crossref' ? 'Crossref' : source === 'openalex' ? 'OpenAlex' : source).join(' + ')}</span>
      </div>
      <h3>{publication.title}</h3>
      {publication.authors.length > 0 && <p className={styles.authors}>{publication.authors.join(', ')}</p>}
      <dl className={styles.details}>
        {fields.map(([label, value]) => value !== null && <div key={label}>
          <dt>{label}</dt><dd>{value}</dd>
        </div>)}
        {publication.doi && <div><dt>DOI</dt><dd><a className={styles.link} href={doiUrl(publication.doi)} target="_blank" rel="noopener noreferrer">{publication.doi}</a></dd></div>}
        {publication.openAlexId && <div><dt>OpenAlex ID</dt><dd><a className={styles.link} href={publication.openAlexId} target="_blank" rel="noopener noreferrer">{publication.openAlexId}</a></dd></div>}
        {publication.url && <div><dt>URL</dt><dd><a className={styles.link} href={publication.url} target="_blank" rel="noopener noreferrer">{publication.url}</a></dd></div>}
      </dl>
      {publication.abstract && <div className={styles.abstract}>
        <h4>Abstract из метаданных источника</h4>
        <p>{publication.abstract.length > 700 ? `${publication.abstract.slice(0, 700)}…` : publication.abstract}</p>
        {publication.abstract.length > 700 && <details><summary>Показать abstract полностью</summary><p>{publication.abstract}</p></details>}
      </div>}
      <div className="mt-2">
        <button type="button" className="button secondary" onClick={addToScientificWriter} disabled={importState !== 'idle'}>
          Добавить в Scientific Writer
        </button>
        {importState === 'added' && <p role="status" className="muted small mt-1">Добавлено в список источников Scientific Writer - откройте модуль Scientific Writer, чтобы увидеть его.</p>}
        {importState === 'duplicate' && <p role="alert" className="muted small mt-1">Такой источник (по DOI/названию) уже был добавлен ранее - повторно не добавлен.</p>}
      </div>
    </article>
  );
}
