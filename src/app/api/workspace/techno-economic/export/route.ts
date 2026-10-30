import { handleTeaExport } from '@/services/workspace/techno-economic-report-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleTeaExport(request);
}
