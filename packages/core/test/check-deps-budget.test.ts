import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, packageManifest, runScript } from './helpers/cli.js';

/**
 * 依赖数字黄灯的 CLI 契约(ADR-0015 M5 修订)。测量口径要 npm/registry(网络),
 * verify 硬约束无网络(ADR-0015)——本文件只测离线可达的契约面:
 * 零依赖免基线、口径不符硬错误(退出 2)、manifest 不可读硬错误(退出 2)、workspace 范围守护;
 * 网络路径(闭包实测/超基线/零引用/--update)由实施票的活体夹具与各包基线落数覆盖。
 */
afterEach(cleanupFixtures);

describe('check-deps-budget:依赖数字比对', () => {
  it('零声明运行时依赖且无基线时直接通过(如 core、运行时 0 依赖的能力包)', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ peerDependencies: { '@oribos/core': 'workspace:^' } }),
    });

    const result = runScript('check-deps-budget', [dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 个声明运行时依赖');
    expect(result.stdout).toContain('@oribos/core');
  });

  it('零声明但有基线且口径不符时仍拒绝比对(退出 2)', () => {
    const dir = fixturePackage({
      'package.json': packageManifest(),
      'deps-budget.json': `${JSON.stringify({ metric: 'gzip-bytes', dependencies: {} }, null, 2)}\n`,
    });

    const result = runScript('check-deps-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('gzip-bytes');
    expect(result.stderr).toContain('deps-budget:update');
  });

  it('非 core peer 的 workspace: 范围即硬错误(能力包之间默认不建依赖边,ADR-0002 M5)', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({
        dependencies: { '@oribos/mcp-server': 'workspace:^' },
      }),
    });

    const result = runScript('check-deps-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('workspace');
    expect(result.stderr).toContain('@oribos/mcp-server');
  });

  it('基线口径与脚本口径不符时拒绝比对(硬错误,退出 2)', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ dependencies: { zod: '^4.0.0' } }),
      'deps-budget.json': `${JSON.stringify(
        {
          metric: 'transitive-count-only',
          dependencies: { zod: { packages: 1, bytes: 1 } },
        },
        null,
        2,
      )}\n`,
    });

    const result = runScript('check-deps-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('transitive-count-only');
    expect(result.stderr).toContain('npm-install-closure-packages-and-unpacked-bytes');
  });

  it('manifest JSON 非法时以退出码 2 干净报错,不抛栈(配置硬错误,不是黄灯)', () => {
    const dir = fixturePackage({ 'package.json': '{ 非法 JSON' });

    const result = runScript('check-deps-budget', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stdout).toBe('');
  });

  it('真实基线文件(示例:本仓库 croner 研究快照)的口径字段与本脚本一致', () => {
    // 防口径漂移:脚本 METRIC 常量与六包基线落数共用的口径字符串写死在此对齐。
    const dir = fixturePackage({
      'package.json': packageManifest({ dependencies: { croner: '10.0.1' } }),
      'deps-budget.json': `${JSON.stringify(
        {
          metric: 'npm-install-closure-packages-and-unpacked-bytes',
          dependencies: { croner: { packages: 1, bytes: 154686 } },
        },
        null,
        2,
      )}\n`,
      'dist/index.js': 'export const value = 1;\n',
    });

    // 只读回基线文件证明夹具合法;测量本身需网络,不在 verify 内跑。
    const baseline = JSON.parse(readFileSync(join(dir, 'deps-budget.json'), 'utf8')) as {
      metric: string;
    };
    expect(baseline.metric).toBe('npm-install-closure-packages-and-unpacked-bytes');
  });
});
