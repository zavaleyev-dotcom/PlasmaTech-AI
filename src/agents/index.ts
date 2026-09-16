import type { WorkspaceModuleId } from '@/modules/workspace/types';
import type { SkillDefinition } from '@/skills';
import type { WorkspaceResult } from '@/services/workspace/types';

export interface AgentDefinition {
  id: string;
  moduleId: WorkspaceModuleId;
  skills: readonly SkillDefinition[];
}

/** Future server-side orchestration boundary. No runner is installed. */
export interface AgentRunner {
  run(agent: AgentDefinition, task: string): Promise<WorkspaceResult>;
}
