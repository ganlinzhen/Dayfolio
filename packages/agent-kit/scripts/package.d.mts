export interface AgentRelease { schemaVersion: number; name: string; version: string; files: Record<string, string> }
export function verifyAgentKit(root: string): AgentRelease;
export function installAgentKit(source: string, target: string, options?: { dryRun?: boolean; rollback?: boolean }): { version: string; target: string; dryRun?: boolean; rollback?: boolean };
export function buildAgentKit(options: { root: string; outDir?: string }): string;
export function digest(file: string): string;
export function filesIn(root: string, relative?: string): string[];
export function verifySourceFreshness(bundle: string, root: string): void;
