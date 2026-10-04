// 依赖数字黄灯(ADR-0015 M5 修订):每包 deps-budget.json 基线,条目 = 每个声明运行时
// 依赖一条实测——传递包数 `packages` + 解包体积 `bytes`(registry `dist.unpackedSize`)合计。
// 口径沿事实底座研究方法(docs/research/otlp-js-packages.md §方法):空目录
// `npm install --package-lock-only`(npm 7+ 自动装 peer)解析闭包,再对每个 name@version
// 取 registry `dist.unpackedSize` 求和。peer `@oribos/core` 豁免——核心重量由核心自身
// 字节预算承载(ADR-0002 M5 单份 core 实例,peer 是身份语义前提)。
// `--update` 用实测值重写基线(基线调整与代码同 PR);缺基线/超基线 = 黄灯,
// 「声明但产物零引用」追加黄灯记录——都不卡合并(CI 用 `|| test $? -eq 1` 容忍)。
// 退出码契约(ADR-0015):0 = 在预算内;1 = 需处理(黄灯);2 = 配置/测量硬错误
// (口径不符、npm/registry 解析失败、非 core 的 workspace: 范围)——CI 照常变红。
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readManifestOrHardError, scanDist } from './lib.mjs';

const METRIC = 'npm-install-closure-packages-and-unpacked-bytes';
const BUDGET_FILE = 'deps-budget.json';
const UPDATE_HINT = 'pnpm deps-budget:update';
const REGISTRY = 'https://registry.npmjs.org';
const CORE_PEER_EXEMPT = '@oribos/core';
const EXIT_YELLOW = 1;
const EXIT_HARD_ERROR = 2;

/** 硬错误(不是"数字超了"):配置或测量问题,CI 不容忍。 */
function hardError(message) {
  console.error(message);
  process.exit(EXIT_HARD_ERROR);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    hardError(`读取 ${file} 失败——${error instanceof Error ? error.message : error}`);
  }
}

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const packageDir = resolve(argv.find((arg) => !arg.startsWith('--')) ?? process.cwd());
const manifest = readManifestOrHardError(packageDir);

/**
 * 声明运行时依赖 → 测量条目。peer `@oribos/core`(workspace: 范围)豁免;
 * 其余 workspace: 范围即硬错误——能力包之间默认不建依赖边(ADR-0002 M5),
 * 例外若出现须先改 ADR 再改这里。
 */
const declared = new Map();
for (const [field, section] of [
  ['dependencies', manifest.dependencies],
  ['optionalDependencies', manifest.optionalDependencies],
  ['peerDependencies', manifest.peerDependencies],
]) {
  for (const [name, range] of Object.entries(section ?? {})) {
    if (name === CORE_PEER_EXEMPT && field === 'peerDependencies') continue;
    if (range.startsWith('workspace:')) {
      hardError(
        `${manifest.name}:${field} 的 ${name}@${range} 是 workspace 范围——仅 peer ${CORE_PEER_EXEMPT} 豁免;其余依赖边须按 ADR-0002 M5 显式单议`,
      );
    }
    declared.set(name, { field, range });
  }
}

const formatBytes = (bytes) =>
  `${String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B`;

/**
 * 单个依赖的安装闭包:空目录里 `npm install --package-lock-only` 解析(自动装 peer,
 * 与真实安装同一解析器),再逐 name@version 取 registry unpackedSize 求和。
 * 返回 { packages, bytes };npm 失败即硬错误(退出码 2)。
 */
async function measureClosure(name, range) {
  const probeDir = mkdtempSync(join(tmpdir(), 'oribos-deps-budget-'));
  try {
    writeFileSync(
      join(probeDir, 'package.json'),
      `${JSON.stringify({ name: 'oribos-deps-budget-probe', private: true, dependencies: { [name]: range } }, null, 2)}\n`,
    );
    const npm = spawnSync(
      'npm',
      ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
      { cwd: probeDir, encoding: 'utf8', timeout: 120_000 },
    );
    if (npm.status !== 0) {
      hardError(
        `${manifest.name}:npm 解析 ${name}@${range} 闭包失败——${(npm.stderr || npm.stdout || `exit ${npm.status}`).trim()}`,
      );
    }
    const lock = readJson(join(probeDir, 'package-lock.json'));
    const resolved = Object.entries(lock.packages ?? {})
      .filter(([key, entry]) => key !== '' && entry.version !== undefined)
      .map(([key, entry]) => {
        // key 形如 node_modules/<name> 或嵌套 node_modules/<a>/node_modules/<b>;
        // 同名不同版本各占一条(都会被装),按条目计数。
        const segment = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        return { name: segment, version: entry.version };
      });
    const sizeCache = new Map();
    let bytes = 0;
    for (const { name: depName, version } of resolved) {
      const key = `${depName}@${version}`;
      if (!sizeCache.has(key)) {
        sizeCache.set(key, await fetchUnpackedSize(depName, version));
      }
      bytes += sizeCache.get(key);
    }
    return { packages: resolved.length, bytes };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * registry 元数据取单包解包体积;获取失败即硬错误(测量失败,退出码 2)。
 * 老包元数据可能缺 dist.unpackedSize(如 isexe@2.0.0,2014 年发布)——沿 #6 事实底座口径
 * (docs/research/lightweight-benchmarks-mcp.md 方法学:「体积为下界」):计包数、字节计 0、
 * 黄灯注记下界;不硬错误。
 */
async function fetchUnpackedSize(name, version) {
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

const budgetPath = join(packageDir, BUDGET_FILE);
const baseline = existsSync(budgetPath) ? readJson(budgetPath) : undefined;
if (baseline !== undefined && baseline.metric !== METRIC) {
  hardError(
    `${manifest.name}:基线 ${BUDGET_FILE} 的口径是 ${baseline.metric},本脚本口径是 ${METRIC};跑 ${UPDATE_HINT} 重建基线`,
  );
}

// 零声明运行时依赖且无基线:无可测亦无可比(如 core、以及运行时 0 依赖的能力包),直接 ok。
if (declared.size === 0 && baseline === undefined) {
  console.log(`${manifest.name}:0 个声明运行时依赖(peer ${CORE_PEER_EXEMPT} 豁免),无 deps-budget 基线需求`);
  process.exit(0);
}

const rows = [];
for (const [name, { field, range }] of declared) {
  const measured = await measureClosure(name, range);
  const budget = baseline?.dependencies?.[name];
  rows.push({ name, field, range, measured, budget });
}

// 零引用扫描(黄灯记录):声明了却从未被产物导入的依赖——超重或冗余的信号,不卡合并。
const zeroReferenced = [];
if (existsSync(join(packageDir, 'dist'))) {
  const { externalImports } = await scanDist(packageDir);
  const importedSpecifiers = [...externalImports.keys()];
  for (const { name } of rows) {
    const referenced = importedSpecifiers.some(
      (specifier) => specifier === name || specifier.startsWith(`${name}/`),
    );
    if (!referenced) {
      zeroReferenced.push(name);
    }
  }
} else {
  console.log(`${manifest.name}:dist/ 不存在,跳过零引用扫描(先 pnpm build)`);
}

// 基线重写:以当前实测值为新预算(黄灯提示作者做这个动作,基线调整与代码同 PR)。
if (update) {
  const next = {
    metric: METRIC,
    dependencies: Object.fromEntries(
      [...rows].sort((a, b) => a.name.localeCompare(b.name)).map((row) => [row.name, row.measured]),
    ),
  };
  writeFileSync(budgetPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${manifest.name} 依赖数字基线已更新:${BUDGET_FILE}`);
  for (const row of rows) {
    const budget = row.budget;
    if (budget === undefined || budget.packages !== row.measured.packages || budget.bytes !== row.measured.bytes) {
      console.log(
        `  ${row.name}  ${budget === undefined ? '—' : `${budget.packages} 包 / ${formatBytes(budget.bytes)}`} → ${row.measured.packages} 包 / ${formatBytes(row.measured.bytes)}`,
      );
    }
  }
  process.exit(0);
}

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
for (const name of zeroReferenced) {
  problems.push(`${name} 声明但产物零引用——要么用起来,要么从清单去掉`);
}

/** 等宽对齐的文本表:依赖名与数字都是 ASCII,中文只留在状态列,列宽按字符数计算即可。 */
function renderTable(lines) {
  const widths = lines[0].map((_, column) =>
    Math.max(...lines.map((line) => String(line[column]).length)),
  );
  return lines
    .map((line) =>
      line
        .map((cell, column) => String(cell).padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const statusOf = (row) =>
  row.budget === undefined
    ? '🟡 未建基线'
    : row.measured.packages > row.budget.packages || row.measured.bytes > row.budget.bytes
      ? '🟡 超基线'
      : zeroReferenced.includes(row.name)
        ? '🟡 零引用'
        : 'ok';

/** 一行的 6 列;文本表与 job summary 的 markdown 表共用,避免两处各自重算。 */
function rowCells(row) {
  return [
    row.name,
    row.budget === undefined ? '—' : `${row.budget.packages} 包`,
    `${row.measured.packages} 包`,
    row.budget === undefined ? '—' : formatBytes(row.budget.bytes),
    formatBytes(row.measured.bytes),
    statusOf(row),
  ];
}

/** CI 的记录面:每个问题一条黄灯注释(PR 上可见),整张表追加进 job summary。 */
function publishToCi() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const problem of problems) {
      console.log(`::warning title=${manifest.name} 依赖数字::${problem}`);
    }
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined) {
    return;
  }
  const lines = [
    `## ${manifest.name} 依赖数字`,
    '',
    `口径 \`${METRIC}\`:每个声明运行时依赖的 npm 安装闭包(自动装 peer)传递包数 + registry 解包体积合计;peer \`${CORE_PEER_EXEMPT}\` 豁免。ADR-0001:仅内部回归参考,不卡合并。`,
    '',
    '| dependency | budget | current | budget | current | status |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| ${rowCells(row)
          .map((cell, column) => (column === 0 ? `\`${cell}\`` : cell))
          .join(' | ')} |`,
    ),
  ];
  if (problems.length > 0) {
    lines.push('', `🟡 ${problems.length} 项需处理:`, ...problems.map((problem) => `- ${problem}`));
    lines.push('', `调整基线:\`${UPDATE_HINT}\``);
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

console.log(`${manifest.name} 依赖数字(${METRIC})`);
if (rows.length > 0) {
  console.log(
    renderTable([
      ['dependency', 'budget', 'current', 'budget', 'current', 'status'],
      ...rows.map(rowCells),
    ]),
  );
}
if (problems.length > 0) {
  console.error(`🟡 ${problems.length} 项需处理:`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(`调整基线:${UPDATE_HINT}(ADR-0001:黄灯仅作内部回归参考,不卡合并)`);
  process.exitCode = EXIT_YELLOW;
} else {
  console.log(`ok  ${rows.length} 个声明依赖全部在基线内`);
}
publishToCi();
