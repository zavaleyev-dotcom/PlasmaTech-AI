export function isLocalLibraryRequest(request: Request) {
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  return (!origin || origin === `http://${host}` || origin === `https://${host}`) && request.headers.get('sec-fetch-site') !== 'cross-site';
}
