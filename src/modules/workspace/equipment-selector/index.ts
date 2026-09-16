import type { WorkspaceModule } from '../types';

export const equipmentSelector = {
  id: 'equipment',
  slug: 'equipment-selector',
  mode: 'demo',
  example: 'Определить критерии выбора PVD-установки для деталей диаметром до 100 мм.',
} as const satisfies WorkspaceModule;
