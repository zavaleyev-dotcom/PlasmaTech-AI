import type { LibraryQuery, PublicLibraryRecord } from './types';
export function filterLibrary<T extends PublicLibraryRecord>(records: T[], query: LibraryQuery): T[] {
  const text = (query.search ?? '').normalize('NFKC').toLocaleLowerCase().trim();
  return records.filter(r => (!text || [r.title, ...r.authors, r.doi ?? '', r.filename].some(v => v.normalize('NFKC').toLocaleLowerCase().includes(text)))
    && (!query.documentType || r.documentType === query.documentType)
    && (!query.sourceFolder || r.sourceFolder === query.sourceFolder)
    && (!query.year || String(r.year) === query.year))
    .sort((a, b) => (query.sort === 'year' ? (b.year ?? -1) - (a.year ?? -1)
      : query.sort === 'modified' ? b.modifiedDate.localeCompare(a.modifiedDate) : a.title.localeCompare(b.title, 'ru')) || a.relativePath.localeCompare(b.relativePath));
}
export function inferDocumentType(relativePath: string): PublicLibraryRecord['documentType'] {
  const folders = relativePath.split('/').slice(0, -1).reverse();
  const patterns = [
    ['Dissertation', /dissert|disser|диссер|thesis/i], ['Patent', /patent|патент/i],
    ['Lecture', /lecture|lection|лекци/i], ['Grant', /grant|грант/i],
    ['Presentation', /presentation|презентац|\.ppt/i], ['Book', /book|knigi|книг/i],
    ['Articles', /article|scientific article|стать|statia|stat'i|articul/i], ['Journal', /journal|журнал/i],
  ] as const;
  for (const folder of folders) for (const [type, pattern] of patterns) if (pattern.test(folder)) return type;
  return 'Other';
}
