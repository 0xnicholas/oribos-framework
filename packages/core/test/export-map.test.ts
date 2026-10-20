import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `@oribos/core` 的导出表契约:根入口 + 每个公开入口一个子路径。
 * 子路径 ↔ 目录的映射形状来自 ADR-0002 / ADR-0014;`agent-run` 是能力包用的稳定小表面
 * (ADR-0018),与子系统入口同列在导出表里。
 */
const PUBLIC_ENTRIES = [
  'model',
  'agent',
  'agent-run',
  'tools',
  'observability',
  'workflows',
  'memory',
  'signals',
  'durable-agent',
  'schedules',
] as const;

interface ExportEntry {
  readonly types: string;
  readonly default: string;
}

function readExportMap(): Record<string, ExportEntry> {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, ExportEntry> };
  return packageJson.exports ?? {};
}

const exportMap = readExportMap();

describe('@oribos/core 导出表', () => {
  it.each(PUBLIC_ENTRIES)('子路径 ./%s 指向该入口的 dist 产物', (entry) => {
    expect(exportMap[`./${entry}`]).toEqual({
      types: `./dist/${entry}/index.d.ts`,
      default: `./dist/${entry}/index.js`,
    });
  });

  it('根入口指向组合根的 dist 产物', () => {
    expect(exportMap['.']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' });
  });

  it('导出表不声明清单之外的入口', () => {
    const declared = Object.keys(exportMap).sort();
    const expected = ['.', ...PUBLIC_ENTRIES.map((entry) => `./${entry}`)].sort();
    expect(declared).toEqual(expected);
  });

  it.each(PUBLIC_ENTRIES)('子路径 ./%s 有对应的源码入口', (entry) => {
    expect(existsSync(new URL(`../src/${entry}/index.ts`, import.meta.url))).toBe(true);
  });

  it('根入口有对应的源码入口', () => {
    expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(true);
  });
});
