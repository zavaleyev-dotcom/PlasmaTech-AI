import { NextResponse } from 'next/server';
import { openTextStore, startTextIndex } from '@/services/library-text';
import { isLocalLibraryRequest, isLocalJsonLibraryRequest } from '@/services/library-text/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: Request) {
  if (!isLocalLibraryRequest(request)) return json({ error: 'Доступ только с локального компьютера.' }, 403);
  const url = new URL(request.url); const query = url.searchParams.get('q');
  if (query && query.length > 500) return json({ error: 'Запрос длиннее 500 символов.' }, 400);
  let store;
  try {
    store = await openTextStore();
    return json(query !== null ? store.search(query, Math.max(0, Math.min(10000, Number(url.searchParams.get('offset')) || 0))) : store.overview());
  } catch { return json({ error: 'Текстовый индекс недоступен. Проверьте локальную конфигурацию и версию Node.js.' }, 503); }
  finally { store?.close(); }
}
export async function POST(request: Request) {
  if (!isLocalJsonLibraryRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  try { await startTextIndex(); return json({ started: true }, 202); }
  catch { return json({ error: 'Не удалось запустить индексирование.' }, 503); }
}
export async function DELETE(request: Request) {
  if (!isLocalJsonLibraryRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  let store;
  try { store = await openTextStore(); store.requestStop(); return json({ stopping: true }); }
  catch { return json({ error: 'Не удалось остановить индексирование.' }, 503); }
  finally { store?.close(); }
}
