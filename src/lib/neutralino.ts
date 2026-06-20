import * as Neutralino from '@neutralinojs/lib';

const BACKEND_ORIGIN = 'http://127.0.0.1:8000';
const BACKEND_HEALTH_URL = `${BACKEND_ORIGIN}/api/media?offset=0&limit=1`;
const BACKEND_SHUTDOWN_URL = `${BACKEND_ORIGIN}/api/shutdown`;

export interface NeutralinoRuntimeWindow {
  NL_ARGS?: string[];
  NL_EXTENSION?: string;
  NL_MODE?: string;
  NL_PATH?: string;
  NL_PORT?: number | string;
  NL_TOKEN?: string;
}

export interface BackendLaunchResult {
  backendPath?: string;
  backendPathCandidates?: string[];
  error?: unknown;
  method?: 'execCommand' | 'spawnProcess';
  status: 'launched' | 'failed' | 'skipped';
}

export interface BackendReadyOptions {
  attempts?: number;
  delayMs?: number;
  delay?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  onAttempt?: (attempt: number) => void;
}

let neutralinoInitialized = false;
let backendShutdownRegistered = false;

function getRuntimeWindow(): NeutralinoRuntimeWindow | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

export function hasNeutralinoGlobals(runtimeWindow: NeutralinoRuntimeWindow | undefined = getRuntimeWindow()): boolean {
  return Boolean(
    runtimeWindow &&
    runtimeWindow.NL_MODE === 'window' &&
    runtimeWindow.NL_PATH &&
    runtimeWindow.NL_PORT !== undefined &&
    runtimeWindow.NL_TOKEN
  );
}

export function getBundledBackendPath(runtimeWindow: NeutralinoRuntimeWindow | undefined = getRuntimeWindow()): string | null {
  return getBundledBackendPathCandidates(runtimeWindow)[0] ?? null;
}

export function quoteCommandPath(path: string): string {
  return `"${path.replaceAll('"', '\\"')}"`;
}

export function ensureNeutralinoClient(runtimeWindow: NeutralinoRuntimeWindow | undefined = getRuntimeWindow()): boolean {
  if (!hasNeutralinoGlobals(runtimeWindow)) return false;

  if (!neutralinoInitialized) {
    Neutralino.init({ exportCustomMethods: false });
    neutralinoInitialized = true;
  }

  return true;
}

export function isNeutralinoDevRuntime(runtimeWindow: NeutralinoRuntimeWindow | undefined = getRuntimeWindow()): boolean {
  return Boolean(
    runtimeWindow?.NL_ARGS?.some((arg) => (
      arg === '--neu-dev-auto-reload' ||
      arg.startsWith('--load-dir-res=')
    ))
  );
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizePath(value: string): string {
  return stripWrappingQuotes(value).replaceAll('\\', '/').replace(/\/+$/, '');
}

function joinPath(basePath: string, entry: string): string {
  const normalizedBase = normalizePath(basePath);
  if (!normalizedBase) return entry;
  return `${normalizedBase}/${entry}`;
}

function getParentPath(path: string): string | null {
  const normalizedPath = normalizePath(path);
  const separatorIndex = normalizedPath.lastIndexOf('/');
  if (separatorIndex <= 0) return null;
  return normalizedPath.slice(0, separatorIndex);
}

function pathLooksLikeFile(path: string): boolean {
  const normalizedPath = normalizePath(path);
  const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]+$/.test(filename);
}

function getArgValue(args: string[] | undefined, prefix: string): string | null {
  const match = args?.find((arg) => arg.startsWith(prefix));
  return match ? stripWrappingQuotes(match.slice(prefix.length)) : null;
}

function addCandidate(candidates: string[], path: string | null): void {
  if (!path) return;
  const normalizedPath = normalizePath(path);
  if (!normalizedPath || candidates.includes(normalizedPath)) return;
  candidates.push(normalizedPath);
}

export function getBundledBackendPathCandidates(
  runtimeWindow: NeutralinoRuntimeWindow | undefined = getRuntimeWindow()
): string[] {
  const backendFilenames = runtimeWindow?.NL_EXTENSION === undefined
    ? ['backend', 'backend.exe']
    : [`backend${runtimeWindow.NL_EXTENSION}`];
  const candidates: string[] = [];

  for (const backendFilename of backendFilenames) {
    if (runtimeWindow?.NL_PATH) {
      addCandidate(candidates, joinPath(runtimeWindow.NL_PATH, backendFilename));

      if (pathLooksLikeFile(runtimeWindow.NL_PATH)) {
        const appDirectory = getParentPath(runtimeWindow.NL_PATH);
        if (appDirectory) {
          addCandidate(candidates, joinPath(appDirectory, backendFilename));
        }
      }
    }

    const processPath = runtimeWindow?.NL_ARGS?.[0];
    if (processPath) {
      const processDirectory = getParentPath(processPath);
      if (processDirectory) {
        addCandidate(candidates, joinPath(processDirectory, backendFilename));
      }
    }

    const configuredPath = getArgValue(runtimeWindow?.NL_ARGS, '--path=');
    if (configuredPath) {
      const configuredDirectory = pathLooksLikeFile(configuredPath)
        ? getParentPath(configuredPath)
        : configuredPath;
      if (configuredDirectory) {
        addCandidate(candidates, joinPath(configuredDirectory, backendFilename));
      }
    }

    const loadDirectory = getArgValue(runtimeWindow?.NL_ARGS, '--load-dir-res=');
    if (loadDirectory) {
      addCandidate(candidates, joinPath(loadDirectory, backendFilename));
    }
  }

  return candidates;
}

async function findExistingBackendPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stats = await Neutralino.filesystem.getStats(candidate);
      if (stats.isFile) return candidate;
    } catch {
      // Try the next packaged location.
    }
  }

  return null;
}

export async function startBundledBackend(
  runtimeWindow: NeutralinoRuntimeWindow | undefined = getRuntimeWindow()
): Promise<BackendLaunchResult> {
  if (!ensureNeutralinoClient(runtimeWindow)) {
    return { status: 'skipped' };
  }

  const backendPathCandidates = getBundledBackendPathCandidates(runtimeWindow);
  const backendPath = await findExistingBackendPath(backendPathCandidates);
  if (!backendPath) {
    if (isNeutralinoDevRuntime(runtimeWindow)) {
      return { status: 'skipped', backendPathCandidates };
    }

    return {
      status: 'failed',
      backendPathCandidates,
      error: new Error(`Bundled backend executable was not found. Tried: ${backendPathCandidates.join(', ') || 'none'}`)
    };
  }

  const cwd = getParentPath(backendPath) ?? undefined;
  const launchCommand = quoteCommandPath(backendPath);

  try {
    await Neutralino.os.execCommand(launchCommand, { background: true, cwd });
    return { status: 'launched', method: 'execCommand', backendPath, backendPathCandidates };
  } catch (execError) {
    try {
      await Neutralino.os.spawnProcess(launchCommand, { cwd });
      return { status: 'launched', method: 'spawnProcess', backendPath, backendPathCandidates };
    } catch (spawnError) {
      return {
        status: 'failed',
        backendPath,
        backendPathCandidates,
        error: { execError, spawnError }
      };
    }
  }
}

export function registerBackendShutdown(fetchImpl: typeof fetch = fetch): void {
  if (backendShutdownRegistered || !ensureNeutralinoClient()) return;

  backendShutdownRegistered = true;
  void Neutralino.events.on('windowClose', async () => {
    try {
      await fetchImpl(BACKEND_SHUTDOWN_URL, { method: 'POST' });
    } catch {
      // The backend may already be gone during app shutdown.
    }

    await Neutralino.app.exit();
  });
}

export async function showNeutralinoFolderDialog(title: string): Promise<string | null> {
  if (!ensureNeutralinoClient()) return null;

  const result = await Neutralino.os.showFolderDialog(title);
  return result ?? null;
}

export async function waitForBackendReady({
  attempts = 40,
  delayMs = 500,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl = fetch,
  onAttempt
}: BackendReadyOptions = {}): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(BACKEND_HEALTH_URL);
      if (response.ok) return true;
    } catch {
      // Backend is not ready yet.
    }

    onAttempt?.(attempt + 1);
    await delay(delayMs);
  }

  return false;
}

export function resetNeutralinoClientForTests(): void {
  neutralinoInitialized = false;
  backendShutdownRegistered = false;
}
