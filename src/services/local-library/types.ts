export const documentTypes = ['Articles', 'Book', 'Patent', 'Dissertation', 'Lecture', 'Grant', 'Presentation', 'Journal', 'Other'] as const;
export type DocumentType = typeof documentTypes[number];
export interface LibraryRecord {
  id: string; filename: string; title: string; authors: string[]; year: number | null;
  doi: string | null; documentType: DocumentType; sourceFolder: string;
  relativePath: string; absolutePath: string; fileSize: number; modifiedDate: string; indexedAt: string;
  metadataSource: 'pdf' | 'filename'; error: string | null;
}
export interface LibraryIndex {
  version: 1; rootId: string; indexedAt: string | null; records: LibraryRecord[];
  errors: { relativePath: string; message: string }[];
}
export interface IndexProgress { running: boolean; processed: number; discovered: number; error: string | null }
export type PublicLibraryRecord = Omit<LibraryRecord, 'absolutePath'>;
export interface LibraryQuery { search?: string; documentType?: string; sourceFolder?: string; year?: string; sort?: string }
