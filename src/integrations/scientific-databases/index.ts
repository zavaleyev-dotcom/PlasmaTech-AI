import type { KnowledgeSearch } from '@/knowledge-base';

export interface ScientificDatabaseGateway extends KnowledgeSearch {
  readonly sourceName: string;
}
