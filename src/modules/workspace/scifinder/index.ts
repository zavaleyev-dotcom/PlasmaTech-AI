import type { WorkspaceModule } from '../types';

export const scifinder = {
  id: 'scifinder',
  slug: 'scifinder',
  mode: 'demo',
  example: 'Составить план обзора литературы по магнетронному осаждению покрытий TiN.',
} as const satisfies WorkspaceModule;
