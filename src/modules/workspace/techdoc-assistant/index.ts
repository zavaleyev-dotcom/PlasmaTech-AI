import type { WorkspaceModule } from '../types';

export const techdocAssistant = {
  id: 'techdoc',
  slug: 'techdoc-assistant',
  mode: 'live',
  // `example` is unused by the real assistant UI (TechDocAssistant component) - it is only ever
  // read by the generic demo WorkspaceModule component, which this module no longer renders
  // (see src/app/workspace/[module]/page.tsx). Kept non-empty because `example` is a required
  // field of WorkspaceModule.
  example: 'Подготовить структуру технологической карты нанесения TiN на стальную деталь.',
} as const satisfies WorkspaceModule;
