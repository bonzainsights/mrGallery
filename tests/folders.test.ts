import { describe, expect, it } from 'vitest';
import { getFolderBranchOptions, normalizeFolderPath } from '../src/lib/folders';

describe('folder branch helpers', () => {
  it('normalizes folder paths without changing filesystem roots', () => {
    expect(normalizeFolderPath(' /Users/achbj/Movies/ ')).toBe('/Users/achbj/Movies');
    expect(normalizeFolderPath('C:\\Users\\achbj\\Movies\\')).toBe('C:\\Users\\achbj\\Movies');
    expect(normalizeFolderPath('/')).toBe('/');
    expect(normalizeFolderPath('C:\\')).toBe('C:\\');
  });

  it('builds removable branch options with aggregate counts', () => {
    const options = getFolderBranchOptions([
      { path: '/Users/achbj/Movies/blablablainternet/instadn', count: 10 },
      { path: '/Users/achbj/Movies/blablablainternet/cache', count: 4 },
      { path: '/Users/achbj/Movies/other', count: 2 }
    ]);

    expect(options).toContainEqual({ path: '/Users/achbj/Movies', count: 16, depth: 3 });
    expect(options).toContainEqual({ path: '/Users/achbj/Movies/blablablainternet', count: 14, depth: 4 });
    expect(options).toContainEqual({ path: '/Users/achbj/Movies/blablablainternet/instadn', count: 10, depth: 5 });
  });
});
