import { describe, expect, it } from 'vitest';
import { asStringList, parseFrontmatter } from '../src/frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns the body untouched when there is no frontmatter', () => {
    const r = parseFrontmatter('# Title\n\ntext');
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe('# Title\n\ntext');
  });

  it('parses scalars, quoted strings, booleans and inline lists', () => {
    const r = parseFrontmatter(
      '---\nname: my-skill\ndescription: "Use when: things happen"\nalwaysApply: true\nglobs: [src/**/*.ts, "*.md"]\ncount: 3\n---\nbody',
    );
    expect(r.frontmatter).toEqual({
      name: 'my-skill',
      description: 'Use when: things happen',
      alwaysApply: true,
      globs: ['src/**/*.ts', '*.md'],
      count: 3,
    });
    expect(r.body).toBe('body');
  });

  it('parses block lists and block scalars', () => {
    const r = parseFrontmatter(
      '---\npaths:\n  - "src/**"\n  - test/**\ndescription: >\n  folded\n  text\nnotes: |\n  line one\n  line two\n---\n',
    );
    expect(r.frontmatter).toEqual({
      paths: ['src/**', 'test/**'],
      description: 'folded text',
      notes: 'line one\nline two',
    });
  });

  it('keeps unquoted descriptions containing colons', () => {
    const r = parseFrontmatter('---\ndescription: Use this when: foo or bar\n---\n');
    expect(r.frontmatter?.description).toBe('Use this when: foo or bar');
  });

  it('flags an unterminated block as malformed and keeps the text', () => {
    const r = parseFrontmatter('---\nname: x\nno end');
    expect(r.malformed).toBe(true);
    expect(r.frontmatter).toBeNull();
  });
});

describe('asStringList', () => {
  it('accepts arrays and comma-separated strings', () => {
    expect(asStringList(['a', 'b'])).toEqual(['a', 'b']);
    expect(asStringList('*.py, *.js')).toEqual(['*.py', '*.js']);
    expect(asStringList(undefined)).toEqual([]);
  });
});
