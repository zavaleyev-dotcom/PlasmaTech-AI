import { demoProvider } from './demo-provider';
import type { WorkspaceProvider } from './types';

// Explicit demo-only composition; no environment-driven network activation.
export const workspaceService: WorkspaceProvider = demoProvider;
export type { WorkspaceProvider, WorkspaceResult } from './types';
