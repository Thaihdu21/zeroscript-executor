export const AUTOEXEC_SCRIPT_NAME: string;

export interface AutoexecTarget {
  id: string;
  name: string;
  folder: string;
  exists: boolean;
  scriptPath: string;
  installed: boolean;
  installedPath: string | null;
}

export interface AutoexecStatus {
  platform: NodeJS.Platform;
  scriptName: string;
  supported: boolean;
  targets: AutoexecTarget[];
  detectedTargets: AutoexecTarget[];
}

export interface AutoexecWriteResult {
  ok: boolean;
  written: Array<{ name: string; scriptPath: string; previousPath: string | null }>;
  error: string | null;
}

export function getAutoexecTargets(): AutoexecTarget[];
export function getDetectedAutoexecTargets(): AutoexecTarget[];
export function getAutoexecStatus(): AutoexecStatus;
export function formatAutoexecScript(loaderSnippet: string): string;
export function writeLoaderToAutoexec(
  loaderSnippet: string,
  options?: { targets?: AutoexecTarget[]; dryRun?: boolean },
): Promise<AutoexecWriteResult>;
