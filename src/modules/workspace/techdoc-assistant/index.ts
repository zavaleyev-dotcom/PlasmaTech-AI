import type { WorkspaceModule } from '../types';

export const techdocAssistant = {
  id: 'techdoc',
  slug: 'techdoc-assistant',
  mode: 'demo',
  example: 'Подготовить структуру технологической карты нанесения TiN на стальную деталь.',
} as const satisfies WorkspaceModule;
