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

/** Single source of truth for "is this a real, working module or still a canned-example demo" -
 *  UI code (navigation, tool grid, mode badges) must derive this from the registry rather than
 *  hardcoding per-module-id checks, or a newly-shipped module stays mislabeled "demo" forever. */
export function isWorkspaceModuleLive(id: WorkspaceModuleId): boolean {
  return workspaceModules.find(module => module.id === id)?.mode === 'live';
}

/** The global shell's small technical status badge for the current route - pure function (no
 *  React/Next import) so it stays unit-testable, and so a newly-shipped module is never left
 *  mislabeled "DEMO" once its registry entry says `mode: 'live'`. */
export function moduleBadge(pathname: string): string {
  if (pathname === '/workspace/scifinder') return 'SCIENTIFIC SEARCH';
  if (pathname === '/my-library') return 'LOCAL LIBRARY';
  if (!pathname.startsWith('/workspace/')) return 'DEMO';
  const slug = pathname.slice('/workspace/'.length);
  return getWorkspaceModule(slug)?.mode === 'live' ? 'LIVE' : 'DEMO';
}
