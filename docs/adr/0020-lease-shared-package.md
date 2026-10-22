# Lease 共享包与叶子判词放宽:机制单源、零 core 边、消费者保留领域角色

2026-10-20 裁决(架构 review 候选 03;实施 #206;关联 #187 / #190 / #193)。本 ADR 修订 ADR-0002 M5 的叶子包判词,并把 Lease 机制的实现从两份能力包内拷贝收进一个共享叶子包。

## 背景

`@oribos/distributed-signals`(`packages/distributed-signals/src/index.ts:53-178`)与 `@oribos/background-tasks`(`packages/background-tasks/src/index.ts:97-223`)各自声明了一份 lease 实现。两份代码在 126/127 行中有 113 行 byte-identical:同一个 `LeaseHandle`、同一个内存实现(含 `now?: () => number` 注入)、同一个 `RedisLeaseClient` 结构类型、同样的 `SET NX PX` 与 `RENEW_SCRIPT` / `RELEASE_SCRIPT`、同一个 `mintToken`。两份 `test/lease.test.ts` 均 149 行,12–149 行逐字相同。差异只有类型名(`SignalLease` / `TaskLease`)、名词(thread / row)和一处签名换行。

当前模型不是事故:ADR-0002 M5 规定能力包之间默认不建依赖边;`docs/architecture/harness.md:74/96` 与 `CONTEXT.md` 的 Lease 条目明确写成「形状一份(#187 冻结)、两域复用、各能力包声明同形 port、零依赖边」。因此本裁决不是修复文档与代码的矛盾,而是改变这个模型本身。

#193 的叶子包例外是唯一先例:OTel bridge 与 OTLP 共用 semconv 映射,叶子 `@oribos/semconv` 以 `dependencies` 被依赖。但 #193 的判词是「无状态纯件」,而 `scripts/check-deps-budget.mjs` 的 `isLeafPackage()` 要求叶子唯一的 `@oribos/*` 运行时边是 `peerDependencies:@oribos/core`。Lease 是有状态的并发原语,且 `@oribos/background-tasks` 明确不 import core、对 core 无 peer(`packages/background-tasks/package.json:4`;`docs/architecture/harness.md:98`)。两条约束相撞,必须显式裁决叶子判词,而不是给 lease 包伪造一个 peer。

## 决定

1. **Lease 是一个机制层概念**:对命名工作单元的、带 TTL 和 token 的排他所有权。`acquire` 竞争失败方不作为;持有期通过 `renew` 续约;丢失后持有方停止声明。丢失后的语义归消费者:signals 的租约丢失 = 另一个实例可能唤醒 thread(at-most-once);background-tasks 的租约丢失 = 任务行成为 `adopt()` 的孤儿候选(at-least-once 重跑)。模块不拥有这个语义。
2. **新建公共叶子包 `@oribos/lease`**(`packages/lease`)。导出 `Lease`、`LeaseHandle`、`createInMemoryLeaseStore`、`createRedisLease`、`InMemoryLeaseStoreConfig`、`RedisLeaseConfig`、`RedisLeaseClient`。零外部依赖;Redis 客户端继续走结构子集;内存实现保留可注入 clock。TTL 公式与心跳/续约节奏留在消费者,不放进共享包。
3. **两个消费者以 `dependencies` 依赖共享包**(`"@oribos/lease": "workspace:^"`)。`SignalLease` / `TaskLease` 变成 `Lease` 的 re-export 别名,`LeaseHandle`、工厂与 config 类型原样 re-export,两个包的公共面逐字不变。
4. **放宽叶子判词**:叶子 = 公共包(`private !== true`),其 `@oribos/*` 运行时边为零,或仅 `peerDependencies:@oribos/core`;消费者必须用 `dependencies`,不得走 peer。语义条件保留:共享件、无模块级状态、无 core 身份语义、用户永不直接安装。机器判据是必要条件,不是充分条件。ADR-0002 的「无状态纯件」措辞改为「无模块级状态、无核心身份语义的共享件」。
5. **不做 core subpath**:`docs/architecture/harness.md:10/74` 已裁跨实例能力(共享 PubSub、执行租约、leader election)归能力包,不进核心;且 core subpath 会把 core 重新拉进 background-tasks。也不做 capability→capability 边,不用名义 optional peer 过闸门。

## Considered Options

- **维持两份拷贝,记录「不合并」**:否决。#193 已经明确否决「复制 + 一致性测试」方案(在单一真相源可行时);lease 是并发原语,Lua / token / 过期语义的漂移代价高于一个共享包。若未来两个域的续约/过期语义真的分叉(例如一边需要 fencing token),再拆回去。
- **把 Lease 放进 `@oribos/core` 子路径**:否决。违反 `docs/architecture/harness.md:10/74` 的能力包边界,并让 `@oribos/background-tasks` 重新获得 core peer。
- **新立「共享机制包」类别**:否决。与叶子包只差「无状态」一词,词汇税大于收益;叶子类别的目的是「能力包可依赖的共享件」,不是「纯函数」。
- **manifest 显式标记(如 `"oribos": { "shared": true }`)**:否决。更精确,但要改 M5 冻结的清单字段先例;当前边判据足够做必要条件。
- **给 lease 包加名义 optional peer core**:否决。模块不 import core,声明 peer 是把结构判词变成形式主义;`peerDependenciesMeta` 在仓库无先例。
- **共享包同时拥有 TTL/心跳 keeper**:否决(首版)。模块应该是 policy-free 机制;续约节奏在两个域不同(step 边界 vs handler interval)。第三个消费者或实际漂移出现时再提升。

## Consequences

- 新增第 20 个公共包,进入锁步发布列车;需要 README、LICENSE、`deps-budget`、`byte-budget`、`export-surface`、`prepublishOnly` 全套 M5 清单。
- `scripts/check-deps-budget.mjs` 的 `isLeafPackage()` 改为接受零 `@oribos/*` 运行时边或仅 peer core,并排除 `private: true`。两个消费者新增 `deps-budget.json`(`@oribos/lease`:1 package / 0 B,未发布下界,沿 #193 口径);lease 包自身无依赖行。
- 两份 149 行测试合并为一份共享契约测试;两个消费者保留自己的集成测试(唤醒竞态 / adopt 重跑)。
- 两个消费者的字节预算缩小,`byte-budget:update` 吸收;`pnpm verify`、`check:deps-budget`、`check:examples` 必须全绿。
- `background-tasks` 的安装闭包多一个 workspace 包(零外部依赖);其「零依赖」描述改为「零外部依赖」,`docs/architecture/harness.md:98` 的 no-core 立场不变。
- `@oribos/lease` 是叶子包,不是能力包;用户不直接安装;`packages/background-tasks/README.md` 与 `docs/architecture/README.md` 的包清单在实施时更新。
- 复核条件:两个域的续约/过期语义分叉、第三个消费者需要 TTL/keeper、或出现第二个「有状态但无身份语义」的共享件时,重开本裁决。

## 实施状态

**已实施**(2026-10-20 `0fe63d7`;2026-10-22 #213 收口)。`@oribos/lease` 公共叶子包已落地,README / LICENSE / `byte-budget` / export surface 齐全,零声明运行时依赖故无 `deps-budget` 基线需求(沿脚本「零依赖免基线」语义);npm 名位 `@oribos/lease` 未占用;两个消费者以 `dependencies` 依赖并保留冻结公共名(`SignalLease` / `TaskLease` 为 `Lease` 别名);叶子判词放宽已进 `check-deps-budget` 闸门。仓库中无重复 lease 实现或契约测试——机制与契约测试只在 `packages/lease`,`distributed-signals` / `background-tasks` 只保留各自集成测试(唤醒竞态 / `adopt()` 重跑)。`pnpm verify`、`pnpm check:deps-budget`、`pnpm check:examples` 全绿(外部漂移基线吸收见 ADR-0015 2026-10-22 修订记)。

(来源:架构 review 2026-10-20 候选 03;关联 #187 / #190 / #193;实施 #206)
