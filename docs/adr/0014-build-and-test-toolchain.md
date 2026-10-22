# 构建与测试工具链:TypeScript 直出 ESM + Vitest,Node ≥22.12 基线

路线图刻意留白的实现期选型在此拍板,约束只有一条:核心包运行时依赖 = 0(ADR-0001 内部 CI 回归线)。

**构建 = TypeScript 编译器直出**(`typescript@7`,原生编译器),不引 bundler:每个子系统一个源目录,产物 1:1 落到 `dist/<子系统>/index.js` + `.d.ts` + sourcemap,子路径导出表(ADR-0002:`@balsa/core/model` 等)只是目录映射的机械投影。**包形态 = 纯 ESM**:`exports` 只有 `types` + `default` 两个条件、`"type": "module"`,不做双构建;CJS 消费者在 Node ≥22.12 经原生 `require(esm)` 同样可用——这也是 engines 基线从"≥22"收窄到 `>=22.12.0` 的原因。**测试 = Vitest**(devDependency,工作区根一份配置,`packages/*/test/**` 是唯一收集面),`@balsa/core/*` 在 vitest 别名与 tsconfig `paths` 里指向源码——测试走公开子路径、不依赖构建;构建产物另由 `packages/core/scripts/check-dist.mjs` 按 exports 表逐个 `import()` + `require()` 验真。**类型检查 = `tsc --noEmit`**:`tsconfig.base.json` 开满 strict 家族(`strict` / `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax` / `noUnused*`),包内配置覆盖 `src` 与 `test`。工具链全部落在 devDependencies,发布面保持零运行时依赖。`pnpm verify`(typecheck + build + test + check:dist)是本地与 CI(#23)共用的单一入口。

## Considered Options

- **bundler(rollup / tsup / tsdown + dts 插件)**:被否——子路径导出本来就不需要打包,bundler 却带入第二套入口声明、插件与 dts 配置;TypeScript 7 的原生编译器已消解"tsc 构建慢"的历史理由。若 CI 字节预算(#23)要 Hono 式 minify 口径,在测量脚本里单独引 esbuild 即可,构建链保持不掺入。
- **双构建(CJS + ESM)**:被否——双份产物翻倍维护与字节口径,还带 dual-package hazard 的老账;原生 `require(esm)` 已覆盖 Node 侧 CJS 消费者,代价只是 engines 收窄到 22.12。
- **node:test + Node 原生类型剥离**:被否——零依赖诱人,但交互筛选 / watch / 断言 / 覆盖率 / 类型测试(下一票的 vendor 类型对校需要)都要自己拼装,测试期成本大于一个 dev 依赖;"轻量"轴约束的是运行时(ADR-0001),dev 依赖不进用户依赖树。
- **`@types/node` 对齐最新 Node(26)**:被否——类型对齐基线(22)才能在编译期挡住"用了基线没有的 API"的漂移。

## Consequences

- **修订(#23 起)**:`pnpm verify` 的组成在原四步之外增加 `check:runtime-deps`(零运行时依赖硬线),见 ADR-0015。
- 新增子系统 = 新建 `src/<名>/index.ts` + `exports` 一行 + `test/export-map.test.ts` 的清单加一项;`entry-points.test.ts` 与 `check:dist` 自动覆盖新入口。
- 构建产物不 minify、含 sourcemap;CI 字节预算(#23)的口径在测量侧决定,与构建链解耦。
- 测试从工作区根一把跑;单文件与过滤走 vitest CLI 的路径参数,包内不各自配 runner。
- 发布面为纯 ESM:Node 22.12 以下不可用;0.x 期若出现真实需求再评估双构建。
- 工具链版本由根 `package.json` + `pnpm-lock.yaml` 锁定(pnpm 由 `packageManager` 字段固定);dev 工具提升到工作区根,包内不重复声明。
- **修订(M5 SQLite 参考 adapter 设计冻结,2026-09-30)**:engines 基线自 `>=22.12.0` 抬至 **`>=22.13.0`**(root `engines` / core 与能力包清单 / CI `node-version` 同步),依据 [决策:SQLite 参考 adapter](https://github.com/0xnicholas/balsa-framework/issues/76):`node:sqlite` 在 22.12 需 `--experimental-sqlite`、22.13 起免 flag,而 22.13 ≥ 22.12 使 `require(esm)` 下限性质不变;上文标题与正文的「Node ≥22.12 基线」以本修订为准,双构建仍不做。
- **修订(#225 测试稳定性,2026-10-22)**:收集面不变(工作区根一份配置 + `packages/*/test/**/*.test.ts`),但根 `test` 块改用 `test.projects` 分两档超时预算:`packages/mcp-client` 每例都真起 in-process HTTP 服务 + 走完整 SDK 握手/分页,是全仓最重的一档,给 `testTimeout: 15000`;其余包显式钉住 Vitest 默认的 5000ms——慢用例照旧暴露,不靠抬高全仓预算掩盖。依据:并发峰值上约 25 个 worker 同时在跑时,I/O 饥饿会把平时 170–250ms 的用例拖过 5s(5 次整跑里 1 次 5 文件 / 13 例超时,失败例逻辑正确、只是没跑完);并发加压不复现,唯一相关变量是紧跟一次冷 `build`。包内仍不各自配 runner:分组写在根配置里,`vitest run` 仍是唯一入口,`--project mcp-client` 可单跑重的一档。

(来源:M1-01 ticket #22)
