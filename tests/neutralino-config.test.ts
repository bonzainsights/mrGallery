import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Neutralino release config', () => {
  it('does not open the native inspector in packaged window mode', async () => {
    const config = JSON.parse(await readFile('neutralino.config.json', 'utf8'));

    expect(config.modes.window.enableInspector).toBe(false);
  });
});
