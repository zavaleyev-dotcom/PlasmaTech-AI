import type { WorkspaceModuleId } from '@/modules/workspace/types';
import type { WorkspaceResult } from '@/services/workspace/types';

export interface WorkspaceRun {
  id: string;
  moduleId: WorkspaceModuleId;
  task: string;
  result: WorkspaceResult;
  createdAt: string;
}

/** Port for a future PostgreSQL/Supabase repository; no persistence today. */
export interface WorkspaceRunRepository {
  save(run: WorkspaceRun): Promise<void>;
  findById(id: string): Promise<WorkspaceRun | null>;
}
