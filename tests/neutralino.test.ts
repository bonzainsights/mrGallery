import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@neutralinojs/lib', () => ({
  app: {
    exit: vi.fn()
  },
  events: {
    on: vi.fn()
  },
  filesystem: {
    getStats: vi.fn()
  },
  init: vi.fn(),
  os: {
    execCommand: vi.fn(),
    showFolderDialog: vi.fn(),
    spawnProcess: vi.fn()
  }
}));

import * as Neutralino from '@neutralinojs/lib';
import {
  getBundledBackendPath,
  getBundledBackendPathCandidates,
  hasNeutralinoGlobals,
  isNeutralinoDevRuntime,
  quoteCommandPath,
  resetNeutralinoClientForTests,
  showNeutralinoFolderDialog,
  startBundledBackend,
  waitForBackendReady,
  type NeutralinoRuntimeWindow
} from '../src/lib/neutralino';

const neutralinoWindow: NeutralinoRuntimeWindow = {
  NL_EXTENSION: '.exe',
  NL_MODE: 'window',
  NL_PATH: 'C:/Users/Test User/MrGallery-Windows',
  NL_PORT: 55111,
  NL_TOKEN: 'access.connect'
};

const backendStats = {
  createdAt: 1,
  isDirectory: false,
  isFile: true,
  modifiedAt: 1,
  size: 1
};

function mockExistingBackend(path: string): void {
  vi.mocked(Neutralino.filesystem.getStats).mockImplementation(async (candidate) => {
    if (candidate === path) return backendStats;
    throw new Error(`Missing file: ${candidate}`);
  });
}

describe('Neutralino runtime helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNeutralinoClientForTests();
    Reflect.deleteProperty(globalThis, 'window');
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('detects only packaged Neutralino window runtime globals', () => {
    expect(hasNeutralinoGlobals(undefined)).toBe(false);
    expect(hasNeutralinoGlobals({ NL_MODE: 'window' })).toBe(false);
    expect(hasNeutralinoGlobals(neutralinoWindow)).toBe(true);
  });

  it('detects Neutralino dev runtime args', () => {
    expect(isNeutralinoDevRuntime(neutralinoWindow)).toBe(false);
    expect(isNeutralinoDevRuntime({
      ...neutralinoWindow,
      NL_ARGS: ['mr-gallery', '--neu-dev-auto-reload']
    })).toBe(true);
  });

  it('resolves and quotes the bundled backend executable path', () => {
    expect(getBundledBackendPath(neutralinoWindow)).toBe('C:/Users/Test User/MrGallery-Windows/backend.exe');
    expect(getBundledBackendPathCandidates(neutralinoWindow)).toEqual([
      'C:/Users/Test User/MrGallery-Windows/backend.exe'
    ]);
    expect(quoteCommandPath('C:/Users/Test User/MrGallery-Windows/backend.exe')).toBe(
      '"C:/Users/Test User/MrGallery-Windows/backend.exe"'
    );
  });

  it('tries backend.exe when Neutralino does not provide an extension', () => {
    expect(getBundledBackendPathCandidates({
      ...neutralinoWindow,
      NL_EXTENSION: undefined
    })).toEqual([
      'C:/Users/Test User/MrGallery-Windows/backend',
      'C:/Users/Test User/MrGallery-Windows/backend.exe'
    ]);
  });

  it('starts the bundled backend with background execCommand in Neutralino mode', async () => {
    mockExistingBackend('C:/Users/Test User/MrGallery-Windows/backend.exe');
    vi.mocked(Neutralino.os.execCommand).mockResolvedValue({
      exitCode: 0,
      pid: 1234,
      stdErr: '',
      stdOut: ''
    });

    const result = await startBundledBackend(neutralinoWindow);

    expect(result).toEqual({
      backendPath: 'C:/Users/Test User/MrGallery-Windows/backend.exe',
      backendPathCandidates: ['C:/Users/Test User/MrGallery-Windows/backend.exe'],
      method: 'execCommand',
      status: 'launched'
    });
    expect(Neutralino.init).toHaveBeenCalledWith({ exportCustomMethods: false });
    expect(Neutralino.os.execCommand).toHaveBeenCalledWith(
      '"C:/Users/Test User/MrGallery-Windows/backend.exe"',
      { background: true, cwd: 'C:/Users/Test User/MrGallery-Windows' }
    );
    expect(Neutralino.os.spawnProcess).not.toHaveBeenCalled();
  });

  it('falls back to spawnProcess when background execCommand fails', async () => {
    mockExistingBackend('C:/Users/Test User/MrGallery-Windows/backend.exe');
    vi.mocked(Neutralino.os.execCommand).mockRejectedValue(new Error('exec failed'));
    vi.mocked(Neutralino.os.spawnProcess).mockResolvedValue({ id: 1, pid: 1234 });

    const result = await startBundledBackend(neutralinoWindow);

    expect(result.status).toBe('launched');
    expect(result.method).toBe('spawnProcess');
    expect(Neutralino.os.spawnProcess).toHaveBeenCalledWith(
      '"C:/Users/Test User/MrGallery-Windows/backend.exe"',
      { cwd: 'C:/Users/Test User/MrGallery-Windows' }
    );
  });

  it('finds the backend next to the Windows app when NL_PATH points at a file', async () => {
    const windowsPackagedWindow: NeutralinoRuntimeWindow = {
      ...neutralinoWindow,
      NL_ARGS: ['C:\\Users\\Test User\\MrGallery-Windows\\mr-gallery-win_x64.exe'],
      NL_PATH: 'C:\\Users\\Test User\\MrGallery-Windows\\resources.neu'
    };

    mockExistingBackend('C:/Users/Test User/MrGallery-Windows/backend.exe');
    vi.mocked(Neutralino.os.execCommand).mockResolvedValue({
      exitCode: 0,
      pid: 1234,
      stdErr: '',
      stdOut: ''
    });

    const result = await startBundledBackend(windowsPackagedWindow);

    expect(getBundledBackendPathCandidates(windowsPackagedWindow)).toEqual([
      'C:/Users/Test User/MrGallery-Windows/resources.neu/backend.exe',
      'C:/Users/Test User/MrGallery-Windows/backend.exe'
    ]);
    expect(result.status).toBe('launched');
    expect(result.backendPath).toBe('C:/Users/Test User/MrGallery-Windows/backend.exe');
  });

  it('fails with tried paths when the bundled backend is missing', async () => {
    vi.mocked(Neutralino.filesystem.getStats).mockRejectedValue(new Error('missing'));

    const result = await startBundledBackend(neutralinoWindow);

    expect(result.status).toBe('failed');
    expect(result.backendPathCandidates).toEqual(['C:/Users/Test User/MrGallery-Windows/backend.exe']);
    expect(result.error).toEqual(expect.any(Error));
    expect((result.error as Error).message).toContain('Bundled backend executable was not found');
    expect(Neutralino.os.execCommand).not.toHaveBeenCalled();
    expect(Neutralino.os.spawnProcess).not.toHaveBeenCalled();
  });

  it('skips auto-launch in Neutralino dev mode when no bundled backend exists', async () => {
    vi.mocked(Neutralino.filesystem.getStats).mockRejectedValue(new Error('missing'));

    const result = await startBundledBackend({
      ...neutralinoWindow,
      NL_ARGS: ['mr-gallery', '--neu-dev-auto-reload']
    });

    expect(result).toEqual({
      backendPathCandidates: ['C:/Users/Test User/MrGallery-Windows/backend.exe'],
      status: 'skipped'
    });
    expect(Neutralino.os.execCommand).not.toHaveBeenCalled();
    expect(Neutralino.os.spawnProcess).not.toHaveBeenCalled();
  });

  it('skips backend launch outside Neutralino runtime', async () => {
    const result = await startBundledBackend(undefined);

    expect(result).toEqual({ status: 'skipped' });
    expect(Neutralino.init).not.toHaveBeenCalled();
    expect(Neutralino.os.execCommand).not.toHaveBeenCalled();
  });

  it('uses Neutralino folder dialog when runtime globals are available', async () => {
    Object.assign(globalThis, { window: neutralinoWindow });
    vi.mocked(Neutralino.os.showFolderDialog).mockResolvedValue('D:/Photos');

    await expect(showNeutralinoFolderDialog('Select a folder')).resolves.toBe('D:/Photos');
    expect(Neutralino.os.showFolderDialog).toHaveBeenCalledWith('Select a folder');
  });
});

describe('backend readiness polling', () => {
  it('retries until the backend responds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const ready = await waitForBackendReady({
      delay: async () => undefined,
      fetchImpl
    });

    expect(ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns false after all attempts fail', async () => {
    const onAttempt = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection refused'));

    const ready = await waitForBackendReady({
      attempts: 3,
      delay: async () => undefined,
      fetchImpl,
      onAttempt
    });

    expect(ready).toBe(false);
    expect(onAttempt).toHaveBeenCalledTimes(3);
  });
});
