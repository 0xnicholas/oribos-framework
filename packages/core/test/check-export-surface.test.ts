import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, fixturePackage, packageManifest, runScript } from './helpers/cli.js';

/**
 * 导出面执法点的 CLI 契约(balsa-docs api-reference §6 / §7,框架侧前置 #82):
 * 「导出面 = 文档面」——被公共签名引用的类型必须能从**某个子路径入口** import,否则参考树里
 * 这些类型无页、交叉链接断链。
 *
 * 判定扫产物:`dist/*.d.ts` 里可判定的公共声明(名字出现在某个入口的导出表里,且该文件从该入口可达)
 * 文本中,**类型位置**的标识符必须解析到某个入口导出的名字。
 * 唯一排除通道 = 源码 JSDoc 的 `@internal`(生成侧 `excludeInternal` 同源),不另设白名单。
 *
 * 退出码契约(沿 ADR-0015):0 = 干净;1 = 有缺口(需处理);2 = 配置/产物硬错误。
 * 本套件只测 CLI 这个接缝。输出流约定(全闸门统一,gate-kit 收编):报表面(ok 进度行)走
 * stdout,问题(缺口)与硬错误走 stderr。
 */
afterEach(cleanupFixtures);

const ROOT_ONLY = {
  '.': { types: './dist/index.d.ts', default: './dist/index.js' },
};

/** 缺口行(stderr 里以 `缺口 ` 起头);其余行是汇总,ok 进度行在 stdout。 */
function gaps(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('缺口'));
}

describe('check-export-surface:被公共签名引用的类型必须有页', () => {
  it('类型不从任何入口导出时变红:报出名字、引用它的公共声明与出处', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/index.d.ts': "export { createTool } from './tool.js';\n",
      'dist/tool.d.ts': [
        '/** The `execute` input type a schema implies. */',
        'type SchemaInput = string;',
        'export declare function createTool(config: { execute(input: SchemaInput): void }): void;',
        '',
      ].join('\n'),
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(1);
    expect(gaps(result.stderr)).toHaveLength(1);
    expect(gaps(result.stderr)[0]).toContain('SchemaInput');
    expect(gaps(result.stderr)[0]).toContain('createTool');
    expect(gaps(result.stderr)[0]).toContain('dist/tool.d.ts');
  });

  it('类型从入口导出时通过,并逐个子路径报 ok', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/index.d.ts': [
        "export { createTool } from './tool.js';",
        "export type { SchemaInput } from './tool.js';",
        '',
      ].join('\n'),
      'dist/tool.d.ts': [
        'export type SchemaInput = string;',
        'export declare function createTool(config: { execute(input: SchemaInput): void }): void;',
        '',
      ].join('\n'),
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok  fixture');
  });

  it('只被内部声明引用的类型放行:执法点对着公共签名,不是产物里的私有名字', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/index.d.ts': "export { createTool } from './tool.js';\n",
      'dist/tool.d.ts': [
        'type SchemaInput = string;',
        'type InternalOptions = { readonly input: SchemaInput };',
        'export declare function createTool(config: InternalOptions): void;',
        '',
      ].join('\n'),
    });

    const result = runScript('check-export-surface', [dir]);

    // 公共签名点名的是 `InternalOptions`(它自己没有页,是缺口);
    // 只有内部声明碰过的 `SchemaInput` 不随之变红。
    expect(result.status).toBe(1);
    expect(gaps(result.stderr)).toHaveLength(1);
    expect(gaps(result.stderr)[0]).toContain('InternalOptions');
  });

  it('@internal 标注即放行:唯一排除通道,不另设白名单', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/index.d.ts': "export { createTool } from './tool.js';\n",
      'dist/tool.d.ts': [
        '/**',
        ' * Internal-only carrier.',
        ' *',
        ' * @internal',
        ' */',
        'type SchemaInput = string;',
        'export declare function createTool(config: { execute(input: SchemaInput): void }): void;',
        '',
      ].join('\n'),
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(0);
    expect(gaps(result.stderr)).toHaveLength(0);
  });

  it('类型由另一个子路径入口导出时通过:判定是"有页",不是"逐个入口自足"', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './tools': { types: './dist/tools/index.d.ts', default: './dist/tools/index.js' },
        },
      }),
      'dist/index.d.ts': [
        "export { agent } from './agent.js';",
        "export type { AgentConfig } from './agent.js';",
        '',
      ].join('\n'),
      'dist/agent.d.ts': [
        "import type { Tool } from './tools/tool.js';",
        'export interface AgentConfig {',
        '    readonly tools?: Tool;',
        '}',
        'export declare function agent(config: AgentConfig): void;',
        '',
      ].join('\n'),
      'dist/tools/index.d.ts': "export type { Tool } from './tool.js';\n",
      'dist/tools/tool.d.ts': 'export type Tool = { readonly name: string };\n',
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(0);
  });

  it('成员名与参数名不误报:同名内部函数/属性不是类型引用', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/index.d.ts': "export type { StepContext } from './step.js';\n",
      'dist/step.d.ts': [
        'export interface StepContext {',
        '    readonly copy: string;',
        '    getStepResult(stepId: string): unknown;',
        '}',
        'export declare function copy(source: string): string;',
        'export declare function getStepResult(stepId: string): unknown;',
        '',
      ].join('\n'),
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(0);
  });

  it('名字已从所在模块导出时不再多提一句:修法只是入口再导出', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/index.d.ts': "export { createWorkflowRun } from './run.js';\n",
      'dist/run.d.ts': [
        "import type { WalkOptions } from './walker.js';",
        'export declare function createWorkflowRun(options: WalkOptions): void;',
        '',
      ].join('\n'),
      'dist/walker.d.ts': 'export type WalkOptions = { readonly trace: boolean };\n',
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(1);
    expect(gaps(result.stderr)).toHaveLength(1);
    expect(gaps(result.stderr)[0]).toContain('WalkOptions');
    expect(gaps(result.stderr)[0]).not.toContain('未从所在模块导出');
  });

  it('入口声明的产物缺失时以退出码 2 报错,不把"没测成"读成"干净"', () => {
    const dir = fixturePackage({
      'package.json': packageManifest({ exports: ROOT_ONLY }),
      'dist/other.d.ts': 'export type Unrelated = string;\n',
    });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('./dist/index.d.ts');
  });

  it('exports 表为空时以退出码 2 报错:没有入口就没有执法对象', () => {
    const dir = fixturePackage({ 'package.json': packageManifest({ exports: {} }) });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(2);
  });

  it('manifest JSON 非法时以退出码 2 干净报错,不抛栈(配置硬错误)', () => {
    const dir = fixturePackage({ 'package.json': '{ 非法 JSON' });

    const result = runScript('check-export-surface', [dir]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package.json');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stdout).toBe('');
  });
});
