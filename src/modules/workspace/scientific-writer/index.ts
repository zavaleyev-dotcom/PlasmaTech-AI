import type { WorkspaceModule } from '../types';

export const scientificWriter = {
  id: 'writer',
  slug: 'scientific-writer',
  mode: 'live',
  // `example` is unused by the real writer UI (ScientificWriter component) - it is only ever
  // read by the generic demo WorkspaceModule component, which this module no longer renders
  // (see src/app/workspace/[module]/page.tsx). Kept non-empty because `example` is a required
  // field of WorkspaceModule.
  example: 'Подготовить план статьи о влиянии давления на свойства покрытий TiN.',
} as const satisfies WorkspaceModule;
