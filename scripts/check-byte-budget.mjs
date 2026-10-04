// 字节预算黄灯(ADR-0001,M1-02 #23):比对构建产物的字节数,超预算给出黄灯。
// 口径 = esbuild minify 后每个子路径导出入口的 bundle 字节(与构建链解耦,见 ADR-0014/0015);
// 基线落 byte-budget.json,`--update` 用实测值重写。
// M5 分形(ADR-0015 修订):测量把非相对导入一律 external——数字只反映第一方代码,
// 供应商重量由 deps-budget 数字承载(check-deps-budget.mjs);对零依赖的 core 无差异。
// 落位(ADR-0015 M5 修订):共享实现居根 scripts/,各包以 `node ../../scripts/check-byte-budget.mjs`
// 薄脚本指回;退出码契约不变。脚手架(开场 / 基线链 / 报表 / CI 记录面)居 gate-kit.mjs(#126),
// 本闸门只留自己的度量与检查。
// 退出码契约(ADR-0015):0 = 在预算内;1 = 需处理(黄灯,CI 用 `|| test $? -eq 1` 容忍);
// 2 = 配置/测量硬错误(口径不符、入口无产物、测量失败)——CI 照常变红。
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { formatBytes, hardError, runBudgetGate } from './gate-kit.mjs';

const METRIC = 'esbuild-minified-bytes';
const BUDGET_FILE = 'byte-budget.json';
const UPDATE_HINT = 'pnpm byte-budget:update';

const formatDelta = (delta) => `${delta > 0 ? '+' : ''}${formatBytes(delta)}`;

/** 非相对导入一律 external 的 esbuild 插件:`external: ['*']` 会连相对路径一起外化,
 * 改用解析钩子按形态判定——只有包形态的说明符(含 Node 内置)出包,相对导入照常内联。 */
const externalPackagesPlugin = {
  name: 'external-packages',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => ({ external: true }));
  },
};

/** esbuild minify 单个导出入口,返回 minified 与 gzip 字节数(非相对导入一律 external,见文件头)。 */
async function measure(file) {
  const { outputFiles } = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    plugins: [externalPackagesPlugin],
    minify: true,
    format: 'esm',
    platform: 'node',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  });
  const [output] = outputFiles ?? [];
  if (output === undefined) {
    throw new Error(`esbuild 没有为 ${file} 产出结果`);
  }
  return { minified: output.contents.length, gzip: gzipSync(output.contents).length };
}

const statusOf = (row) =>
  row.budget === undefined ? '🟡 未建基线' : row.delta > 0 ? '🟡 超预算' : 'ok';

await runBudgetGate({
  metric: METRIC,
  budgetFile: BUDGET_FILE,
  updateHint: UPDATE_HINT,
  displayName: '字节预算',
  description: `口径 \`${METRIC}\`(非相对导入 external,仅第一方代码):esbuild minify 后每个子路径导出入口的 bundle 字节。ADR-0001:仅内部回归参考,不卡合并。`,
  columns: ['entry', 'budget', 'current', 'delta', 'gzip', 'status'],

  /** 条目 = exports 表逐子路径;度量 = 各入口的 esbuild minify 字节;行携 budget 与 delta。 */
  async collectRows({ manifest, packageDir, baseline }) {
    const entries = Object.entries(manifest.exports ?? {}).map(([subpath, target]) => {
      const file = typeof target === 'string' ? target : target?.default;
      if (typeof file !== 'string') {
        hardError(`${manifest.name}:exports["${subpath}"] 没有 default 产物入口,无法测量`);
      }
      return { subpath, file: join(packageDir, file) };
    });
    const rows = [];
    for (const entry of entries) {
      let measured;
      try {
        measured = await measure(entry.file);
      } catch (error) {
        hardError(
          `${manifest.name}:测量 ${entry.subpath} 失败——${error instanceof Error ? error.message : error};先确认 pnpm build 已产出 dist`,
        );
      }
      const budget = baseline?.entries?.[entry.subpath];
      rows.push({
        ...entry,
        measured,
        budget,
        delta: budget === undefined ? undefined : measured.minified - budget,
      });
    }
    return rows;
  },

  buildBaseline: (rows) => ({
    metric: METRIC,
    entries: Object.fromEntries(rows.map((row) => [row.subpath, row.measured.minified])),
  }),

  formatUpdateRow: (row) =>
    row.budget === row.measured.minified
      ? undefined
      : `${row.subpath}  ${row.budget === undefined ? '—' : formatBytes(row.budget)} → ${formatBytes(row.measured.minified)}`,

  findProblems: ({ rows, baseline }) => {
    const problems = [];
    if (baseline === undefined) {
      problems.push(`基线文件 ${BUDGET_FILE} 不存在;跑 ${UPDATE_HINT} 建立基线`);
    } else {
      for (const row of rows) {
        if (row.delta === undefined) {
          problems.push(`${row.subpath} 尚无预算基线(当前 ${formatBytes(row.measured.minified)})`);
        } else if (row.delta > 0) {
          problems.push(
            `${row.subpath} 超预算 ${formatDelta(row.delta)}(基线 ${formatBytes(row.budget)} → 当前 ${formatBytes(row.measured.minified)})`,
          );
        }
      }
      const exported = new Set(rows.map((row) => row.subpath));
      for (const subpath of Object.keys(baseline.entries ?? {})) {
        if (!exported.has(subpath)) {
          problems.push(`基线中的 ${subpath} 已不再导出;清理它或跑 ${UPDATE_HINT}`);
        }
      }
    }
    return problems;
  },

  rowCells: (row) => [
    row.subpath,
    row.budget === undefined ? '—' : formatBytes(row.budget),
    formatBytes(row.measured.minified),
    row.delta === undefined ? '—' : formatDelta(row.delta),
    formatBytes(row.measured.gzip),
    statusOf(row),
  ],

  okLine: (rows) => `ok  ${rows.length} 个入口全部在预算内`,
});
