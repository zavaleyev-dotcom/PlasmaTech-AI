import type { Tool } from '@/lib/content';

export interface WorkspaceResult {
  title: string;
  items: readonly string[];
  notice: string;
}

// UI-facing contract. Future remote providers must call a server route,
// never import SDKs, credentials, database clients or MCP transports here.
export interface WorkspaceProvider {
  run(tool: Tool, input: string): Promise<WorkspaceResult>;
}
