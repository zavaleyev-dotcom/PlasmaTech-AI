import type { WorkspaceModule } from '../types';

export const scientificWriter = {
  id: 'writer',
  slug: 'scientific-writer',
  mode: 'demo',
  example: 'Подготовить план статьи о влиянии давления на свойства покрытий TiN.',
} as const satisfies WorkspaceModule;
