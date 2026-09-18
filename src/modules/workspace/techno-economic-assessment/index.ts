import type { WorkspaceModule } from '../types';

export const technoEconomicAssessment = {
  id: 'assessment',
  slug: 'techno-economic-assessment',
  mode: 'live',
  // `example` is unused by the real assessment UI (TechnoEconomicAssessment component) - it is
  // only ever read by the generic demo WorkspaceModule component, which this module no longer
  // renders (see src/app/workspace/[module]/page.tsx). Kept non-empty because `example` is a
  // required field of WorkspaceModule.
  example: 'Составить структуру оценки затрат на приобретение и эксплуатацию PVD-установки.',
} as const satisfies WorkspaceModule;
