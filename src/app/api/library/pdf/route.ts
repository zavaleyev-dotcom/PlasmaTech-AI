import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { libraryConfig, loadIndex } from '@/services/local-library';
import { safeLibraryFile } from '@/services/local-library/files';
import { openTextStore } from '@/services/library-text';
import { isLocalLibraryRequest } from '@/services/library-text/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!isLocalLibraryRequest(request)) return new Response('Local access only', { status: 403 });
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[a-f0-9]{64}$/.test(id)) return new Response('Invalid document id', { status: 400 });
  let handle;
  try {
    const { root, indexFile } = await libraryConfig();
    const store = await openTextStore(); let metadata;
    try { metadata = store.metadata(id); } finally { store.close(); }
    const record = metadata ?? (await loadIndex(root, indexFile)).records.find(r => r.id === id);
    if (!record || !/\.pdf$/i.test(record.relativePath)) return new Response('PDF not found', { status: 404 });
    const file = await safeLibraryFile(root, record.relativePath);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat(); await safeLibraryFile(root, record.relativePath);
    const now = await lstat(file);
    if (!info.isFile() || now.ino !== info.ino || now.dev !== info.dev) throw new Error('Unsafe file');
    let start = 0; let end = info.size - 1;
    const range = request.headers.get('range');
    if (range) {
      const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!parsed || (!parsed[1] && !parsed[2])) { await handle.close(); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } }); }
      start = parsed[1] ? Number(parsed[1]) : Math.max(0, info.size - Number(parsed[2]));
      end = parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), end) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { await handle.close(); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } }); }
    }
    if (info.size === 0) { await handle.close(); return new Response('Empty PDF', { status: 422 }); }
    const stream = handle.createReadStream({ start, end, autoClose: true }); handle = undefined;
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers: {
      'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    } });
  } catch { await handle?.close().catch(() => {}); return new Response('PDF unavailable or outside library', { status: 404 }); }
}
