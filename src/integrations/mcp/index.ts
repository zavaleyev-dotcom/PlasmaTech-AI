export interface McpGateway {
  callTool(name: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}
