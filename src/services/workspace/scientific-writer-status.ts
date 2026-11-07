/** What the user is told about the AI provider of Scientific Writer, and WHY (P1-03). Client-safe (no server-only code): it runs in the browser on the answers of the two API
 *  calls - the status check (GET) and the generation (POST) - and on their failures.
 *
 *  The rule: only a fact the server itself reported is stated as a fact. "The provider is not configured" is said only when the server's valid answer says
 *  `configured: false` (or the generation answer has `code: 'not_configured'`). A failed status check - no connection, no answer in time, an error page, a refusal, an
 *  unrecognisable answer - is reported as exactly that, never as a missing key. Messages are fixed texts chosen by a known cause; the server's own text is shown only for a
 *  rejected request (its validation message, written for the user). No key, path, stack or server detail is ever shown or composed here. */

import { isDraftGenerationResult, type DraftGenerationResult } from './scientific-writer-draft-store';

/** Why the provider (or the server's call to it) failed, as the server reports it in `reason`. */
export const WRITER_FAILURE_REASONS = ['timeout', 'network', 'rate_limit', 'upstream', 'auth', 'rejected', 'bad_response', 'internal', 'local_limit', 'local_budget'] as const;
export type WriterFailureReason = typeof WRITER_FAILURE_REASONS[number];

// ---------- the status check (GET) ----------

export type StatusCheckFailure = 'network' | 'timeout' | 'aborted' | 'connection_lost' | 'forbidden' | 'server_error' | 'http_error' | 'bad_response';

export type ProviderStatus =
  | { readonly kind: 'checking' }
  | { readonly kind: 'configured' }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'check_failed'; readonly reason: StatusCheckFailure; readonly httpStatus?: number };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : '');

// ---------- reading the body of an answer: four different things can go wrong, and they are not "bad JSON" ----------

/** What went wrong while the body of an answer that DID arrive (its status was received) was being read. */
export type TransportFailure = 'timeout' | 'aborted' | 'connection_lost' | 'transport';

/** Classifies an exception thrown while a request was in flight or its body was being read. Only the kind is kept: nothing of the exception reaches the user. */
export function classifyTransportFailure(error: unknown): TransportFailure {
  const name = nameOf(error);
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  const code = isObject((error as { cause?: unknown })?.cause) ? String(((error as { cause: Record<string, unknown> }).cause).code ?? '') : '';
  if (error instanceof TypeError || /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNABORTED)$/.test(code)) return 'connection_lost';   // "terminated", "fetch failed", a reset socket
  return 'transport';
}

export type BodyRead =
  | { readonly kind: 'json'; readonly value: unknown }
  /** The whole body arrived and is not valid JSON (an HTML error page, an empty body, a truncated document). */
  | { readonly kind: 'invalid_json' }
  /** The body could not be read to the end. */
  | { readonly kind: 'read_failed'; readonly failure: TransportFailure };

/** Reads the body in two steps - first the text (a transport problem is a `read_failed`), then the JSON (a syntax problem is `invalid_json`) - so that a timeout or a dropped
 *  connection while reading is never reported as a bad answer. */
export async function readResponseBody(response: Response): Promise<BodyRead> {
  let text: string;
  try { text = await response.text(); } catch (error) { return { kind: 'read_failed', failure: classifyTransportFailure(error) }; }
  try { return { kind: 'json', value: JSON.parse(text) }; } catch { return { kind: 'invalid_json' }; }
}

/** Asks the server whether the provider is configured. Never throws; every outcome is a distinct state. */
export async function checkProviderStatus(fetcher: typeof fetch = fetch, timeoutMs = 8000): Promise<ProviderStatus> {
  let response: Response;
  try { response = await fetcher('/api/workspace/scientific-writer', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { const name = nameOf(error); return { kind: 'check_failed', reason: name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'aborted' : 'network' }; }
  if (response.status === 403) return { kind: 'check_failed', reason: 'forbidden', httpStatus: 403 };
  if (response.status >= 500) return { kind: 'check_failed', reason: 'server_error', httpStatus: response.status };
  if (!response.ok) return { kind: 'check_failed', reason: 'http_error', httpStatus: response.status };
  const read = await readResponseBody(response);
  if (read.kind === 'read_failed') return { kind: 'check_failed', reason: read.failure === 'timeout' ? 'timeout' : read.failure === 'aborted' ? 'aborted' : read.failure === 'connection_lost' ? 'connection_lost' : 'network' };
  if (read.kind === 'invalid_json') return { kind: 'check_failed', reason: 'bad_response' };
  const body = read.value;
  if (!isObject(body) || typeof body.configured !== 'boolean') return { kind: 'check_failed', reason: 'bad_response' };
  return body.configured ? { kind: 'configured' } : { kind: 'not_configured' };
}

const LOCAL_ONLY_NOTE = 'Локальная сборка структуры из ваших данных остаётся доступной ниже; при нажатии «Сформировать» состояние будет определено по ответу сервера.';

/** The text of the banner for a status, or `null` when nothing needs to be said. */
export function describeProviderStatus(status: ProviderStatus): string | null {
  if (status.kind === 'checking' || status.kind === 'configured') return null;
  if (status.kind === 'not_configured') return 'ИИ-провайдер не настроен: сервер сообщает, что ключ OPENAI_API_KEY не задан. Локальная сборка структуры из ваших данных всё равно доступна ниже - без ИИ-генерации текста.';
  const lead = 'Не удалось проверить состояние ИИ-провайдера, поэтому неизвестно, настроен ли он';
  switch (status.reason) {
    case 'network': return `${lead}: нет связи с сервером (сетевая ошибка или сервер остановлен). ${LOCAL_ONLY_NOTE}`;
    case 'timeout': return `${lead}: сервер не ответил вовремя. ${LOCAL_ONLY_NOTE}`;
    case 'aborted': return `${lead}: проверка была прервана. ${LOCAL_ONLY_NOTE}`;
    case 'connection_lost': return `${lead}: соединение с сервером оборвалось при получении ответа. ${LOCAL_ONLY_NOTE}`;
    case 'forbidden': return `${lead}: сервер отклонил проверку как нелокальный запрос (откройте приложение по адресу localhost). ${LOCAL_ONLY_NOTE}`;
    case 'server_error': return `${lead}: сервер вернул ошибку (HTTP ${status.httpStatus ?? '5xx'}). ${LOCAL_ONLY_NOTE}`;
    case 'http_error': return `${lead}: неожиданный ответ сервера (HTTP ${status.httpStatus ?? '?'}). ${LOCAL_ONLY_NOTE}`;
    case 'bad_response': return `${lead}: ответ сервера не удалось распознать. ${LOCAL_ONLY_NOTE}`;
  }
}

// ---------- the generation (POST) ----------

export type GenerationFailureCause =
  | 'not_configured' | 'provider_timeout' | 'provider_network' | 'rate_limit' | 'provider_unavailable' | 'provider_auth' | 'provider_rejected' | 'bad_provider_response' | 'internal_error' | 'local_limit' | 'local_budget'
  | 'invalid_request' | 'forbidden' | 'too_large' | 'server_error' | 'unexpected_answer' | 'network' | 'timeout' | 'aborted' | 'connection_lost' | 'transport';

export interface GenerationFailure {
  /** The existing three states of the screen: nothing to retry (not configured), transient (worth retrying), a failure that a retry alone will not fix. */
  readonly state: 'not_configured' | 'unavailable' | 'error';
  readonly cause: GenerationFailureCause;
  /** A complete, safe sentence for the user. */
  readonly message: string;
}

const TRANSIENT: ReadonlySet<GenerationFailureCause> = new Set(['local_limit', 'provider_timeout', 'provider_network', 'rate_limit', 'provider_unavailable', 'server_error', 'network', 'timeout', 'aborted', 'connection_lost', 'transport']);

const MESSAGES: Record<Exclude<GenerationFailureCause, 'invalid_request' | 'server_error' | 'unexpected_answer'>, string> = {
  not_configured: 'ИИ-генерация недоступна: сервер сообщает, что ИИ-провайдер не настроен (не задан ключ OPENAI_API_KEY).',
  provider_timeout: 'ИИ-провайдер не ответил вовремя. Попробуйте позже.',
  provider_network: 'Сервер не смог связаться с ИИ-провайдером (сетевая ошибка на стороне сервера). Попробуйте позже.',
  rate_limit: 'ИИ-провайдер ограничил число запросов. Подождите и повторите.',
  provider_unavailable: 'ИИ-провайдер временно недоступен (ошибка на его стороне). Попробуйте позже.',
  provider_auth: 'ИИ-провайдер отклонил доступ: проверьте ключ API в настройках сервера. Повтор без исправления не поможет.',
  provider_rejected: 'ИИ-провайдер вернул ошибку при генерации текста.',
  bad_provider_response: 'Ответ ИИ-провайдера не удалось использовать (пустой или в неожиданном формате).',
  internal_error: 'Внутренняя ошибка сервера при генерации текста. Подробности записаны в журнале сервера.',
  local_limit: 'Достигнут локальный предел ИИ-нагрузки приложения (частота запросов или число одновременных операций). Запрос к ИИ-провайдеру не отправлялся. Подождите немного и повторите.',
  local_budget: 'Достигнут локальный бюджет ИИ-токенов приложения (настраивается на сервере). Запрос к ИИ-провайдеру не отправлялся. Повтор сразу не поможет.',
  forbidden: 'Сервер отклонил запрос как нелокальный: откройте приложение по адресу localhost.',
  too_large: 'Запрос слишком большой: сократите введённый текст.',
  network: 'Не удалось связаться с сервером (сетевая ошибка или сервер остановлен). Ваши данные на экране не потеряны.',
  timeout: 'Сервер не ответил вовремя. Попробуйте ещё раз.',
  aborted: 'Запрос был прерван. Попробуйте ещё раз.',
  connection_lost: 'Соединение с сервером оборвалось во время получения ответа. Попробуйте ещё раз.',
  transport: 'Ошибка при получении ответа сервера. Попробуйте ещё раз.',
};

function make(cause: GenerationFailureCause, message: string): GenerationFailure {
  return { state: cause === 'not_configured' ? 'not_configured' : TRANSIENT.has(cause) ? 'unavailable' : 'error', cause, message };
}

/** The failure of a request that never got an answer (the network, a stopped server, a timeout). */
export function classifyGenerationException(error: unknown): GenerationFailure {
  const name = nameOf(error);
  return name === 'TimeoutError' ? make('timeout', MESSAGES.timeout) : name === 'AbortError' ? make('aborted', MESSAGES.aborted) : make('network', MESSAGES.network);
}

/** The failure of reading the body of an answer that arrived (the answer's status was received, the body did not come through). */
export function classifyBodyReadFailure(failure: TransportFailure): GenerationFailure {
  return failure === 'timeout' ? make('timeout', MESSAGES.timeout) : failure === 'aborted' ? make('aborted', MESSAGES.aborted) : failure === 'connection_lost' ? make('connection_lost', MESSAGES.connection_lost) : make('transport', MESSAGES.transport);
}

// ---------- the text of a rejected request ----------

const FIELD_LABEL = '(?:Тип документа|Режим работы|Целевой язык|Название/тема|Область исследования|Ключевые слова|Цель|Объект исследования|Методы|Основные результаты|Выводы|Исходный текст|Дополнительные требования)';
/** The CLOSED set of validation messages the Writer API sends for a rejected request (see `validateInput` and the request parser). A message is shown only if it is exactly one of
 *  them; anything else - a path, a stack, HTML, a key-like string, any other server text - is replaced by a fixed sentence. */
const SAFE_VALIDATION_MESSAGES: readonly RegExp[] = [
  new RegExp(`^${FIELD_LABEL}: (?:недопустимое значение\\. Допустимо: [a-z_]+(?:, [a-z_]+)*\\.|недопустимое значение\\.|слишком длинный текст \\(максимум \\d{1,6} символов\\)\\.|текст слишком длинный \\(максимум \\d{1,6} символов\\)\\.|ожидается строка\\.|обязательное поле\\.|для этого режима обязателен\\.)$`),
  /^Суммарный объём введённого текста слишком велик \(максимум \d{1,6} символов\)\.$/,
  /^Заполните хотя бы одно поле \(тема, цель, объект, методы, результаты или выводы\) для создания черновика\.$/,
  /^(?:Неверный формат запроса(?: \(ожидался JSON\))?\.|Пустое тело запроса\.)$/,
];
const GENERIC_REJECTION = 'Запрос не принят: проверьте введённые данные.';

/** The server's validation message if it is one of the known ones, otherwise a fixed sentence. */
export function safeValidationMessage(text: unknown): string {
  return typeof text === 'string' && text.length <= 300 && SAFE_VALIDATION_MESSAGES.some(re => re.test(text)) ? `Запрос не принят: ${text}` : GENERIC_REJECTION;
}

/** The failure described by a non-OK answer: its HTTP status and its body (`undefined` when the body was not JSON, for example an HTML error page). */
export function classifyGenerationResponse(httpStatus: number, body: unknown): GenerationFailure {
  const code = isObject(body) && typeof body.code === 'string' ? body.code : undefined;
  const reason = isObject(body) && typeof body.reason === 'string' ? body.reason : undefined;
  if (code === 'not_configured') return make('not_configured', MESSAGES.not_configured);
  if (code === 'unavailable') {
    if (reason === 'timeout') return make('provider_timeout', MESSAGES.provider_timeout);
    if (reason === 'network') return make('provider_network', MESSAGES.provider_network);
    if (reason === 'rate_limit') return make('rate_limit', MESSAGES.rate_limit);
    if (reason === 'local_limit') return make('local_limit', MESSAGES.local_limit);
    if (reason === 'local_budget') return make('local_budget', MESSAGES.local_budget);
    return make('provider_unavailable', MESSAGES.provider_unavailable);
  }
  if (code === 'error') {
    if (reason === 'auth') return make('provider_auth', MESSAGES.provider_auth);
    if (reason === 'rejected') return make('provider_rejected', MESSAGES.provider_rejected);
    if (reason === 'bad_response') return make('bad_provider_response', MESSAGES.bad_provider_response);
    return make('internal_error', MESSAGES.internal_error);
  }
  if (code === 'invalid_request') return make('invalid_request', safeValidationMessage(isObject(body) ? body.error : undefined));
  if (httpStatus === 403) return make('forbidden', MESSAGES.forbidden);
  if (httpStatus === 413) return make('too_large', MESSAGES.too_large);
  if (httpStatus === 400) return make('invalid_request', safeValidationMessage(isObject(body) ? body.error : undefined));
  if (httpStatus >= 500) return make('server_error', `Сервер вернул ошибку (HTTP ${httpStatus}) без пояснения.`);
  return make('unexpected_answer', `Сервер вернул неожиданный ответ (HTTP ${httpStatus}).`);
}

/** A body that arrived with HTTP 200 but is not the expected generation answer. */
export function classifyUnexpectedSuccess(): GenerationFailure {
  return make('unexpected_answer', 'Сервер вернул ответ неожиданного формата. Попробуйте ещё раз.');
}

/** The generation answer as the screen uses it, or `null`. EVERY field the screen reads is checked, with the types of the items of every list: the text, the evidence (its
 *  `fields`, `provided` and `missing`), the preservation check (or null), the list of changes (or null) and the warnings. A copy built from the checked fields is returned, so
 *  nothing from a damaged answer is ever applied - not even a part of it. The format of the correct answer (see `handleGenerate`) is unchanged. */
export function parseGenerationBody(body: unknown): DraftGenerationResult | null {
  if (!isObject(body) || typeof body.generatedText !== 'string' || body.generatedText.trim() === '') return null;
  const candidate = { generatedText: body.generatedText, evidence: body.evidence, preservation: body.preservation, changes: body.changes, warnings: body.warnings };
  return isDraftGenerationResult(candidate) ? JSON.parse(JSON.stringify(candidate)) as DraftGenerationResult : null;
}
