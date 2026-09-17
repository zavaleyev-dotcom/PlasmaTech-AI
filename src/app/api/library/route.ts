import { NextResponse } from 'next/server';
import { getProgress, libraryConfig, loadIndex, startIndexing } from '@/services/local-library';
import { isLocalLibraryRequest } from '@/services/local-library/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: Request) {
  if (!isLocalLibraryRequest(request)) return json({ error: 'Библиотека доступна только локально.' }, 403);
  try {
    const { root, indexFile } = await libraryConfig();
    const index = await loadIndex(root, indexFile);
    return json({ indexedAt: index.indexedAt, records: index.records.map(record => {
      // Absolute paths remain in the private on-disk index, not in browser responses.
      const { absolutePath, ...publicRecord } = record;
      void absolutePath; return publicRecord;
    }), errors: index.errors, progress: getProgress() });
  } catch { return json({ error: 'Библиотека недоступна. Проверьте SCIENTIFIC_LIBRARY_PATH в .env.local и доступ к каталогу.' }, 503); }
}
export async function POST(request: Request) {
  if (!isLocalLibraryRequest(request) || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  // No path, file name, or directory is accepted from the client.
  try { await startIndexing(); return json({ progress: getProgress() }, 202); }
  catch { return json({ error: 'Не удалось запустить индексирование. Проверьте локальную конфигурацию.' }, 503); }
}
