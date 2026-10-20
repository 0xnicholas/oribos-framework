/**
 * 测试共享工具:把异步可迭代对象收敛为数组。契约套件与各包测试从同一份实现取用,不各自复制
 * (规则见 `assertions.ts`)。
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
