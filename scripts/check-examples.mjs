// 离线 example 冒烟闸门(ADR-0015 M5 修订:需要真实服务/跨进程的验证落 examples、不进 verify):
// 逐条跑离线 example 入口,全绿即 0;任何一案失败(含超时)= 1;运行器自身的配置硬错误
// (案表不可读 / JSON 非法 / 空案表 / 条目形状非法)= 2。硬闸门(红),CI 不做黄灯容忍。
//
// 本地口径 = **先构建再跑**(例子经包导出消费 dist):
//
//   pnpm build && pnpm check:examples
//
// 运行器不内建 dist 前置探测、不把构建链进入口命令(单一职责):CI 由 `pnpm verify`(含 build)
// 的顺序保证构建在前;本地忘 build 时以例子自身的模块解析错误呈现,计为该案失败。
//
// 接入新案只需往 CASES 加行(不改运行器)——条目 = 一条命令 + 可选 env + 可选超时,将来带 mock 的
// 三个例(本地 mock 端点 + `OPENAI_API_KEY=mock`)与需真 key 的例都走同一形状:
//
//   { name: 'sqlite-resume', cmd: 'pnpm', args: ['--filter', '@oribos/example-sqlite-resume', 'start'],
//     env: { OPENAI_API_KEY: 'mock', OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' } }
//
// 自测只走 `--cases <文件>` 这唯一缝(注入案表),见 packages/core/test/check-examples.test.ts。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXIT_OK = 0;
const EXIT_CASE_FAILED = 1;
const EXIT_HARD_ERROR = 2;

/** 单案默认超时上限;实测最长一例约 1.6s(mcp-tools stdio),余量约 20×。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 内建案表:十六个离线入口 / 十四个 example(HTTP 与 stdio 是 mcp-tools 的两个入口)。 */
const CASES = [
  { name: 'cron-schedule', cmd: 'pnpm', args: ['--filter', '@oribos/example-cron-schedule', 'start'] },
  { name: 'otlp-collector', cmd: 'pnpm', args: ['--filter', '@oribos/example-otlp-collector', 'start'] },
  { name: 'mcp-tools-http', cmd: 'pnpm', args: ['--filter', '@oribos/example-mcp-tools', 'start'] },
  {
    name: 'mcp-tools-stdio',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-mcp-tools', 'start'],
    env: { MCP_TRANSPORT: 'stdio' },
  },
  {
    name: 'workflow-time-travel',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-workflow-time-travel', 'start'],
  },
  {
    name: 'agent-supervisor',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-agent-supervisor', 'start'],
  },
  {
    name: 'agent-evals',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-agent-evals', 'start'],
  },
  {
    name: 'signal-webhook',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-signal-webhook', 'start'],
  },
  {
    name: 'background-tasks',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-background-tasks', 'start'],
  },
  {
    name: 'semantic-recall',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-semantic-recall', 'start'],
  },
  {
    name: 'resumable-stream',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-resumable-stream', 'start'],
  },
  {
    name: 'model-router',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-model-router', 'start'],
  },
  {
    name: 'crash-replay',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-crash-replay', 'start'],
  },
  {
    name: 'otel-bridge',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-otel-bridge', 'start'],
  },
  {
    name: 'distributed-signals',
    cmd: 'pnpm',
    args: ['--filter', '@oribos/example-distributed-signals', 'start'],
  },
];

/** 运行器自身配错/案表不可用:退出码 2,不混进「有案子失败」的红灯。 */
class HardError extends Error {}

/** 本地复现命令:逐案 env 前置,便于直接粘进终端。 */
function reproCommand(entry) {
  const env = Object.entries(entry.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return [env, entry.cmd, ...entry.args].filter((piece) => piece !== '').join(' ');
}

/** 案表条目的形状校验:条目 = 命令 + 可选 env + 可选超时。 */
function validateCase(entry, index) {
  const where = `案表第 ${index + 1} 条`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new HardError(`${where}不是对象`);
  }
  if (typeof entry.name !== 'string' || entry.name === '') {
    throw new HardError(`${where}缺 name(非空字符串)`);
  }
  if (typeof entry.cmd !== 'string' || entry.cmd === '') {
    throw new HardError(`${where}(${entry.name})缺 cmd(非空字符串)`);
  }
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string'))) {
    throw new HardError(`${where}(${entry.name})的 args 必须是字符串数组`);
  }
  if (
    entry.env !== undefined &&
    (typeof entry.env !== 'object' ||
      entry.env === null ||
      Array.isArray(entry.env) ||
      Object.values(entry.env).some((value) => typeof value !== 'string'))
  ) {
    throw new HardError(`${where}(${entry.name})的 env 必须是字符串到字符串的表`);
  }
  if (entry.timeoutMs !== undefined && !(typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0)) {
    throw new HardError(`${where}(${entry.name})的 timeoutMs 必须是正数`);
  }
  return {
    name: entry.name,
    cmd: entry.cmd,
    args: entry.args ?? [],
    env: entry.env ?? {},
    timeoutMs: entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** 读取注入案表(自测用缝);任何不可用都按硬错误抛,不把「没测成」读成「全绿」。 */
function loadInjectedTable(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new HardError(`案表不可读:${path} — ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HardError(`案表 JSON 非法:${path} — ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new HardError(`案表必须是数组:${path}`);
  }
  if (parsed.length === 0) {
    throw new HardError(`案表为空:${path} — 没有案子可跑不是「全绿」`);
  }
  return parsed.map(validateCase);
}

/** 命令行入口:无参数 = 内建案表;`--cases <文件>` = 注入案表(其余形态属配错)。 */
function loadCaseTable(args) {
  // 内建案表与注入案表走同一形状校验:默认值(args / env / timeoutMs)只有一处来源。
  if (args.length === 0) return { source: '内建', cases: CASES.map(validateCase) };
  if (args.length === 2 && args[0] === '--cases') {
    return { source: `注入 ${args[1]}`, cases: loadInjectedTable(args[1]) };
  }
  throw new HardError(`未知参数 ${args.join(' ')};用法:node scripts/check-examples.mjs [--cases <案表文件>]`);
}

/** POSIX 下子进程自成进程组:超时按组清掉,不给 CI 留下仍握着输出的孤儿。 */
function killProcessTree(child) {
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** 跑一案:子进程输出原样流式转发(不缓冲),超时按该案失败计。 */
function runCase(entry) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(entry.cmd, entry.args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, ...entry.env },
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ ok: false, reason: `启动失败 — ${error.message}`, elapsedMs: Date.now() - start });
      return;
    }

    let settled = false;
    let timedOut = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, elapsedMs: Date.now() - start });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, entry.timeoutMs);

    child.on('error', (error) => finish({ ok: false, reason: `启动失败 — ${error.message}` }));
    child.on('close', (code, signal) => {
      if (timedOut) return finish({ ok: false, reason: `超时(上限 ${entry.timeoutMs}ms)` });
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, reason: code === null ? `被信号 ${signal} 终止` : `退出码 ${code}` });
    });
  });
}

/** 串行跑完所有案再汇总(不 fail-fast 省掉的几秒不值一次只看见一例)。 */
async function runCases(cases, source) {
  const started = Date.now();
  // 案内可能带 `%` 等字符,不做 printf 式解释:直接拼进一行纯文本。
  console.log(`离线 example 冒烟闸门:${cases.length} 案,串行执行(案表:${source})\n`);
  const failures = [];

  for (const [index, entry] of cases.entries()) {
    console.log(`[${index + 1}/${cases.length}] ${entry.name} — ${reproCommand(entry)}`);
    const result = await runCase(entry);
    const elapsed = `${(result.elapsedMs / 1000).toFixed(1)}s`;
    if (result.ok) {
      console.log(`✓ ${entry.name} (${elapsed})`);
    } else {
      console.log(`✗ ${entry.name} (${elapsed}) — ${result.reason}`);
      failures.push({ entry, reason: result.reason });
    }
  }

  const total = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (failures.length === 0) {
    console.log(`\n全部 ${cases.length} 案通过(合计 ${total})`);
    return EXIT_OK;
  }
  console.log(`\n失败 ${failures.length}/${cases.length} 案(合计 ${total}):`);
  for (const { entry, reason } of failures) {
    console.log(`✗ ${entry.name} — ${reason}`);
    console.log(`    复现: ${reproCommand(entry)}`);
  }
  return EXIT_CASE_FAILED;
}

try {
  const { cases, source } = loadCaseTable(process.argv.slice(2));
  process.exitCode = await runCases(cases, source);
} catch (error) {
  if (!(error instanceof HardError)) throw error;
  console.error(error.message);
  process.exitCode = EXIT_HARD_ERROR;
}
