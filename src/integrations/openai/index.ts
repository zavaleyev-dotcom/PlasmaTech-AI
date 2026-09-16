/** Server-only implementation to be added later. No SDK or API calls. */
export interface LanguageModelGateway {
  generate(request: { instructions: string; task: string }): Promise<string>;
}
