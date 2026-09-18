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
