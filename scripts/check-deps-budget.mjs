// 依赖数字黄灯(ADR-0015 M5 修订):每包 deps-budget.json 基线,条目 = 每个声明运行时
// 依赖一条实测——传递包数 `packages` + 解包体积 `bytes`(registry `dist.unpackedSize`)合计。
// 口径沿事实底座研究方法(docs/research/otlp-js-packages.md §方法):空目录
// `npm install --package-lock-only`(npm 7+ 自动装 peer)解析闭包,再对每个 name@version
// 取 registry `dist.unpackedSize` 求和。peer `@oribos/core` 豁免——核心重量由核心自身
// 字节预算承载(ADR-0002 M5 单份 core 实例,peer 是身份语义前提)。
// `--update` 用实测值重写基线(基线调整与代码同 PR);缺基线/超基线 = 黄灯,
// 「声明但产物零引用」追加黄灯记录——都不卡合并(CI 用 `|| test $? -eq 1` 容忍)。
// 退出码契约(ADR-0015):0 = 在预算内;1 = 需处理(黄灯);2 = 配置/测量硬错误
// (口径不符、npm/registry 解析失败、非豁免的 workspace: 范围)——CI 照常变红。
// workspace: 豁免 = peer `@oribos/core` + ADR-0002 叶子包判词(能力包 dependencies
// 依赖叶子包,#193;叶子未发布、workspace 范围不可 npm 解析,叶子边按叶子外部闭包 + 本体
// 计 1 包测量,本体字节 0 下界,#183);其余依赖边须先改 ADR 再改这里。
// 脚手架(开场 / 基线链 / 报表 / CI 记录面)居 gate-kit.mjs(#126),本闸门只留自己的度量与检查。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scanDist } from './lib.mjs';
import {
  EXIT_OK,
  formatBytes,
  hardError,
  readJsonOrHardError,
  runBudgetGate,
} from './gate-kit.mjs';

const METRIC = 'npm-install-closure-packages-and-unpacked-bytes';
const BUDGET_FILE = 'deps-budget.json';
const UPDATE_HINT = 'pnpm deps-budget:update';
const REGISTRY = 'https://registry.npmjs.org';
const CORE_PEER_EXEMPT = '@oribos/core';

/**
 * 单个依赖的安装闭包:空目录里 `npm install --package-lock-only` 解析(自动装 peer,
 * 与真实安装同一解析器),再逐 name@version 取 registry unpackedSize 求和。
 * 返回 { packages, bytes };npm 失败即硬错误(退出码 2)。
 */
async function measureClosure(manifest, name, range) {
  return npmClosure(manifest, { [name]: range });
}

/**
 * 闭包测量的共用底座:按 deps 记录做一次 npm 解析 + registry 体积合计。
 */
async function npmClosure(manifest, deps) {
  const probeDir = mkdtempSync(join(tmpdir(), 'oribos-deps-budget-'));
  try {
    writeFileSync(
      join(probeDir, 'package.json'),
      `${JSON.stringify({ name: 'oribos-deps-budget-probe', private: true, dependencies: deps }, null, 2)}\n`,
    );
    const npm = spawnSync(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
      { cwd: probeDir, encoding: 'utf8', timeout: 120_000 },
    );
    if (npm.status !== 0) {
      hardError(
        `${manifest.name}:npm 解析 ${Object.entries(deps).map(([n, r]) => `${n}@${r}`).join(', ')} 闭包失败——${(npm.stderr || npm.stdout || `exit ${npm.status}`).trim()}`,
      );
    }
    const lock = readJsonOrHardError(join(probeDir, 'package-lock.json'));
    const resolved = Object.entries(lock.packages ?? {})
      .filter(([key, entry]) => key !== '' && entry.version !== undefined)
      .map(([key, entry]) => {
        // key 形如 node_modules/<name> 或嵌套 node_modules/<a>/node_modules/<b>;
        // 同名不同版本各占一条(都会被装),按条目计数。npm 别名(string-width-cjs →
        // string-width)下 key 是别名、entry.name 才是真包名——体积必须按真包名查 registry。
        const segment = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : segment;
        return { name, version: entry.version };
      });
    const sizeCache = new Map();
    let bytes = 0;
    for (const { name: depName, version } of resolved) {
      const key = `${depName}@${version}`;
      if (!sizeCache.has(key)) {
        sizeCache.set(key, await fetchUnpackedSize(manifest, depName, version));
      }
      bytes += sizeCache.get(key);
    }
    return { packages: resolved.length, bytes };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * ADR-0002 叶子依赖边的测量:叶子未发布,`workspace:` 范围不能进 npm 探针——
 * 以叶子的外部依赖闭包 + 叶子本体计 1 包(字节 0,未发布无 registry 数字,#6「体积为下界」口径;
 * 发布票复核时随 `--update` 吸收实数)。
 */
async function measureLeafClosure(manifest, packageDir, name) {
  const leaf = readJsonOrHardError(join(packageDir, '..', name.slice('@oribos/'.length), 'package.json'));
  const external = {};
  for (const section of [leaf.dependencies, leaf.optionalDependencies]) {
    for (const [depName, range] of Object.entries(section ?? {})) {
      if (depName.startsWith('@oribos/')) continue;
      external[depName] = range;
    }
  }
  const closure = Object.keys(external).length === 0 ? { packages: 0, bytes: 0 } : await npmClosure(manifest, external);
  console.warn(
    `${manifest.name}:${name} 是 ADR-0002 叶子依赖(workspace 范围)——按叶子外部闭包 + 本体计 1 包测量,本体字节计 0(下界,发布票复核)`,
  );
  return { packages: closure.packages + 1, bytes: closure.bytes };
}

/**
 * registry 元数据取单包解包体积;获取失败即硬错误(测量失败,退出码 2)。
 * 老包元数据可能缺 dist.unpackedSize(如 isexe@2.0.0,2014 年发布)——沿 #6 事实底座口径
 * (docs/research/lightweight-benchmarks-mcp.md 方法学:「体积为下界」):计包数、字节计 0、
 * 黄灯注记下界;不硬错误。
 */
async function fetchUnpackedSize(manifest, name, version) {
  let document;
  try {
    const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/${version}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    document = await response.json();
  } catch (error) {
    hardError(
      `${manifest.name}:registry 元数据获取 ${name}@${version} 失败——${error instanceof Error ? error.message : error}`,
    );
  }
  const size = document?.dist?.unpackedSize;
  if (typeof size !== 'number') {
    console.warn(
      `${manifest.name}:${name}@${version} 的 registry 元数据缺 dist.unpackedSize——计 0 B,合计为下界(#6 口径)`,
    );
    return 0;
  }
  return size;
}

/**
 * ADR-0002 叶子包判词:目标包运行时 `@oribos/*` 依赖仅 peer `@oribos/core`——无状态
 * 纯件、用户永不直接安装,能力包可 `dependencies` 依赖(ADR-0002 叶子包修订,#193)。
 * 包目录与声明方同层平铺(ADR-0002 M5):`packages/<短名>`。
 */
function isLeafPackage(packageDir, name) {
  const manifestPath = join(packageDir, '..', name.slice('@oribos/'.length), 'package.json');
  if (!existsSync(manifestPath)) {
    hardError(`${name} 的清单不存在(${manifestPath})——先建包再声明依赖边`);
  }
  const target = readJsonOrHardError(manifestPath);
  const oribosRuntimeEdges = Object.entries({
    dependencies: target.dependencies,
    optionalDependencies: target.optionalDependencies,
    peerDependencies: target.peerDependencies,
  }).flatMap(([field, section]) =>
    Object.keys(section ?? {})
      .filter((dep) => dep.startsWith('@oribos/'))
      .map((dep) => `${field}:${dep}`),
  );
  return oribosRuntimeEdges.length === 1 && oribosRuntimeEdges[0] === 'peerDependencies:@oribos/core';
}

const statusOf = (row) =>
  row.budget === undefined
    ? '🟡 未建基线'
    : row.measured.packages > row.budget.packages || row.measured.bytes > row.budget.bytes
      ? '🟡 超基线'
      : row.zeroReferenced
        ? '🟡 零引用'
        : 'ok';

await runBudgetGate({
  metric: METRIC,
  budgetFile: BUDGET_FILE,
  updateHint: UPDATE_HINT,
  displayName: '依赖数字',
  description: `口径 \`${METRIC}\`:每个声明运行时依赖的 npm 安装闭包(自动装 peer)传递包数 + registry 解包体积合计;peer \`${CORE_PEER_EXEMPT}\` 豁免、ADR-0002 叶子包例外。ADR-0001:仅内部回归参考,不卡合并。`,
  columns: ['dependency', 'budget', 'current', 'budget', 'current', 'status'],

  /**
   * 条目 = manifest 运行时字段声明的依赖。workspace: 范围豁免两类——peer `@oribos/core`,
   * 以及 `dependencies` 里过 ADR-0002 叶子包判词的目标;其余 workspace: 范围即硬错误——
   * 能力包之间默认不建依赖边(ADR-0002 M5),例外若出现须先改 ADR 再改这里。
   * 零声明且无基线 = 无可测亦无可比(如 core),直接 ok。
   * 行组装后附零引用注记:声明了却从未被产物导入的依赖——超重或冗余的信号。
   */
  async collectRows({ manifest, packageDir, baseline }) {
    const declared = new Map();
    for (const [field, section] of [
      ['dependencies', manifest.dependencies],
      ['optionalDependencies', manifest.optionalDependencies],
      ['peerDependencies', manifest.peerDependencies],
    ]) {
      for (const [name, range] of Object.entries(section ?? {})) {
        if (name === CORE_PEER_EXEMPT && field === 'peerDependencies') continue;
        if (range.startsWith('workspace:')) {
          const leafExempt = field === 'dependencies' && isLeafPackage(packageDir, name);
          if (!leafExempt) {
            hardError(
              `${manifest.name}:${field} 的 ${name}@${range} 是 workspace 范围——豁免仅 peer ${CORE_PEER_EXEMPT} 与 ADR-0002 叶子包(dependencies);其余依赖边须按 ADR-0002 M5 显式单议`,
            );
          }
        }
        declared.set(name, { field, range });
      }
    }

    if (declared.size === 0 && baseline === undefined) {
      console.log(`${manifest.name}:0 个声明运行时依赖(peer ${CORE_PEER_EXEMPT} 豁免),无 deps-budget 基线需求`);
      process.exit(EXIT_OK);
    }

    const rows = [];
    for (const [name, { field, range }] of declared) {
      const measured =
        field === 'dependencies' && range.startsWith('workspace:')
          ? await measureLeafClosure(manifest, packageDir, name)
          : await measureClosure(manifest, name, range);
      rows.push({ name, field, range, measured, budget: baseline?.dependencies?.[name] });
    }

    if (existsSync(join(packageDir, 'dist'))) {
      const { externalImports } = await scanDist(packageDir);
      const importedSpecifiers = [...externalImports.keys()];
      for (const row of rows) {
        row.zeroReferenced = !importedSpecifiers.some(
          (specifier) => specifier === row.name || specifier.startsWith(`${row.name}/`),
        );
      }
    } else {
      console.log(`${manifest.name}:dist/ 不存在,跳过零引用扫描(先 pnpm build)`);
    }
    return rows;
  },

  buildBaseline: (rows) => ({
    metric: METRIC,
    dependencies: Object.fromEntries(
      [...rows].sort((a, b) => a.name.localeCompare(b.name)).map((row) => [row.name, row.measured]),
    ),
  }),

  formatUpdateRow: (row) => {
    const budget = row.budget;
    if (budget !== undefined && budget.packages === row.measured.packages && budget.bytes === row.measured.bytes) {
      return undefined;
    }
    return `${row.name}  ${budget === undefined ? '—' : `${budget.packages} 包 / ${formatBytes(budget.bytes)}`} → ${row.measured.packages} 包 / ${formatBytes(row.measured.bytes)}`;
  },

  findProblems: ({ rows, baseline }) => {
    const problems = [];
    if (baseline === undefined) {
      problems.push(`基线文件 ${BUDGET_FILE} 不存在;跑 ${UPDATE_HINT} 建立基线`);
    } else {
      for (const row of rows) {
        if (row.budget === undefined) {
          problems.push(`${row.name} 尚无基线(当前 ${row.measured.packages} 包 / ${formatBytes(row.measured.bytes)})`);
        } else if (row.measured.packages > row.budget.packages || row.measured.bytes > row.budget.bytes) {
          problems.push(
            `${row.name} 超基线(基线 ${row.budget.packages} 包 / ${formatBytes(row.budget.bytes)} → 当前 ${row.measured.packages} 包 / ${formatBytes(row.measured.bytes)})`,
          );
        }
      }
      const declaredNames = new Set(rows.map((row) => row.name));
      for (const name of Object.keys(baseline.dependencies ?? {})) {
        if (!declaredNames.has(name)) {
          problems.push(`基线中的 ${name} 已不再声明;清理它或跑 ${UPDATE_HINT}`);
        }
      }
    }
    for (const row of rows) {
      if (row.zeroReferenced) {
        problems.push(`${row.name} 声明但产物零引用——要么用起来,要么从清单去掉`);
      }
    }
    return problems;
  },

  rowCells: (row) => [
    row.name,
    row.budget === undefined ? '—' : `${row.budget.packages} 包`,
    `${row.measured.packages} 包`,
    row.budget === undefined ? '—' : formatBytes(row.budget.bytes),
    formatBytes(row.measured.bytes),
    statusOf(row),
  ],

  okLine: (rows) => `ok  ${rows.length} 个声明依赖全部在基线内`,
});
