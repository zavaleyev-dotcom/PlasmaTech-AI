import type { WorkspaceModule } from '../types';

export const engineeringCalculators = {
  id: 'calculators',
  slug: 'engineering-calculators',
  mode: 'demo',
  example: 'Показать пример расчета времени осаждения слоя 1000 нм при скорости 10 нм/мин.',
} as const satisfies WorkspaceModule;
