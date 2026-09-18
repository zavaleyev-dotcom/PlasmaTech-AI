import type { WorkspaceModule } from '../types';

export const equipmentSelector = {
  id: 'equipment',
  slug: 'equipment-selector',
  mode: 'live',
  // `example` is unused by the real selector UI (EquipmentSelector component) - it is only ever
  // read by the generic demo WorkspaceModule component, which this module no longer renders
  // (see src/app/workspace/[module]/page.tsx). Kept non-empty because `example` is a required
  // field of WorkspaceModule.
  example: 'Определить критерии выбора PVD-установки для деталей диаметром до 100 мм.',
} as const satisfies WorkspaceModule;
