import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('folder import dialog wiring', () => {
  it('wires content add-folder actions once and guards against re-entry', async () => {
    const source = await readFile('src/main.ts', 'utf8');

    expect(source.match(/wireContentEmptyActions\(\);/g)).toHaveLength(1);
    expect(source).toContain('let isAddingFolder = false;');
    expect(source).toContain('if (isAddingFolder) return;');
  });
});
