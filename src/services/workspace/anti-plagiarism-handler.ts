/** The testable request/response pipeline for the Anti-Plagiarism API route, kept OUT of
 *  route.ts (F01): a Next.js App Router `route.ts` module may only export the handful of names
 *  Next itself recognizes (GET/POST/.../config/...) - any other named export (like a helper a
 *  test imports directly) fails Next's own generated route-type check under the webpack
 *  production build (`next build --webpack`), even though it is silently accepted by the
 *  Turbopack dev/build path. Moving handleCheck here, with route.ts reduced to a thin request/
 *  response adapter that imports (not re-exports) it, fixes that class of error architecturally
 *  rather than for this one route. */

import 'server-only';
import { checkSimilarity } from './anti-plagiarism-corpus';
import { ValidationError } from './anti-plagiarism';

export interface CheckResponse { status: number; body: Record<string, unknown> }

/** The whole "given a parsed request body, produce a response" step as one function, so tests
 *  can exercise it directly (with a stub corpus via checkSimilarity's own openStore injection)
 *  without needing a live HTTP request object beyond what POST itself already builds.
 *
 *  F10: only a `ValidationError`'s own message (always hand-authored, safe to show) ever
 *  reaches the client. Any other exception - a storage/filesystem failure, a corrupted index, a
 *  bug - is logged server-side with full detail and answered with one fixed, neutral message;
 *  its `.message`/stack/path is never forwarded. */
export async function handleCheck(raw: unknown, check: typeof checkSimilarity = checkSimilarity): Promise<CheckResponse> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, body: { error: 'Неверный формат запроса.' } };
  const text = (raw as Record<string, unknown>).text;
  if (typeof text !== 'string') return { status: 400, body: { error: 'Текст для проверки: обязательное строковое поле.' } };

  try {
    const report = await check(text);
    return { status: 200, body: { ...report } };
  } catch (error) {
    if (error instanceof ValidationError) return { status: 400, body: { error: error.message } };
    console.error('[anti-plagiarism] internal error:', error);
    return { status: 500, body: { error: 'Не удалось выполнить проверку.' } };
  }
}
