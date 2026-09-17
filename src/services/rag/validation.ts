import { DEFAULT_RETRIEVAL_LIMIT, MAX_QUESTION_LENGTH, MAX_RETRIEVAL_LIMIT, RagValidationError } from './types';

export function parseAskInput(input: unknown): { question: string; limit: number } {
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
  return { question: question.trim(), limit };
}
