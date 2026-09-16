import type { WorkspaceModuleId } from '@/modules/workspace/types';

/** Application-level skill contract, not an installed Codex skill. */
export interface SkillDefinition {
  id: string;
  moduleId: WorkspaceModuleId;
  description: string;
  instructions: string;
}
