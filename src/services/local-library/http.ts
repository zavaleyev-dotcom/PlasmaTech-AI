export function isLocalLibraryRequest(request: Request) {
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  return (!origin || origin === `http://${host}` || origin === `https://${host}`) && request.headers.get('sec-fetch-site') !== 'cross-site';
}

/** Every state-changing (POST/DELETE) local library route requires BOTH a local origin AND
 *  `Content-Type: application/json` - previously the same compound condition was
 *  re-implemented inline in four separate route handlers (library, library/ask,
 *  library/text POST and DELETE). Purely a predicate: behavior is unchanged, each route
 *  still builds its own error response around the boolean result. */
export function isLocalJsonLibraryRequest(request: Request): boolean {
  return isLocalLibraryRequest(request) && !!request.headers.get('content-type')?.startsWith('application/json');
}

export type BoundedBody = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_large' };

/** Reads a request body with a hard byte limit, stopping the read as soon as the limit is crossed. A declared Content-Length over the limit is refused without reading
 *  anything, but the limit is NEVER taken on trust from the header: a missing or dishonest Content-Length (chunked or streamed bodies) is bounded by counting the bytes
 *  actually received, and the rest of an oversized stream is cancelled unread. Nothing is parsed here. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: 'empty' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); return { ok: false, reason: 'too_large' }; }
    chunks.push(value);
  }
  return size === 0 ? { ok: false, reason: 'empty' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}
