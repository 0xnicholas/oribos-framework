import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, packageManifest, runScript } from './helpers/cli.js';

/**
 * 字节预算黄灯的 CLI 契约(M1-02 #23,ADR-0001):
 * 口径 = esbuild minify 后每个子路径导出入口的 bundle 字节数;基线落 byte-budget.json。
 * 超预算不是硬失败(CI 步骤 continue-on-error),但脚本以非零退出码把"需处理"带给调用方。
 * 输出流约定(全闸门统一,gate-kit 收编):报表面(标题 / 表格 / ok 行)与 CI 记录面
 * (::warning 注释、job summary)走 stdout,黄灯问题清单与硬错误走 stderr。
 */
afterEach(cleanupFixtures);

const EXPORTS = {
  '.': { types: './dist/index.d.ts', default: './dist/index.js' },
  './agent': { types: './dist/agent/index.d.ts', default: './dist/agent/index.js' },
};

function packageFixture(files: Readonly<Record<string, string>>): string {
  return fixturePackage({
    'package.json': packageManifest({ exports: EXPORTS }),
    'dist/index.js': "export const root = 'root';\n",
    'dist/agent/index.js': "export const agent = 'agent';\n",
    ...files,
  });
}

function budgetFixture(entries: Readonly<Record<string, number>>, metric = 'esbuild-minified-bytes'): string {
  return `${JSON.stringify({ metric, entries }, null, 2)}\n`;
}

describe('check-byte-budget:字节预算比对', () => {
  it('全部入口在预算内时通过,并记录当前字节数与 gzip', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999, './agent': 99999 }),
    });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('预算');
    expect(result.stdout).toContain('./agent');
    expect(result.stdout).toContain('gzip');
  });

  it('入口超预算时给出黄灯信号:非零退出并列出基线、当前与增量', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999, './agent': 1 }),
    });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('./agent');
    expect(result.stdout).toContain('超预算');
    expect(result.stdout).toMatch(/\+/);
    expect(result.stderr).toMatch(/基线\s*1\b/);
    expect(result.stderr).toContain('超预算');
  });

  it('新增入口没有基线时提示先建基线', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999 }),
    });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('./agent');
    expect(result.stderr).toContain('尚无预算基线');
    expect(result.stderr).toContain('byte-budget:update');
  });

  it('基线中已不再导出的入口视为陈旧', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999, './agent': 99999, './memory': 99999 }),
    });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('./memory');
    expect(result.stderr).toContain('已不再导出');
  });

  it('缺少基线文件时提示先建基线', () => {
    const dir = packageFixture({});

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('byte-budget.json');
    expect(result.stderr).toContain('byte-budget:update');
  });

  it('基线口径与脚本口径不符时拒绝比对(硬错误,退出 2)', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999, './agent': 99999 }, 'gzip-bytes'),
    });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('gzip-bytes');
  });

  it('入口产物缺失导致测量失败时退出 2(黄灯只覆盖需处理,不吞掉硬错误)', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({
        exports: { '.': { types: './dist/index.d.ts', default: './dist/missing.js' } },
      }),
      'byte-budget.json': budgetFixture({ '.': 99999 }),
    });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('测量 . 失败');
  });

  it('manifest JSON 非法时以退出码 2 干净报错,不抛栈(配置硬错误,不是黄灯)', () => {
    const dir = fixturePackage({ 'package.json': '{ 非法 JSON' });

    const result = runScript('check-byte-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stdout).toBe('');
  });

  it('--update 用实测值重写基线,随后校验通过', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 0, './agent': 0 }),
    });

    const updated = runScript('check-byte-budget', ['--update', dir]);

    expect(updated.status).toBe(0);
    const baseline = JSON.parse(readFileSync(join(dir, 'byte-budget.json'), 'utf8')) as {
      metric: string;
      entries: Record<string, number>;
    };
    expect(baseline.metric).toBe('esbuild-minified-bytes');
    expect(Object.keys(baseline.entries).sort()).toEqual(['.', './agent']);
    expect(baseline.entries['.']).toBeGreaterThan(0);
    expect(baseline.entries['./agent']).toBeGreaterThan(0);

    const checked = runScript('check-byte-budget', [dir]);
    expect(checked.status).toBe(0);
  });

  it('CI 环境下超预算输出 ::warning 注释,并把字节数写进 job summary', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999, './agent': 1 }),
    });
    const summaryPath = join(dir, 'summary.md');

    const result = runScript('check-byte-budget', [dir], {
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summaryPath,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::warning');
    expect(result.stdout).toContain('./agent');

    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain('| entry');
    expect(summary).toContain('./agent');
    expect(summary).toContain('超预算');
  });

  it('CI 环境下全部在预算内也写 job summary(记录字节数)', () => {
    const dir = packageFixture({
      'byte-budget.json': budgetFixture({ '.': 99999, './agent': 99999 }),
    });
    const summaryPath = join(dir, 'summary-ok.md');

    const result = runScript('check-byte-budget', [dir], { GITHUB_STEP_SUMMARY: summaryPath });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('::warning');
    expect(readFileSync(summaryPath, 'utf8')).toContain('./agent');
  });
});
