import type { Tool } from '@/lib/content';

export type WorkspaceModuleId = Tool['id'];

export interface WorkspaceModule {
  id: WorkspaceModuleId;
  slug: string;
  mode: 'demo' | 'live';
  example: string;
}
