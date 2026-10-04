// 依赖红线硬闸门(ADR-0015,M5 修订推广):产物的导入说明符只允许
// Node 内置 ∪ 相对/绝对路径 ∪ 本包 manifest 运行时字段(dependencies ∪ optionalDependencies
// ∪ peerDependencies)声明的包名——「仅声明依赖」;名字精确匹配、含子路径(`pkg/sub`)。
// 零运行时依赖的包(@oribos/core,ADR-0001 硬线)合法集恒为空集:三字段非空即红,原语义不变。
// devDependencies 不在合法集——源码误引 devDependency(清单却干净)的绕过路径照旧被挡;
// 传递依赖不入扫描(重量由 deps-budget 数字承载,见 check-deps-budget.mjs)。
// 落位(ADR-0015 M5 修订):共享实现居根 scripts/,各包以 `node ../../scripts/check-runtime-deps.mjs`
// 薄脚本指回;挂进 pnpm verify 走红线。脚手架(开场 / 硬错误小件 / 退出码)居 gate-kit.mjs(#126),
// dist 扫描机制居 lib.mjs。
// 退出码契约(ADR-0015):0 = 干净;1 = 任一违背;2 = 配置·产物硬错误
// (manifest 不可读 / 缺 dist——扫描无从谈起)。「闸门没跑成」不混进「公开面真坏」(#113 裁决)。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUNTIME_DEPENDENCY_FIELDS,
  ZERO_RUNTIME_PACKAGES,
  allowedSpecifierPredicate,
  scanDist,
} from './lib.mjs';
import { EXIT_PROBLEM, gatePreamble, hardError } from './gate-kit.mjs';

const { packageDir, manifest } = gatePreamble();

const violations = [];

// 产物是扫描对象:缺它就谈不上扫描(硬错误 2),不混进「违背」(1)。
const distDir = join(packageDir, 'dist');
if (!existsSync(distDir)) {
  hardError(`${manifest.name}:产物目录 dist/ 不存在,无法做导入扫描——先运行 pnpm build 再跑本检查`);
}

const isZeroRuntimePackage = ZERO_RUNTIME_PACKAGES.includes(manifest.name);
if (isZeroRuntimePackage) {
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      violations.push(`package.json 的 ${field} 声明了运行时依赖 ${name}(零运行时依赖包,ADR-0001)`);
    }
  }
}

const declaredNames = isZeroRuntimePackage
  ? new Set()
  : new Set(
      RUNTIME_DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})),
    );
const isAllowed = allowedSpecifierPredicate(declaredNames);

const { moduleCount, externalImports } = await scanDist(packageDir);
for (const [specifier, files] of externalImports) {
  if (!isAllowed(specifier)) {
    violations.push(
      `${files[0]}${files.length > 1 ? ` 等 ${files.length} 处` : ''} 导入了未声明依赖 ${specifier}`,
    );
  }
}

if (violations.length > 0) {
  console.error(
    `${manifest.name}:依赖红线违背(${isZeroRuntimePackage ? '零运行时依赖,ADR-0001' : '仅声明依赖,ADR-0015 M5'}),发现 ${violations.length} 处:`,
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exitCode = EXIT_PROBLEM;
} else {
  console.log(
    isZeroRuntimePackage
      ? `${manifest.name}:零运行时依赖 ok(清单 0 个依赖;产物 ${moduleCount} 个模块,0 处外部导入)`
      : `${manifest.name}:仅声明依赖 ok(白名单 ${declaredNames.size} 个声明依赖;产物 ${moduleCount} 个模块,0 处未声明导入)`,
  );
}
