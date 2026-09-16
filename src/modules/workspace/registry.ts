import { tools } from '@/lib/content';
import type { WorkspaceModuleId } from './types';
import { scifinder } from './scifinder';
import { techdocAssistant } from './techdoc-assistant';
import { scientificWriter } from './scientific-writer';
import { equipmentSelector } from './equipment-selector';
import { technoEconomicAssessment } from './techno-economic-assessment';
import { engineeringCalculators } from './engineering-calculators';

export const workspaceModules = [
  scifinder,
  techdocAssistant,
  scientificWriter,
  equipmentSelector,
  technoEconomicAssessment,
  engineeringCalculators,
] as const;

export function getWorkspaceModule(slug: string) {
  const definition = workspaceModules.find(module => module.slug === slug);
  if (!definition) return undefined;
  const tool = tools.find(tool => tool.id === definition.id);
  if (!tool) throw new Error(`Missing tool metadata: ${definition.id}`);
  return { ...definition, tool };
}

export function getWorkspaceModuleHref(id: WorkspaceModuleId) {
  const definition = workspaceModules.find(module => module.id === id);
  if (!definition) throw new Error(`Unknown workspace module: ${id}`);
  return `/workspace/${definition.slug}`;
}
