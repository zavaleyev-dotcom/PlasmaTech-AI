import type { WorkspaceProvider } from './types';

export const demoProvider: WorkspaceProvider = {
  async run(tool, input) {
    if (!input.trim()) throw new Error('Опишите вашу задачу.');
    if (input.length > 4000) throw new Error('Допустимо не более 4000 символов.');
    return {
      title: 'Пример результата',
      items: tool.result,
      notice: tool.note,
    };
  },
};
