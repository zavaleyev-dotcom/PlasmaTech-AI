import type { TextStore } from '@/services/library-text/store';
import type { RetrievedChunk } from './types';

/** Turns a bare (chunkId, documentId, score) into the full RetrievedChunk shape citations and
 *  context-building need, by reading the already-public `store.db` the same way tests and
 *  retrieve.ts already do - no new method is added to TextStore, and neither its schema nor
 *  its indexing logic is touched. Shared by the lexical (retrieve.ts) and semantic
 *  (embeddings/search.ts, via hybrid.ts) retrieval paths so both produce an IDENTICAL shape:
 *  citation/context/grounding code downstream never needs to know which one found a chunk. */
export function hydrateChunk(store: TextStore, chunkId: string, documentId: string, score: number, snippetOverride?: string): RetrievedChunk | null {
  const chunkRow = store.db.prepare('SELECT pageStart, pageEnd, text FROM chunks WHERE id=?').get(chunkId) as { pageStart: number; pageEnd: number; text: string } | undefined;
  if (!chunkRow) return null; // stale reference (e.g. an orphaned embedding not yet cleaned up)
  const meta = store.metadata(documentId);
  if (!meta) return null;
  const snippet = snippetOverride ?? (chunkRow.text.length > 240 ? `${chunkRow.text.slice(0, 240)} …` : chunkRow.text);
  return {
    chunkId, documentId, relativePath: meta.relativePath, filename: meta.filename, title: meta.title,
    authors: meta.authors, doi: meta.doi, year: meta.year, sourceFolder: meta.sourceFolder,
    pageStart: chunkRow.pageStart, pageEnd: chunkRow.pageEnd, text: chunkRow.text, snippet, score,
  };
}
