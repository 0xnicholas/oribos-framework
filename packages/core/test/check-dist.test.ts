import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, packageManifest, runScript } from './helpers/cli.js';

/**
 * 产物面硬闸门的 CLI 契约(ADR-0014「纯 ESM + 子路径导出表」,ADR-0015 M5「脚本落位」):
 * 按 `exports` 表逐子路径验真——每个条件声明的产物必须在盘上,子路径要能被 `require.resolve()`
 * 解析、`import()` 加载、`require()` 走通(ESM 与 require(esm) 两条路)。
 *
 * 退出码契约(沿 ADR-0015,#113 裁决对齐 check-export-surface):0 = 干净;1 = 公开面缺口
 * (产物在盘上但解析或加载失败);2 = 配置·产物硬错误(`exports` 表为空 / 缺 dist / 子路径声明
 * 产物缺失 / manifest 不可读)——「闸门没跑成」不混进「公开面真坏」;硬错误优先于缺口,两类都报。
 *
 * 夹具由测试自身构造(临时包目录 + 自带可加载的 ESM 产物 + 显式 `type: "module"`),不依赖仓库
 * 自身构建;断言只碰外部行为(退出码 / stdout 的 `ok` 进度行 / stderr 的缺口行),脚本内部重构
 * 不造成假红。输出流约定(全闸门统一,gate-kit 收编):报表面 stdout、问题 stderr——
 * 缺口与硬错误都报在 stderr,check-export-surface 同一约定。
 */
afterEach(cleanupFixtures);

const ROOT_ENTRY = { types: './dist/index.d.ts', default: './dist/index.js' };
const TOOLS_ENTRY = { types: './dist/tools/index.d.ts', default: './dist/tools/index.js' };

const ROOT_ONLY = { '.': ROOT_ENTRY };

const TWO_SUBPATHS = { '.': ROOT_ENTRY, './tools': TOOLS_ENTRY };

/** 坏子路径在前、好子路径在后:fail-fast 实现会在坏处停住,后一个好子路径就不会被验到。 */
const BAD_THEN_GOOD = { './tools': TOOLS_ENTRY, '.': ROOT_ENTRY };

const ROOT_JS = "export const root = 'root';\n";
/**
 * top-level await 的 ESM 图:`import()` 可加载,`require()` 抛 ERR_REQUIRE_ASYNC_MODULE——
 * 本套件全部夹具里唯一能把「`import()` 加载」与「`require()` 走通」两条路分开的产物。
 */
const ROOT_TLA_JS = "export const root = await Promise.resolve('root');\n";
const ROOT_DTS = 'export declare const root: string;\n';
const TOOLS_JS = "export const tools = 'tools';\n";
const TOOLS_DTS = 'export declare const tools: string;\n';

const ROOT_ARTIFACTS = { 'dist/index.js': ROOT_JS, 'dist/index.d.ts': ROOT_DTS };
const TOOLS_ARTIFACTS = { 'dist/tools/index.js': TOOLS_JS, 'dist/tools/index.d.ts': TOOLS_DTS };

/** 夹具包:`type: "module"` 显式声明、exports 表与产物路径对应,不依赖 Node 的语法探测。 */
function packageFixture(
  exportsMap: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>> = {},
): string {
  return fixturePackage({
    'package.json': packageManifest({ type: 'module', exports: exportsMap }),
    ...files,
  });
}

/** stdout 里的 `ok` 进度行,取其中的子路径标识(其余行是缺口与汇总输出)。 */
function okSubpaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('ok  '))
    .map((line) => line.slice('ok  '.length));
}

describe('check-dist:exports 表逐子路径验真', () => {
  it('多子路径产物齐备时通过,逐子路径报 ok', () => {
    const dir = packageFixture(TWO_SUBPATHS, { ...ROOT_ARTIFACTS, ...TOOLS_ARTIFACTS });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(0);
    expect(okSubpaths(result.stdout)).toEqual(['fixture', 'fixture/tools']);
    expect(result.stderr).toBe('');
  });

  it('子路径声明产物缺失时以退出码 2 报错:闸门没跑成,不是公开面缺口', () => {
    const dir = packageFixture(ROOT_ONLY, { 'dist/index.d.ts': ROOT_DTS });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fixture: 缺产物 ./dist/index.js');
  });

  it('产物在盘上但加载抛错时留 1(公开面缺口):报「导入失败」与原因', () => {
    const dir = packageFixture(ROOT_ONLY, {
      'dist/index.js': "throw new Error('夹具产物加载失败');\n",
      'dist/index.d.ts': ROOT_DTS,
    });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture: 导入失败');
    expect(result.stderr).toContain('夹具产物加载失败');
  });

  it('产物 import() 通过但 require() 抛错时留 1:require 通路不被 import 通路掩盖', () => {
    // 夹具只有 require 侧走不通——脚本若不再走 require 通路,这一例是唯一会变绿的
    // (其余夹具两条路同真同假),即 require 通路被删 / 被绕过的回归由此例拦下。
    const dir = packageFixture(ROOT_ONLY, {
      'dist/index.js': ROOT_TLA_JS,
      'dist/index.d.ts': ROOT_DTS,
    });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture: 导入失败');
    // 钉 require(esm) 的公开报错(ERR_REQUIRE_ASYNC_MODULE 的 message):脚本只印 error.message,
    // 错误码本身不上 stderr;该消息在 Node 22.12–26.2 各版本上一致(实测,CI 基线 22.13 在内)。
    expect(result.stderr).toContain(
      'require() cannot be used on an ESM graph with top-level await',
    );
    expect(okSubpaths(result.stdout)).toEqual([]);
  });

  it('exports 表为空时以退出码 2 报错:没有子路径就没有校验对象', () => {
    const dir = packageFixture({});

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exports 表为空');
    expect(result.stderr).toContain('无可校验的子路径');
    expect(result.stdout).toBe('');
  });

  it('多条件里仅 types 缺产物也以退出码 2 报错:逐条件校验,不只查 default', () => {
    // default 侧产物齐备且可加载——只查 default 的实现会把这一夹具读成干净。
    const dir = packageFixture(ROOT_ONLY, { 'dist/index.js': ROOT_JS });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fixture: 缺产物 ./dist/index.d.ts');
    // 缺产物的子路径不试解析(那只会重复报一遍「Cannot find module」),也不报 ok。
    expect(okSubpaths(result.stdout)).toEqual([]);
  });

  it('一好一坏时以退出码 2 报错:坏的报硬错误、好的照常报 ok(不因一坏中断)', () => {
    const dir = packageFixture(BAD_THEN_GOOD, {
      ...ROOT_ARTIFACTS,
      'dist/tools/index.d.ts': TOOLS_DTS,
    });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(okSubpaths(result.stdout)).toEqual(['fixture']);
    expect(result.stderr).toContain('fixture/tools: 缺产物 ./dist/tools/index.js');
  });

  it('整个 dist 缺失时以退出码 2 报错:提示先构建,不逐子路径报噪音', () => {
    const dir = packageFixture(TWO_SUBPATHS);

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('缺产物目录 dist');
    expect(result.stderr).toContain('pnpm build');
    expect(result.stdout).toBe('');
  });

  it('manifest 不可读 / JSON 非法时以退出码 2 干净报错,不抛栈', () => {
    const dir = fixturePackage({ 'package.json': '{ 非法 JSON' });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stdout).toBe('');
  });

  it('manifest 根本不存在时同样以退出码 2 干净报错(读不通与读不到同档)', () => {
    const dir = fixturePackage({});

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json');
    expect(result.stderr).not.toContain('\n    at ');
  });

  it('硬错误盖过缺口:两类都报出来,退出码取 2', () => {
    const dir = packageFixture(BAD_THEN_GOOD, {
      'dist/index.js': "throw new Error('夹具产物加载失败');\n",
      'dist/index.d.ts': ROOT_DTS,
      'dist/tools/index.d.ts': TOOLS_DTS,
    });

    const result = runScript('check-dist', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fixture/tools: 缺产物 ./dist/tools/index.js');
    expect(result.stderr).toContain('fixture: 导入失败');
    expect(okSubpaths(result.stdout)).toEqual([]);
  });
});
