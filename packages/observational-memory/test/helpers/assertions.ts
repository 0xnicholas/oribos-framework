/**
 * 测试共享断言工具:编译期断言与错误捕获。与 core 的 `test/helpers/assertions.ts` 同源同款
 * (跨包复制仅此两函数,不引 core 的测试面——那会拖进 workflows 类型)。
 */

/**
 * 编译期断言:`expectAssignable<To>(value)` 要求 value 的类型可赋值给 `To`,不满足时 tsc 直接报
 * "not assignable"。函数体运行时为空。
 */
export function expectAssignable<To>(_value: To): void {}

/** 断言接缝共用的失败收敛:Error 原样交还,其余原样重抛(不吞非 Error 抛出)。 */
function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  throw error;
}

/** 捕获 `run()` 拒绝的 Error;未拒绝、或抛出的不是 Error 时失败。 */
export async function captureRejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return asError(error);
  }
  throw new Error('expected the call to reject with an Error');
}
