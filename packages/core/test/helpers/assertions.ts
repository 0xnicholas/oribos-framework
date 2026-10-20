import type {
  WorkflowRunOutcome,
  WorkflowRunSuccessOutcome,
  WorkflowRunSuspendedOutcome,
} from '@oribos/core/workflows';

/**
 * 测试共享断言工具:编译期断言与错误捕获。各测试文件从同一份实现取用,不各自复制。
 */

/**
 * 编译期断言:`expectAssignable<To>(value)` 要求 value 的类型可赋值给 `To`,不满足时 tsc 直接报
 * "not assignable"。不用 expect-type 的 `toExtend`:它在 `exactOptionalPropertyTypes` 下对含联合与
 * 可选属性的对象给出假阴性(普通赋值可通过)。函数体运行时为空。
 */
export function expectAssignable<To>(_value: To): void {}

/** 断言接缝共用的失败收敛:Error 原样交还,其余原样重抛(不吞非 Error 抛出)。 */
function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  throw error;
}

/** 拒绝捕获的正本居 `@oribos/testing`(与共享契约套件同一实现),本文件只做转出。 */
export { captureRejection } from '@oribos/testing';

/** 捕获 `run()` 抛出的 Error;未抛出、或抛出的不是 Error 时失败。 */
export function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return asError(error);
  }
  throw new Error('expected the call to throw an Error');
}

/**
 * 收窄 run 的终态信封并断言 success:suspend 臂加入联合后(#51),`output` 只在 success 分支上。
 * 测试里把「断言 success + 取 output」收成一步;挂起臂按语义抛出可读错误。
 */
export function expectSuccess<TOutput>(
  outcome: WorkflowRunOutcome<TOutput>,
): WorkflowRunSuccessOutcome<TOutput> {
  if (outcome.status !== 'success') {
    throw new Error(`expected a successful run outcome, got "${outcome.status}"`);
  }
  return outcome;
}

/**
 * 收窄 run 的终态信封并断言 suspended:挂起臂带 `stepId`,payload 在
 * `stepResults[stepId].suspendPayload`。与 `expectSuccess` 同模式。
 */
export function expectSuspended(outcome: WorkflowRunOutcome): WorkflowRunSuspendedOutcome {
  if (outcome.status !== 'suspended') {
    throw new Error(`expected a suspended run outcome, got "${outcome.status}"`);
  }
  return outcome;
}
