import type { Publication } from '@/services/scientific-search/types';
import { doiUrl } from '@/services/scientific-search/normalization';
import styles from './search.module.css';

export function PublicationCard({ publication, index }: { publication: Publication; index: number }) {
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
    </article>
  );
}
