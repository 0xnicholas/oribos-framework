/**
 * 测试共享断言工具:各包测试从同一份实现取用,不各自复制。
 */

/** 捕获 `run()` 拒绝的 Error;未拒绝、或拒绝的不是 Error 时失败。 */
export async function captureRejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an Error');
}
