import { DEFAULT_RETRIEVAL_LIMIT, DEFAULT_RETRIEVAL_MODE, MAX_QUESTION_LENGTH, MAX_RETRIEVAL_LIMIT, RagValidationError } from './types';
import type { RetrievalMode } from './types';

const RETRIEVAL_MODES: readonly RetrievalMode[] = ['lexical', 'semantic', 'hybrid'];

export function parseAskInput(input: unknown): { question: string; limit: number; mode: RetrievalMode } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RagValidationError('Неверный формат запроса.');
  const data = input as Record<string, unknown>;
  const question = data.question;
  if (typeof question !== 'string' || !question.trim()) throw new RagValidationError('Введите вопрос.');
  if (question.length > MAX_QUESTION_LENGTH) throw new RagValidationError(`Вопрос длиннее ${MAX_QUESTION_LENGTH} символов.`);
  const rawLimit = data.limit;
  let limit = DEFAULT_RETRIEVAL_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_RETRIEVAL_LIMIT) {
      throw new RagValidationError(`limit должен быть целым числом от 1 до ${MAX_RETRIEVAL_LIMIT}.`);
    }
    limit = rawLimit;
  }
  const rawMode = data.mode;
  let mode: RetrievalMode = DEFAULT_RETRIEVAL_MODE;
  if (rawMode !== undefined) {
    if (typeof rawMode !== 'string' || !RETRIEVAL_MODES.includes(rawMode as RetrievalMode)) {
      throw new RagValidationError(`mode должен быть одним из: ${RETRIEVAL_MODES.join(', ')}.`);
    }
    mode = rawMode as RetrievalMode;
  }
  return { question: question.trim(), limit, mode };
}
