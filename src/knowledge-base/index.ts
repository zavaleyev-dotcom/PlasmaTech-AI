export interface KnowledgeDocument {
  id: string;
  title: string;
  text: string;
  source: 'google-drive' | 'scientific-database' | 'local';
  sourceUrl?: string;
}

export interface KnowledgeSearch {
  search(query: string, limit: number): Promise<readonly KnowledgeDocument[]>;
}
