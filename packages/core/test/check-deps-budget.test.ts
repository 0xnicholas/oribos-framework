import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, packageManifest, runScript } from './helpers/cli.js';

/**
 * 依赖数字黄灯的 CLI 契约(ADR-0015 M5 修订)。测量口径要 npm/registry(网络),
 * verify 硬约束无网络(ADR-0015)——本文件只测离线可达的契约面:
 * 零依赖免基线、口径不符硬错误(退出 2)、manifest 不可读硬错误(退出 2)、workspace 范围守护、
 * npm 解析超时硬错误(退出 2,1 ms 超时起手即杀,不等网络)、慢链路出口值非法硬错误(退出 2,不起 npm);
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
      'app/package.json': packageManifest({
        dependencies: { '@oribos/mcp-server': 'workspace:^' },
      }),
      // 叶子判词要读目标包清单:非叶子目标(dependencies 携 @oribos 边)真实在场,守护消息才可达。
      'mcp-server/package.json': packageManifest({
        dependencies: { '@oribos/core': 'workspace:^' },
      }),
    });

    const result = runScript('check-deps-budget', [join(dir, 'app')]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('workspace');
    expect(result.stderr).toContain('@oribos/mcp-server');
  });

  it('dependencies 里的过判词叶子是豁免边(不打 workspace 硬错误,走基线黄灯)', () => {
    const dir = fixturePackage({
      'app/package.json': packageManifest({
        dependencies: { '@oribos/leafy': 'workspace:^' },
      }),
      // 叶子 = 运行时 @oribos 边仅 peer core、零外部依赖(免 npm,离线可达)。
      'leafy/package.json': packageManifest({
        peerDependencies: { '@oribos/core': 'workspace:^' },
      }),
    });

    const result = runScript('check-deps-budget', [join(dir, 'app')]);

    // 叶子边放行测量(叶子外部闭包 0 + 本体 1 包),无基线 = 黄灯退出 1,不是硬错误 2。
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('显式单议');
    expect(result.stdout).toContain('@oribos/leafy');
    expect(result.stdout).toContain('未建基线');
  });

  it('零 @oribos/* 运行时边的公共包可作叶子(ADR-0020 放宽),测 1 包 / 0 B 下界', () => {
    const dir = fixturePackage({
      'app/package.json': packageManifest({
        dependencies: { '@oribos/plain-leaf': 'workspace:^' },
      }),
      // 零 @oribos 边、零外部依赖、公共包:新判词下的合法叶子。
      'plain-leaf/package.json': packageManifest({ private: false }),
    });

    const result = runScript('check-deps-budget', [join(dir, 'app')]);

    // 放行测量(外部闭包 0 + 本体 1 包 / 0 B),无基线 = 黄灯退出 1,不是硬错误 2。
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('显式单议');
    expect(result.stdout).toContain('@oribos/plain-leaf');
    expect(result.stdout).toContain('1 包');
    expect(result.stdout).toContain('0 B');
  });

  it('private: true 的目标不得作叶子(硬错误,退出 2)', () => {
    const dir = fixturePackage({
      'app/package.json': packageManifest({
        dependencies: { '@oribos/hidden': 'workspace:^' },
      }),
      // 未发布的包不得变成运行时依赖,即便零 @oribos 边。
      'hidden/package.json': packageManifest({ private: true }),
    });

    const result = runScript('check-deps-budget', [join(dir, 'app')]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('@oribos/hidden');
    expect(result.stderr).toContain('private: true');
  });

  it('非 core 的 peer workspace 边拒绝作叶子(硬错误,退出 2)', () => {
    const dir = fixturePackage({
      'app/package.json': packageManifest({
        dependencies: { '@oribos/peer-leaf': 'workspace:^' },
      }),
      // peer 豁免只认 @oribos/core;其余 peer workspace 边不是叶子。
      'peer-leaf/package.json': packageManifest({
        peerDependencies: { '@oribos/semconv': 'workspace:^' },
      }),
    });

    const result = runScript('check-deps-budget', [join(dir, 'app')]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('@oribos/peer-leaf');
    expect(result.stderr).toContain('workspace');
  });

  it('目标自身依赖另一个 @oribos 包(能力包之间的边)拒绝作叶子(硬错误,退出 2)', () => {
    const dir = fixturePackage({
      'app/package.json': packageManifest({
        dependencies: { '@oribos/another-capability': 'workspace:^' },
      }),
      // peer core 不掩盖另一条 @oribos 依赖边:它不是叶子。
      'another-capability/package.json': packageManifest({
        peerDependencies: { '@oribos/core': 'workspace:^' },
        dependencies: { '@oribos/inngest': 'workspace:^' },
      }),
    });

    const result = runScript('check-deps-budget', [join(dir, 'app')]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('@oribos/another-capability');
    expect(result.stderr).toContain('workspace');
  });

  it('npm 解析超时是硬错误(退出 2),报错带镜像 / 超时两个出口的实名', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ dependencies: { zod: '^4.0.0' } }),
    });

    // 1 ms 超时:npm 起手即被杀,是慢链路上冷 packument 卡死的离线等价形态(不等网络)。
    const result = runScript('check-deps-budget', [dir], {
      ORIBOS_DEPS_BUDGET_NPM_TIMEOUT_MS: '1',
      ORIBOS_DEPS_BUDGET_REGISTRY: 'https://registry.example.test/',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('npm 解析超时');
    expect(result.stderr).toContain('https://registry.example.test');
    expect(result.stderr).toContain('ORIBOS_DEPS_BUDGET_NPM_TIMEOUT_MS');
    expect(result.stderr).toContain('ORIBOS_DEPS_BUDGET_REGISTRY');
    expect(result.stdout).toBe('');
  });

  it.each(['300s', '1e16'])(
    '超时值 %s 非法时是配置硬错误(退出 2),不落成调用栈',
    (value) => {
      const dir = fixturePackage({
        'package.json': packageManifest({ dependencies: { zod: '^4.0.0' } }),
      });

      // '300s' → NaN、'1e16' → 超 Node 的 2^53-1 上限:两者都让 spawnSync 抛范围错误、
      // 以退出码 1 撞进 CI 的容忍档(只容忍 1)——须在这里挡住。
      const result = runScript('check-deps-budget', [dir], {
        ORIBOS_DEPS_BUDGET_NPM_TIMEOUT_MS: value,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ORIBOS_DEPS_BUDGET_NPM_TIMEOUT_MS');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stdout).toBe('');
    },
  );

  it('镜像地址非法(非 http(s) URL)是配置硬错误(退出 2),不起 npm', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ dependencies: { zod: '^4.0.0' } }),
    });

    // 掉 scheme 的镜像基址:要在起 npm 之前挡住,不让它落成下游怪 URL 的噪音报错。
    const result = runScript('check-deps-budget', [dir], {
      ORIBOS_DEPS_BUDGET_REGISTRY: 'registry.example.test/npm',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ORIBOS_DEPS_BUDGET_REGISTRY');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stdout).toBe('');
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
