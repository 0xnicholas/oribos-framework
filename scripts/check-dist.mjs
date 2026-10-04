// 构建产物校验(需先 `pnpm build`):逐个导入 package.json exports 表里的子路径,
// 证明「产物以子路径导出各子系统入口」在 dist 上真实成立。
// 同时按 CJS `require()` 走一遍 —— exports 的 `default` 条件保证 require(esm) 可用(Node ≥22.12)。
// 落位(ADR-0015 M5 修订):共享实现居根 scripts/,各包以 `node ../../scripts/check-dist.mjs`
// 薄脚本指回(或显式传包目录)。脚手架(开场 / 硬错误小件 / 退出码)居 gate-kit.mjs(#126)。
// 退出码契约(ADR-0015,#113 裁决对齐 check-export-surface):0 = 干净;1 = 公开面缺口(产物在盘上
// 但解析或加载失败);2 = 配置·产物硬错误(`exports` 表为空 / 缺 dist 目录 / 子路径声明产物缺失 /
// manifest 不可读)。硬错误优先于缺口——「闸门没跑成」不混进「公开面真坏」。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EXIT_HARD_ERROR, EXIT_PROBLEM, gatePreamble, hardError } from './gate-kit.mjs';

const { packageDir, manifest } = gatePreamble();
const { name, exports: exportMap } = manifest;
// 解析锚在包目录内:包自身名字经 exports 自引用解析,不依赖脚本所在位置。
const requireCjs = createRequire(join(packageDir, 'package.json'));

const entries = Object.entries(exportMap ?? {});
if (entries.length === 0) {
  hardError(`${name}: exports 表为空,无可校验的子路径`);
}
if (!existsSync(join(packageDir, 'dist'))) {
  hardError(`${name}: 缺产物目录 dist——本检查对着产物判定,先 \`pnpm build\``);
}

const hardErrors = [];
const gaps = [];

for (const [subpath, entry] of entries) {
  const specifier = subpath === '.' ? name : `${name}/${subpath.slice('./'.length)}`;

  // 条件声明的产物必须都在盘上:缺一个即闸门没跑成(忘 build / exports 表与构建配置不同步),
  // 记硬错误;该子路径不再试解析——那只会重复报一遍「Cannot find module」。
  const missing = Object.values(entry).filter((target) => !existsSync(join(packageDir, target)));
  if (missing.length > 0) {
    for (const target of missing) {
      hardErrors.push(`${specifier}: 缺产物 ${target}`);
    }
    continue;
  }

  try {
    const resolved = requireCjs.resolve(specifier);
    await import(pathToFileURL(resolved).href);
    requireCjs(specifier);
    console.log(`ok  ${specifier}`);
  } catch (error) {
    gaps.push(`${specifier}: 导入失败 — ${error instanceof Error ? error.message : error}`);
  }
}

// 一次跑完给全信息:两类都报;硬错误优先——2 盖过 1,闸门没跑成比公开面缺口更该先修。
if (hardErrors.length > 0) {
  console.error(hardErrors.join('\n'));
}
if (gaps.length > 0) {
  console.error(gaps.join('\n'));
}
if (hardErrors.length > 0) {
  process.exitCode = EXIT_HARD_ERROR;
} else if (gaps.length > 0) {
  process.exitCode = EXIT_PROBLEM;
}
