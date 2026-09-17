import type { Publication, ScientificSearchQuery } from './types';

export function sortPublications(items: readonly Publication[], sort: ScientificSearchQuery['sort']): Publication[] {
  const score = (item: Publication) => {
    switch (sort) {
      case 'year': return item.year ?? -1;
      case 'citations': return item.citationCount ?? -1;
      case 'open-access': return item.openAccess === true ? 2 : item.openAccess === false ? 1 : 0;
      default: return item.relevanceScore ?? 0;
    }
  };
  return [...items].sort((a, b) => score(b) - score(a) || (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
}
