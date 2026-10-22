# CI 轻量红线:零运行时依赖硬闸门 + 字节预算黄灯(esbuild minify 口径)

每个 PR 上两条机制,口径与 ADR-0001 对齐:数字只作内部回归参考——不做公开承诺、不卡死合并。

**零运行时依赖 = 硬闸门(红)**。两条线都查:`package.json` 的 `dependencies` / `optionalDependencies` / `peerDependencies` 任一非空即失败(peer 自 npm 7 起会被自动安装,同样是用户要付的安装成本);并扫描 `dist/**/*.js` 的模块说明符,只有 Node 内置与相对路径合法——挡住「源码误引 devDependency、清单却干净」的绕过路径(否则 CI 绿、用户装机才炸)。扫描走 esbuild 的 metafile(把导入全部外部化后读解析结果),不做文本正则:注释与字符串里的 `from "pkg"` 不构成依赖,硬线不能误报。扫描边界:只覆盖说明符可静态解析的导入形态(静态/侧效 import、`export … from`、动态 `import()`、直呼 `require()`);`createRequire(import.meta.url)(...)` 这类运行期构造说明符的形态不在范围内——这条红线对着「意外泄漏」,不假装是绕过检测。脚本 `packages/core/scripts/check-runtime-deps.mjs`,挂进 `pnpm verify`(本 ADR 同时修订 ADR-0014 的那句话)。

**字节预算 = 黄灯(不卡合并)**。口径 = **esbuild minify 后每个子路径导出入口的 bundle 字节数**,与 ADR-0014 的构建链解耦:构建产物保持不 minify + 含 sourcemap,esbuild 只进测量侧(root devDependency,不进用户依赖树)。基线落 `packages/core/byte-budget.json`(带 `metric` 字段,口径不符即拒绝比对并显式报错),`pnpm byte-budget:update` 用实测值重写——基线调整与代码同 PR,成为可 review 的 diff。超预算、未建基线、基线陈旧都不卡合并,但退出码把两类非零分开:**0 = 在预算内;1 = 需处理(黄灯);2 = 配置/测量硬错误**(口径不符、入口无产物、测量失败)。CI 步骤写成 `pnpm check:byte-budget || test $? -eq 1`——只容忍 1,坏掉的检查照常变红。黄灯信号本身是 GitHub 警告注释(PR 上可见)加写进 job summary 的完整字节表(CI 的记录面);gzip 字节一并记录(edge 平台按 gzip 卡),但不设闸门。

CI 单 job,两段:硬闸门 `pnpm verify`(typecheck / build / test / check:dist / check:runtime-deps)+ 黄灯步骤 `pnpm check:byte-budget`。

## Considered Options

- **量 dist 原始字节**:被否——注释、格式与 sourcemap 把噪声带进闸门,且不等于用户实际付出的代码量;Hono 的 esbuild minify 口径才是对标水位(ADR-0001 点名)。
- **minify + gzip 双闸门**:被否——基线维护成本翻倍,两个数字会在同一份 diff 里来回动;gzip 降级为记录项,需要时再升闸门是可逆的。
- **只查清单字段**:被否——绕行成本太低(devDependency 里放包、源码照 import),硬线名存实亡。
- **正则扫产物文本**:被否——注释与字符串误报会让硬线失去可信度;esbuild metafile 的语法级结果零误报、零额外依赖(esbuild 本就在测量侧)。
- **PR 评论式呈现(octocov / github-script)**:被否——额外 action、`pull-requests: write` 权限与 fork PR 兜底;警告注释 + job summary 已覆盖 review 阶段可见性。
- **预算步骤一律 `continue-on-error`(把所有非零都当黄灯)**:被否——口径不符、入口无产物这类「检查坏了」的错误会被静默吞掉,黄灯迟早失守;改用退出码契约,只容忍 1。
- **硬预算(超限卡死)**:被否——直接违背 ADR-0001(数字是内部参考,不是公开承诺);黄灯的信号在 review 里,不在合并门上。
- **多 job 拆分(verify / budget 各一 runner)**:被否——install 与 build 重复一遍;单 job 内的步骤名已经给出同等可见性。

## Consequences

- 基线初值 = 空包实测(全 0 B)。首个落地代码的 PR 在同一 PR 内跑 `pnpm byte-budget:update` 上调基线——黄灯提示的正是这个动作,上调在 diff 里可见。
- 新增子系统:exports 表加一行即自动纳入测量;忘建基线只会亮黄灯,不阻塞。
- 升级口径(换度量方式)必须同时改脚本 `METRIC` 常量并重建基线;旧基线因 metric 不符拒绝比对并以退出码 2 报错(CI 变红),不会静默比较。
- esbuild 进根 devDependencies(ADR-0014 预告的路径);零运行时依赖红线不受影响——dev 依赖不进用户依赖树,且 `check:runtime-deps` 会挡住 devDependency 经静态导入泄漏进产物的情形(扫描边界见上)。
- `check:runtime-deps` 需要先 build(扫 dist);`pnpm verify` 的顺序保证这一点,单独调用而产物缺失时会以明确报错退出。
- 黄灯只保证「超预算可见」,不保证「基线被及时收紧」:压低数字靠 review 时的习惯,不设机制。
- **修订(M5 基建政策,2026-09-30)**:能力包(带依赖包)红线口径冻结——白名单硬闸门 + 数字黄灯,依据 [决策:M5 能力包基建政策](https://github.com/0xnicholas/balsa-framework/issues/72) 决议评论:
  - **硬闸门推广为「仅声明依赖」**:产物导入扫描的合法集从「零」推广为 Node 内置 ∪ 相对路径 ∪ 本包 manifest 运行时字段(`dependencies ∪ optionalDependencies ∪ peerDependencies`)的包名——名字精确匹配、含子路径(`pkg/sub`);其余说明符照旧即红。core 的合法集恒为空集(三字段非空即红,原语义不变);传递依赖不进导入扫描(重量由下方数字承载);`devDependencies` 不在合法集——源码误引 devDependency 照旧被挡。
  - **依赖数字 = 新黄灯**:每包 `deps-budget.json`(metric 字段沿本 ADR 先例,口径不符即退出码 2),条目 = 每个声明运行时依赖一条实测(传递包数 `packages` + 解包体积 `bytes` 合计;peer `@balsa/core` 豁免——核心重量由核心自身预算承载,其余 peer 如 `ai` 照记);`pnpm deps-budget:update` 用实测值重写(基线调整与代码同 PR);缺基线/超基线 = 退出码 1(黄灯),「声明但产物零引用」追加一行黄灯记录;CI 步骤与字节黄灯并列:`pnpm check:deps-budget || test $? -eq 1`。
  - **字节预算口径分形**:能力包测量把非相对导入一律 external,数字只反映第一方代码(供应商重量由 deps-budget 数字承载);对零依赖的 core 无差异;gzip 照旧记录、不设闸门。
  - **脚本落位**:共享实现移入根 `scripts/`(check-dist / check-runtime-deps / check-byte-budget / check-deps-budget),各包 `package.json` 留同名薄脚本指回根实现,`pnpm -r --if-present` 编排与 0/1/2 退出码契约不变;core 包内 `scripts/` 副本删除。脚本实现归实施图(本票只冻位置与挂法)。
  - **verify 内测试硬约束**:能力包单测必须无网络/外部服务(传输层 mock/fake;`node:sqlite` 等内置可用临时文件),保 CI 单 job 裸跑;需要真实服务/跨进程的验证落 `examples/`(不进 verify)。
- **修订(2026-10-02,文档站前置 [balsa-framework#82](https://github.com/0xnicholas/balsa-framework/issues/82))**:verify 增硬闸门 `pnpm check:export-surface`,依据 [balsa-docs api-reference §6/§7](https://github.com/0xnicholas/balsa-docs/blob/main/docs/spec/api-reference.md):
  - **口径**:「导出面 = 文档面」——被公共签名引用的类型必须能从**某个子路径入口**导出(判定是「有页」,不是「逐个入口自足」);否则参考树里它无页、交叉链接断链。
  - **判定走产物声明扫描**(`dist/*.d.ts` 的公共声明文本里,类型位置的标识符必须解析到某个入口导出的名字),**不在框架侧跑 TypeDoc**——文档侧零警告红线不充分(api-reference §3:同一入口在不同解析环境下 0 警告 vs 10 警告,警告出现与否依赖解析环境);同一条扫描对能力包同样成立(能力包入口单一,今天零命中)。
  - **唯一排除通道 = 源码 JSDoc 的 `@internal`**(与生成侧 `excludeInternal` 同源),不另设白名单。
  - **落位与退出码**:实现 `scripts/check-export-surface.mjs`,七包同名薄脚本指回,挂法沿本 ADR(0 = 干净 / 1 = 有缺口 / 2 = 配置·产物硬错误);与 `check:runtime-deps` 同属**硬闸门**(不是黄灯)。
- **修订(2026-10-02,离线 example 冒烟闸门 [balsats-framework#110](https://github.com/0xnicholas/balsats-framework/issues/110))**:CI 单 job 内、`pnpm verify` **之后**加一步硬闸门 `pnpm check:examples`,逐条跑四个离线 example 入口(`cron-schedule` · `otlp-collector` · `mcp-tools` HTTP + stdio)。
  - **不进 `verify`、不新增 job、不改 job 超时**:闸门是跨进程编排且消费当次构建产物,实现落根 `scripts/check-examples.mjs`(零第三方依赖);本地口径 = **先构建再跑**(`pnpm build && pnpm check:examples`),运行器不内建 dist 前置探测——CI 的构建顺序由 `verify` 保证,本地忘 build 以例子自身的模块解析错误呈现并计为该案失败。
  - **退出码沿本 ADR 形状,且是硬闸门(红)**:0 = 全绿 / 1 = 至少一案失败(含超时)/ 2 = 案表不可读·JSON 非法·空案表;CI 不做黄灯容忍(黄灯只给数字类预算)。
  - **案表条目 = 一条命令 + 可选逐案 env + 可选逐案超时**:后续接入 mock 例与需真 key 例只需案表加行、不改运行器(两者本票均不入闸门)。
  - **运行器自带负例自证**:注入案表(`--cases <文件>`)是唯一缝,覆盖一例失败 → 1、案表不可用 → 2、超时 → 1 三条路径。
- **修订(deps-budget 外部漂移吸收纪律,2026-10-11)**:追认 2026-10-04 的基线吸收(commit `2599950`)——`@modelcontextprotocol/server` 闭包 13,898,836 → 13,943,961 B(+45,125)、`/client` 14,837,940 → 14,893,010 B(+55,070),闭包包数均不变、本包依赖声明面未动 = 外部 registry 漂移,吸收成立;2026-10-11 实测 server 闭包 13,943,922 B 稳于基线(漂移双向),闸门绿灯。常设规则:**外部漂移型黄灯(闭包包数不变 + 声明面未动)可直接 `deps-budget:update` 吸收,但吸收 commit 必须同票闭环 tracker 上举起该黄灯的记录行(评论或关闭)——只改基线不记账 = 黄灯行悬空**(本次即脱节一周:吸收次日 #139 仍按旧记账报黄灯);闭包包数变化或声明面变动不属机械吸收,逐次另裁。依据 [决策:内部欠账处置](https://github.com/0xnicholas/oribos-framework/issues/146) 决议评论。
- **修订(deps-budget 基线吸收,#213 收口,2026-10-22)**:Lease 收口跑 `pnpm check:deps-budget` 时命中两处与 lease 无关的外部漂移,均按本 ADR 记账后吸收——(1) `@oribos/mcp-client` 的 `@modelcontextprotocol/client`:13 包不变,14,901,604 → 14,909,389 B(+7,785),声明面未动,机械吸收;(2) `@oribos/inngest` 的 `inngest@4.24.0`:231 → 308 包,70,927,569 → 103,429,873 B(+77 包 / +32,502,304 B),声明面仍 pin `inngest@4.24.0`,闭包包数变化故按上条「逐次另裁」在此裁决:接受吸收,依据 = npmjs 与镜像两端独立解析均为 308 包(上游传递依赖范围漂移,非本仓声明或测量口径变化)。两份基线随 #213 提交更新。

(来源:M1-02 ticket #23;度量口径由 ADR-0014 留给本票决定)
