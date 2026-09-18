import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SciFinderSearch } from '@/components/scifinder/search';
import { WorkspaceModule } from '@/components/workspace-module';
import { EngineeringCalculators } from '@/components/engineering-calculators';
import { TechnoEconomicAssessment } from '@/components/techno-economic-assessment';
import { EquipmentSelector } from '@/components/equipment-selector';
import { getWorkspaceModule, workspaceModules } from '@/modules/workspace/registry';

type Props = { params: Promise<{ module: string }> };

export function generateStaticParams() {
  return workspaceModules.map(module => ({ module: module.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const workspaceModule = getWorkspaceModule((await params).module);
  return { title: workspaceModule?.tool.name ?? 'Инструмент не найден' };
}

export default async function ModulePage({ params }: Props) {
  const workspaceModule = getWorkspaceModule((await params).module);
  if (!workspaceModule) notFound();

  return (
    <div className="page inner-page">
      <Link href="/workspace" className="text-link">← Все инструменты</Link>
      <div className="page-intro">
        <div className="eyebrow">
          {workspaceModule.id === 'scifinder' ? 'AI WORKSPACE / SCIENTIFIC SEARCH'
            : workspaceModule.id === 'calculators' ? 'AI WORKSPACE / ENGINEERING CALCULATORS'
            : workspaceModule.id === 'assessment' ? 'AI WORKSPACE / TECHNO-ECONOMIC ASSESSMENT'
            : workspaceModule.id === 'equipment' ? 'AI WORKSPACE / EQUIPMENT SELECTOR'
            : 'AI WORKSPACE / DEMO'}
        </div>
        <h1>{workspaceModule.tool.name}</h1>
        <p>{workspaceModule.tool.description}</p>
      </div>
      {workspaceModule.id === 'scifinder' ? <SciFinderSearch />
        : workspaceModule.id === 'calculators' ? <EngineeringCalculators />
        : workspaceModule.id === 'assessment' ? <TechnoEconomicAssessment />
        : workspaceModule.id === 'equipment' ? <EquipmentSelector />
        : <WorkspaceModule key={workspaceModule.id} tool={workspaceModule.tool} example={workspaceModule.example} />}
    </div>
  );
}
