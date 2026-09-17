export interface TextPage { page: number; text: string }
export interface TextChunk { id: string; documentId: string; ordinal: number; pageStart: number; pageEnd: number; text: string; wordCount: number }
export interface TextMetadata { id: string; relativePath: string; filename: string; title: string; doi: string | null; authors: string[]; year: number | null; sourceFolder: string }
export type ExtractionStatus = 'success' | 'no_text' | 'skipped' | 'error';
export interface TextDocument extends TextMetadata { text: string; pageCount: number | null; characterCount: number; wordCount: number; status: ExtractionStatus; error: string | null; extractedAt: string; modifiedDate: string; fileSize: number; hash: string | null; version: number }
export interface TextProgress { running: boolean; cancelled: boolean; stopRequested: boolean; pid: number; total: number; processed: number; reused: number; extracted: number; errors: number; skipped: number; chunks: number; startedAt: string; finishedAt: string | null; error: string | null }
export interface TextStats { documents: number; successful: number; errors: number; skipped: number; chunks: number; characters: number; words: number; textBytes: number }
export interface ContentHit extends TextMetadata { chunkId: string; pageStart: number; pageEnd: number; snippet: string }
export interface TextOverview { progress: TextProgress | null; stats: TextStats; errors: { filename: string; relativePath: string; status: string; error: string }[] }
