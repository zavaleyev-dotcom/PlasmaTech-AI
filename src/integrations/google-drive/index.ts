import type { KnowledgeDocument } from '@/knowledge-base';

export interface GoogleDriveGateway {
  readDocument(fileId: string): Promise<KnowledgeDocument>;
}
