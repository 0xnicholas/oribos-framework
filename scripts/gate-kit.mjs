// 六个 CI 红线闸门的脚手架唯一家(#126,归 #116):退出码常量、硬错误小件、统一 argv 约定的
// gatePreamble、报表件(formatBytes / renderTable / publishToCi)、预算黄灯骨架 runBudgetGate。
// 各闸门只留自己的度量与检查;check-examples 已是深 runner 形状,不消费本模块。
//
// lib.mjs 保持 dist 扫描机制单一深度、本票不动:退出码硬错误档与 hardError 的定义沿其既有出口,
// 此处转发为闸门唯一引用面——闸门不直接 import lib.mjs 的小件。
//
// 输出流约定(全闸门统一):报表面(ok 进度行 / 标题 / 表格)与 CI 记录面(::warning 注释、
// job summary)走 stdout,问题(黄灯清单 / 缺口 / 违背)与硬错误走 stderr。
// 退出码契约(ADR-0015):0 = 干净 / 1 = 需处理(黄灯·缺口·违背) / 2 = 配置·产物硬错误。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hardError, readManifestOrHardError } from './lib.mjs';

export { EXIT_HARD_ERROR, hardError } from './lib.mjs';

/** 退出码契约(ADR-0015)的干净档与需处理档;硬错误档沿 lib.mjs 既有定义(见上转发)。 */
export const EXIT_OK = 0;
export const EXIT_PROBLEM = 1;

/** 读 JSON 文件;不可读 / JSON 非法 = 配置硬错误(退出码 2),不把栈抛给调用方。 */
export function readJsonOrHardError(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    hardError(`读取 ${file} 失败——${error instanceof Error ? error.message : error}`);
  }
}

/**
 * 统一 argv 约定的闸门开场:第一个非 `--` 参数为包目录(缺省 cwd),`--update` 收编为标志;
 * 随即读入 manifest(不可读即硬错误)。各闸门不再各自解析 argv。
 */
export function gatePreamble() {
  const argv = process.argv.slice(2);
  const packageDir = resolve(argv.find((arg) => !arg.startsWith('--')) ?? process.cwd());
  return {
    update: argv.includes('--update'),
    packageDir,
    manifest: readManifestOrHardError(packageDir),
  };
}

/** 字节数的千分位报表格式;两个 budget 闸门的行形状与问题文案共用。 */
export const formatBytes = (bytes) =>
  `${String(bytes).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} B`;

/** 等宽对齐的文本表:入口与数字都是 ASCII,中文只留在状态列,列宽按字符数计算即可。 */
export function renderTable(lines) {
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

/**
 * CI 的记录面:每个问题一条黄灯注释(PR 上可见;GitHub 工作流命令只能走 stdout),
 * 整张表追加进 job summary。markdown 表列对齐约定:首末列左对齐、其余右对齐,首列值加反引号。
 */
export function publishToCi({ title, description, columns, rows, problems, updateHint }) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const problem of problems) {
      console.log(`::warning title=${title}::${problem}`);
    }
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined) {
    return;
  }
  const lines = [
    `## ${title}`,
    '',
    description,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map((_, column) => (column === 0 || column === columns.length - 1 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map(
      (cells) =>
        `| ${cells.map((cell, column) => (column === 0 ? `\`${cell}\`` : cell)).join(' | ')} |`,
    ),
  ];
  if (problems.length > 0) {
    lines.push('', `🟡 ${problems.length} 项需处理:`, ...problems.map((problem) => `- ${problem}`));
    lines.push('', `调整基线:\`${updateHint}\``);
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

/**
 * 预算黄灯骨架(baseline 比对 → --update 重写 → problems → 黄灯 1 全链):统一的开场、
 * 基线读取与口径守护、报表与 CI 记录面、退出码。闸门只供自己的度量与检查:
 *   collectRows({ manifest, packageDir, baseline }) → 行数组——条目提取 + 度量 + 行组装;
 *     门禁守护(口径外的配置问题)在内 hardError,无可测条目时可 process.exit(EXIT_OK)
 *     提前全绿(如 deps-budget 的零声明包);
 *   buildBaseline(rows) → --update 写盘的基线对象;
 *   formatUpdateRow(row) → 变化行文案,无变化返回 undefined;
 *   findProblems({ rows, baseline }) → 问题文案数组(空数组 = 在预算内);
 *   rowCells(row) → 一行报表列;okLine(rows) → 全绿行文案。
 */
export async function runBudgetGate({
  metric,
  budgetFile,
  updateHint,
  displayName,
  description,
  columns,
  collectRows,
  buildBaseline,
  formatUpdateRow,
  findProblems,
  rowCells,
  okLine,
}) {
  const { update, packageDir, manifest } = gatePreamble();

  const budgetPath = join(packageDir, budgetFile);
  const baseline = existsSync(budgetPath) ? readJsonOrHardError(budgetPath) : undefined;
  if (baseline !== undefined && baseline.metric !== metric) {
    hardError(
      `${manifest.name}:基线 ${budgetFile} 的口径是 ${baseline.metric},本脚本口径是 ${metric};跑 ${updateHint} 重建基线`,
    );
  }

  const rows = await collectRows({ manifest, packageDir, baseline });

  // 基线重写:以当前实测值为新预算,供代码演进时有意抬高(黄灯提示作者做这个动作)。
  if (update) {
    writeFileSync(budgetPath, `${JSON.stringify(buildBaseline(rows), null, 2)}\n`);
    console.log(`${manifest.name} ${displayName}基线已更新:${budgetFile}`);
    for (const row of rows) {
      const line = formatUpdateRow(row);
      if (line !== undefined) {
        console.log(`  ${line}`);
      }
    }
    process.exit(EXIT_OK);
  }

  const problems = findProblems({ rows, baseline });
  const cells = rows.map(rowCells);

  console.log(`${manifest.name} ${displayName}(${metric})`);
  if (cells.length > 0) {
    console.log(renderTable([columns, ...cells]));
  }
  if (problems.length > 0) {
    console.error(`🟡 ${problems.length} 项需处理:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error(`调整基线:${updateHint}(ADR-0001:黄灯仅作内部回归参考,不卡合并)`);
    process.exitCode = EXIT_PROBLEM;
  } else {
    console.log(okLine(rows));
  }
  publishToCi({
    title: `${manifest.name} ${displayName}`,
    description,
    columns,
    rows: cells,
    problems,
    updateHint,
  });
}
