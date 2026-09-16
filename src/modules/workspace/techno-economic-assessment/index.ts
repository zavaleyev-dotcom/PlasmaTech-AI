import type { WorkspaceModule } from '../types';

export const technoEconomicAssessment = {
  id: 'assessment',
  slug: 'techno-economic-assessment',
  mode: 'demo',
  example: 'Составить структуру оценки затрат на приобретение и эксплуатацию PVD-установки.',
} as const satisfies WorkspaceModule;
