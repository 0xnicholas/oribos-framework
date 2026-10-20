import { describe, expect, it } from 'vitest';
import { captureRejection } from './assertions.js';
import { collect } from './collect.js';

/**
 * 输出对象行为契约(#127,提升至本包 #205):懒启动单遍泵的行为矩阵钉在这一个参数化辅助上,
 * core agent、workflow 与能力包(`resumable-stream`)各自以公开面构造的输出对象喂它(测试纪律:
 * 零内部 import)。各域仅源形状不同——agent 拉 generator、workflow 推 promise+emit、能力包包一层
 * 录制泵——共享泵必须让同一矩阵在每侧全绿:
 * 懒启动 / 单迭代器同一性 / 缓冲排空序 / 失败在缓冲后到达 / abandon 不传播 / 终值惰性。
 *
 * 消费方式:在 suite 顶层调用 `describeOutputObjectContract({ success, failure })`;两个工厂每次
 * 调用都必须造一只**全新**输出对象(矩阵各用例各自消费,不共享一只),`started` 探针报告该 run
 * 的源是否已启动,`terminal` / `error` 是期望的终值与失败原因。
 */

/** 一只被测输出对象、它的期望值与探针(每次调用脚本工厂造一只新对象,各用例互不消费)。 */
export interface OutputObjectScript<TChunk> {
  /** 被测输出对象。 */
  readonly output: AsyncIterable<TChunk>;
  /** 读它的一只终值——调用即读取惰性 getter(会启动 run),故以 thunk 延后。 */
  readonly readTerminal: () => Promise<unknown>;
  /** 源启动探针:模型已调用 / step 已执行 / 录制泵已启动。 */
  readonly started: () => boolean;
  /** 期望按序收到的 chunk(可含 `expect.any` 等非对称 matcher)。 */
  readonly chunks: readonly unknown[];
  /** 期望的终值(可含非对称 matcher)。 */
  readonly terminal: unknown;
}

/** 两域各自提供的脚本工厂;期望值由工厂在造 run 后计算(如 workflow 事件的 runId)。 */
export interface OutputObjectScripting<TChunk> {
  /** 造一个「按序发 chunks、以 terminal 收敛」的 run。 */
  readonly success: () => OutputObjectScript<TChunk>;
  /** 造一个「按序发 chunks 后以 error 失败」的 run;error 的身份即迭代器与终值的拒绝原因。 */
  readonly failure: () => Omit<OutputObjectScript<TChunk>, 'terminal'> & { readonly error: Error };
}

/** 把输出对象行为契约跑进当前 suite:每个用例向脚本工厂要一只新输出对象。 */
export function describeOutputObjectContract<TChunk>(scripting: OutputObjectScripting<TChunk>): void {
  describe('输出对象行为契约(共享泵)', () => {
    it('懒启动:首次消费前源不启动;迭代与读终值各自启动恰好一次 run', async () => {
      const viaIteration = scripting.success();
      expect(viaIteration.started()).toBe(false);

      expect(await collect(viaIteration.output)).toEqual(viaIteration.chunks);
      expect(viaIteration.started()).toBe(true);

      const viaTerminal = scripting.success();
      expect(viaTerminal.started()).toBe(false);

      await expect(viaTerminal.readTerminal()).resolves.toEqual(viaTerminal.terminal);
      expect(viaTerminal.started()).toBe(true);
    });

    it('单迭代器同一性:Symbol.asyncIterator 的每次调用返回同一迭代器', () => {
      const script = scripting.success();

      expect(script.output[Symbol.asyncIterator]()).toBe(script.output[Symbol.asyncIterator]());
    });

    it('缓冲排空序:先读终值再迭代,缓冲的 chunk 按流序全数交付', async () => {
      const script = scripting.success();

      await expect(script.readTerminal()).resolves.toEqual(script.terminal);

      expect(await collect(script.output)).toEqual(script.chunks);
    });

    it('失败在缓冲后到达:先读终值让 chunk 入缓冲,排空后迭代器与终值以同一错误 reject', async () => {
      const script = scripting.failure();
      const seen: TChunk[] = [];

      // 先读终值:run 启动、chunk 因无迭代器等待而入缓冲,随后失败。先挂拒绝处理,排空
      // 期间缓冲的失败才不会成为 unhandled rejection(终值本身随后仍按原样断言)。
      const terminal = script.readTerminal();
      terminal.catch(() => undefined);

      const error = await captureRejection(async () => {
        for await (const chunk of script.output) seen.push(chunk);
      });

      expect(seen).toEqual(script.chunks);
      expect(error).toBe(script.error);
      await expect(terminal).rejects.toBe(script.error);
    });

    it('abandon 不传播:提前 break 不取消 run,该次迭代到此为止、不再缓冲', async () => {
      const script = scripting.success();

      for await (const chunk of script.output) {
        expect(chunk).toEqual(script.chunks[0]);
        break;
      }

      await expect(script.readTerminal()).resolves.toEqual(script.terminal);
      expect(await collect(script.output)).toEqual([]);
    });

    it('终值惰性:迭代完成后才读的终值照常 resolve;重复读返回同一只 promise', async () => {
      const script = scripting.success();

      expect(await collect(script.output)).toEqual(script.chunks);

      await expect(script.readTerminal()).resolves.toEqual(script.terminal);
      expect(script.readTerminal()).toBe(script.readTerminal());
    });
  });
}
