import type { WorkspaceModule } from '../types';

export const engineeringCalculators = {
  id: 'calculators',
  slug: 'engineering-calculators',
  mode: 'live',
  // `example` is unused by the real calculator UI (EngineeringCalculators component) - it is
  // only ever read by the generic demo WorkspaceModule component, which this module no longer
  // renders (see src/app/workspace/[module]/page.tsx). Kept non-empty because `example` is a
  // required field of WorkspaceModule.
  example: 'd = v × t: толщина 1000 нм при скорости 10 нм/мин занимает 100 минут.',
} as const satisfies WorkspaceModule;
