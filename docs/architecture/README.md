# 架构规范

极致轻量 TypeScript/Node agent 框架的架构规范索引。术语表在根目录 `CONTEXT.md`,决策依据在 `docs/adr/`,实施顺序在 `docs/ROADMAP.md`。

各篇均按同一骨架展开:定位 → 定义表面/语义 → 与其它子系统的关系 → 依赖预算。建议阅读顺序:

1. [model.md](model.md) — 模型层:模型契约(vendor 自 AI SDK provider spec 子集)与 chunk 协议,一切的地基
2. [agent.md](agent.md) — Agent 核心抽象:五字段表面、动态参数、输出对象、loop、Processor、多 agent as-tool 组合
3. [tools.md](tools.md) — Tools/MCP 抽象:四字段 Tool、execute 上下文、MCP server/client 能力包
4. [workflows.md](workflows.md) — Workflow 引擎语义:扁平条目 + walker、suspend/resume 快照
5. [memory.md](memory.md) — Memory 语义:thread/resource 双标识、消息历史、working memory
6. [observability.md](observability.md) — Observability 形态:自有 span 模型、三事件、exporter 最小面、七边界埋点
7. [storage.md](storage.md) — 存储适配策略:port 集合 + adapter 家族(非子系统)、additive-only 演化纪律
8. [harness.md](harness.md) — Harness 语义集:durable 审批闸、signals、schedules(文档分类,非模块)

> **能力包(M5)口径**:目录与构建沿 [ADR-0002](../adr/0002-package-structure.md) 的 M5 修订记(平铺 `packages/<短名>`、清单字段沿核心、对核心走 peer);依赖红线与黄灯数字口径沿 [ADR-0015](../adr/0015-ci-lightweight-redlines.md) 的 M5 修订记。六包已设计冻结并**实施完成**(地图 [#65](https://github.com/0xnicholas/oribos-framework/issues/65) 收线,实施票 [#87](https://github.com/0xnicholas/oribos-framework/issues/87)–[#92](https://github.com/0xnicholas/oribos-framework/issues/92),bunfold 沿裁单不产包;核对见 `docs/ROADMAP.md` M5「实施完成」段);各包定义表面仍归对应篇章:
>
> | 包 | 定义表面(所在节) |
> | --- | --- |
> | `@oribos/mcp-server` / `@oribos/mcp-client` | [tools.md](tools.md)「MCP server 能力包」/「MCP client 能力包」 |
> | `@oribos/otlp` | [observability.md](observability.md)「OTLP 能力包(M5 设计冻结)」 |
> | `@oribos/sqlite` | [storage.md](storage.md)「SQLite 参考 adapter(M5 设计冻结)」 |
> | `@oribos/ai-sdk` | [model.md](model.md)「AI SDK 互操作能力包(M5 设计冻结)」 |
> | `@oribos/croner` | [harness.md](harness.md)「croner 封装能力包」 |
> | `@oribos/supervisor` | [agent.md](agent.md)「多 agent 组合」(追赶面首批落地,2026-10-12 [#175](https://github.com/0xnicholas/oribos-framework/issues/175)) |
> | bunfold 桥(**已裁**,不建包;[#79](https://github.com/0xnicholas/oribos-framework/issues/79)) | [memory.md](memory.md)「外部记忆引擎(M5 裁定:不产桥接包)」 |
