import { describe, expect, it, vi } from 'vitest';
import { createInMemoryPubSub, createRedisPubSub } from '@oribos/distributed-signals';
import type { RedisPubSubClient } from '@oribos/distributed-signals';

/**
 * SignalPubSub port(#187 冻结表面):at-most-once、回调式——`publish(topic, payload: string)` /
 * `subscribe(topics, handler): Promise<Unsubscribe>`。内存默认零依赖;`createRedisPubSub({ client })`
 * 走 `subscribe` / `publish` 结构子集(客户端随调用方)。话题是裸字符串——频道命名
 * (`<prefix>oribos:signals:<threadId>`)是包装组合的事,不是 port 的事。
 */

/** 一个记录调用、可手动投递的假 Redis 客户端(结构子集形状)。 */
function fakeRedisPubSub() {
  const listeners = new Map<string, Set<(channel: string, message: string) => void>>();
  const calls: string[] = [];
  const channelList = (channels: string | readonly string[]): string[] =>
    typeof channels === 'string' ? [channels] : [...channels];
  const client: RedisPubSubClient = {
    subscribe(channels: string | readonly string[], listener: (channel: string, message: string) => void) {
      for (const channel of channelList(channels)) {
        let set = listeners.get(channel);
        if (set === undefined) {
          set = new Set();
          listeners.set(channel, set);
        }
        set.add(listener);
      }
      calls.push(`subscribe:${channelList(channels).join(',')}`);
      return Promise.resolve();
    },
    unsubscribe(channels, listener) {
      for (const channel of channelList(channels)) {
        listeners.get(channel)?.delete(listener);
      }
      calls.push(`unsubscribe:${channelList(channels).join(',')}`);
      return Promise.resolve();
    },
    publish(channel, message) {
      calls.push(`publish:${channel}:${message}`);
      return Promise.resolve(1);
    },
  };
  return {
    client,
    calls,
    /** 模拟 Redis 服务端把消息推给该频道的每个订阅者。 */
    deliver(channel: string, message: string): void {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(channel, message);
    },
  };
}

describe('createInMemoryPubSub', () => {
  it('publish 回调式送达该话题的每个订阅者(channel + payload)', async () => {
    const pubsub = createInMemoryPubSub();
    const first = vi.fn();
    const second = vi.fn();
    await pubsub.subscribe(['t1'], first);
    await pubsub.subscribe(['t1'], second);

    await pubsub.publish('t1', 'hello');

    expect(first).toHaveBeenCalledWith('t1', 'hello');
    expect(second).toHaveBeenCalledWith('t1', 'hello');
  });

  it('无订阅者的话题投递即丢(at-most-once),不抛错', async () => {
    const pubsub = createInMemoryPubSub();
    await expect(pubsub.publish('nobody-listens', 'x')).resolves.toBeUndefined();
  });

  it('unsubscribe 之后不再送达', async () => {
    const pubsub = createInMemoryPubSub();
    const handler = vi.fn();
    const off = await pubsub.subscribe(['t1'], handler);
    await off();

    await pubsub.publish('t1', 'after');

    expect(handler).not.toHaveBeenCalled();
  });

  it('subscribe 接受话题数组,各自投递', async () => {
    const pubsub = createInMemoryPubSub();
    const handler = vi.fn();
    await pubsub.subscribe(['a', 'b'], handler);

    await pubsub.publish('a', '1');
    await pubsub.publish('b', '2');
    await pubsub.publish('c', '3');

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('a', '1');
    expect(handler).toHaveBeenCalledWith('b', '2');
  });
});

describe('createRedisPubSub', () => {
  it('subscribe 向客户端注册,推送以 (channel, message) 送达 handler', async () => {
    const fake = fakeRedisPubSub();
    const pubsub = createRedisPubSub({ client: fake.client });
    const handler = vi.fn();
    await pubsub.subscribe(['oribos:signals:t1'], handler);

    expect(fake.calls).toContain('subscribe:oribos:signals:t1');
    fake.deliver('oribos:signals:t1', 'x');
    expect(handler).toHaveBeenCalledWith('oribos:signals:t1', 'x');
  });

  it('publish 走 client.publish(channel, message)', async () => {
    const fake = fakeRedisPubSub();
    const pubsub = createRedisPubSub({ client: fake.client });
    const handler = vi.fn();
    await pubsub.subscribe(['ch'], handler);

    await pubsub.publish('ch', 'x');
    expect(fake.calls).toContain('publish:ch:x');

    fake.deliver('ch', 'x');
    expect(handler).toHaveBeenCalledWith('ch', 'x');
  });

  it('unsubscribe 注销转发器,之后推送不再送达', async () => {
    const fake = fakeRedisPubSub();
    const pubsub = createRedisPubSub({ client: fake.client });
    const handler = vi.fn();
    const off = await pubsub.subscribe(['ch'], handler);
    await off();

    expect(fake.calls).toContain('unsubscribe:ch');
    fake.deliver('ch', 'after');
    expect(handler).not.toHaveBeenCalled();
  });

  it('同一 handler 挂多个频道:按频道分发,互不串线', async () => {
    const fake = fakeRedisPubSub();
    const pubsub = createRedisPubSub({ client: fake.client });
    const handler = vi.fn();
    await pubsub.subscribe(['a', 'b'], handler);

    fake.deliver('b', 'from-b');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('b', 'from-b');
  });
});
