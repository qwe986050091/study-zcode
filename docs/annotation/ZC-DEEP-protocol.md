# ZC-DEEP-protocol（一档 A 组 · pluginSandbox 协议入口）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/desktop/src/main/pluginSandbox/protocol.ts`（落盘后 486 行，153 个可注单元；基线 352 行）。
> 该文件是 `zcode-sandbox://` 的唯一 handler：scheme 特权注册 → URL 解析 → host 归属校验 → shell/plugin 分支 → 静态资源与 HTML 注入。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\PLUGIN-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成） |
| 起始状态 | units 153 / covered 19 / **12.4%** / `R = 134` |
| 阈值判定 | `R = 134 > 120`，§5.3.1 要求先抽 60 条再决定 |
| 实际执行 | **未抽 60 条，直接全读**：352 行、134 个未覆盖单元，通读时逐条核对全部为真缺口。与 `zaiProviderAdapter` 同样是对 §5.3.1 的流程偏离，记录在此，不写成「抽样后升级」 |
| 停止规则 | 末轮 `UNCOVERED units=0` |
| R 取值时点 | 每批插入后重测再取；6 批锚点均按上一批落盘后的新行号重取 |
| 归属判据 | 改写任何一行前先查 `PLUGIN-deep-b01/orig/`（= `git show HEAD:` 转 CRLF，建目录时已校验与工作文件 `equalWork=true`） |
| 批次前状态 | 该文件**无**未提交注释，工作区与 HEAD 一致；本文件 214 行注释 = 上游 80 + 本批 134 |

## 2. 实际执行（按函数/分支边界分批，6 批）

| 批次 | 区域 | 新增整行 `//` | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | 契约常量、`PluginSandboxSchemeRegistrar`、`PluginSandboxProtocolHost` | 10 | 29（19.0%） |
| b2 | `PluginSandboxRequestTarget`、`parsePluginSandboxUrl` 全部分支 | 22 | 51（33.3%） |
| b3 | `injectPluginSandboxAliasScript`、`MIME_BY_EXTENSION`、工厂选项接口、`serveAsset` | 26 | 77（50.3%） |
| b4 | `handle` 前置校验 + shell 分支（dev server 代理 / 磁盘 / 404） | 27 | 104（68.0%） |
| b5 | plugin 分支（vendor、运行时脚本、别名脚本、gen-ui 注入、错误出口） | 32 | 136（88.9%） |
| b6 | 响应包装（缓存头与日志）、`install` / `uninstall` | 17 | 153（100.0%） |
| **合计** | — | **134** | — |

`git diff HEAD --numstat` = **+134 / −0**，与本表合计、`zc-verify added=134`、`zc-gate addedCommentLines=134` 三处一致。

## 3. 定格表述

**`R = 0`（153/153 全读收口）**，记 `read-all`，不记抽样。

## 4. 数量对账（三个总数必须自洽）

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 153 | `deep-quality --metric-version v3` |
| 文件内注释行（当前） | 214 | 同上 `comments`；逐行统计 203 行 `//` + 11 行块注释 |
| 相对 HEAD 新增行 | 134 | `git diff HEAD --numstat` = `+134 / −0` |
| 其中：本批新增 | 134 | 6 批插入行数之和，等于起始未覆盖数 |
| HEAD 注释行（物理行） | 80 | 逐行统计 69 行 `//` + 11 行块注释 |

闭合：**80（上游） + 134（本批） = 214（现状）**。

**与 `check-upstream-comments` 的 85 不是同一口径，不能相加**：该脚本把 `*/` 结尾的行按「先剥 `*` 再找 `*/`」处理，剥离后不再包含 `*/`，块注释不闭合，于是把紧随其后的 7 行代码（`devServerUrl?: string;`、`}` 等）也算成注释片段；同时漏掉 2 行真正的注释。净结果 85 而非 80。这是脚本计数口径的已知偏差，不影响它的 `missing` 判定（被误算的片段是代码原文，当前文件里必然存在），所以本文件只取 **missing=0** 作结论，不拿 85 参与对账。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 153 / coverage **100.0%** / branch 100%（30/30）/ field 100%（21/21）/ substance 98.1% / explain 99.5% / filler 0.0% / weak 0.5% |
| 映射 | 同上 `MAP` | mappedStrict 153 / mappedBlock 191 / unmapped 23（import 22、continuation 1） |
| 代码与上游 | `zc-verify.mjs PLUGIN-deep-b01`（普通批） | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 134 |
| 注水 | `zc-gate.mjs --file packages/desktop/src/main/pluginSandbox/protocol.ts` | badFiles **0** / waterLines **0** / waterRate 0.00% |
| 近重复 | `deep-boilerplate.mjs --diff --baseline PLUGIN-deep-b01\orig` | groups 0 / lines 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0**（upstreamComments 85，口径见 §4） |

**为什么是普通批而不是 `--rewrite`**：本文件相对 HEAD 只有新增，没有任何改写；过程中对我自己刚插入的行做过 8 次措辞修正（W/L 告警），这些行在 HEAD 中都不存在，对 HEAD 的差异仍是 `+134/−0`，因此普通模式即可满足 `deletedNonZero=0`。

## 6. 清理与记账

1. **注水清零**：`zc-gate` 共报 13 行（W 8 行、L 5 行），全部本批新增，全部原位置改写：补真实标识符（`registry`、`serveAsset`、`sep`、`notFound`、`PluginSandboxAssetSource`、`status`、`Constructor`）或补谓词（`必须`、`不能`、`只能`、`否则`），不增删行。末轮 `waterLines=0`。
2. **weak 0.5% 的归属**：唯一一条 weak 行是**上游**注释（`orig` 第 294 行「标签切换的短暂溢出可能在撑高后残留空滚动条…」，落盘后第 405 行），`deep-quality` 判其「无解释」。按 §2.6 上游行只许新增、不许改写，故保留；它不是本批遗留，也不该为了指标好看去动它。`explainRate 99.5%` 是同一行的另一面。
3. **双写规避**：该文件上游已有 80 行块式注释（多写在函数声明上方），本批按单元补的是行内契约（字段顺序、分支互补、失败出口），没有把块注释原话搬到单元上方。b5 里 `router` 与 `serveAsset` 的 CSP 头注释各自说明「取哪一份策略、取错会怎样」，不是重复句。
4. **行号漂移**：6 批累计插入 134 行，后批锚点全部按重生成的 uncovered 取（b1 38–60，b6 433–468）。
5. **未做**：只做 TS 解析级语法校验，**未跑** `tsc --noEmit` 与单元测试。

## 7. 遗留

- §1 的抽样偏离同 `zaiProviderAdapter`：若要求严格按 §5.3.1，需补一次随机 60 条复核留痕；本批已全读，补抽样不改变结论。
- 批次目录 `PLUGIN-deep-b01/` 保留 `_uncovered.txt`（末轮为空）、`_quality.json`、`orig/`、`_upstream.json` 与 b1–b6 锚点 JSON，可逐批复算。
