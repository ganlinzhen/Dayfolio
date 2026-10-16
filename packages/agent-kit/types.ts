export interface AgentKitStatus {
  bundledVersion: string | null;
  exportedVersion: string | null;
  exportedPath: string | null;
  clientNode: string | null;
  issues: string[];
}
