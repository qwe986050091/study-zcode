# ZC-deep-b358

> 批次：b358 ｜ **30 行 / 6 文件** ｜ 提交 `7cad6d4c`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 方案 ① 普通批；`fix` 两轮（首轮 9 hit）

- `TALLY {"ownIn":30,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":30,"planOut":0}` / `plan=30` / `files=6/6`。
- **首轮 `hits=9`，逐条记类型（b358/b359 的强制记录项）**：
  - `W` 单行无信息 4 条：`ProviderSettingsCard.tsx:68`（纯中文无锚点）、`:115`（同上）、
    `:201`（`on*` 不足 3 字符，不算锚点）、`stack-trace.tsx:547`（`渲染期/解析期` 为中文，无标识符）。
  - `L` 无信息列举 5 条：`WorkflowArtifactSidePane.tsx:224`（`不等/据此` 不在谓词表）、
    `CodingPlanContextUsage.tsx:350`（`区分` 不在谓词表）、`jsx-preview.tsx:351`（`来自` 不在谓词表）、
    `ProviderSettingsCard.tsx:365`（`控制` 不在谓词表）、`stack-trace.tsx:435`（`不需要` 不在谓词表）。
  - 根因单一：**「因此/所以」之外的因果词与「不等/区分/来自/控制」都不算谓词**，补 `必须/只能/返回/由/保持/不会` 后全部转强；`W` 四条各补真实标识符（`logger/credential`、`QRCode.toDataURL`、`ProviderSettingsCard/Button`、`frames/showInternalFrames`）。
- 第二轮 `hits=0`，**`fix=2`**。按纪律记「连续两批 fix≥2 即停批做语义抽检第二轮」的计数：b358 = 1。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx` | 5 | 5 | 0 | ui/app-shell |
| `packages/ui/src/BotsDialog/ProviderSettingsCard.tsx` | 5 | 5 | 0 | ui/BotsDialog |
| `packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx` | 5 | 5 | 0 | ui/chat-input-toolbar |
| `packages/ui/src/components/ai-elements/jsx-preview.tsx` | 5 | 5 | 0 | ui/components/ai-elements |
| `packages/ui/src/components/ai-elements/stack-trace.tsx` | 5 | 5 | 0 | ui/components/ai-elements |
| `packages/ui/src/hooks/usePlugins.ts` | 5 | 5 | 0 | ui/hooks |
| **合计** | **30** | **30** | **0** | — |

- **目录分布**：**1 个顶层目录**（`packages/ui`），5 个子域。
- 选行依据 §6.1 第 6 条的实测密度：池内只剩 21 个 ≥5 行文件，本批取其中 6 个，故 30 行是当前单批上限。
  仍未重跑产能（窗口在 b360），候选来自「池内 ∩ 当前 weak」现筛。

## 2. 改动内容

- `WorkflowArtifactSidePane.tsx`：租约登记在 effect 内、渲染期纯计算；正文通道由 `preset` 分流；
  `selectedVersion` 回落到 `tab.version`；`version` 与 `artifact.version` 不等时提示有更新；
  复制按钮的三条件与 `preset`、`bytes`、`isTextArtifactContentType` 对齐。
- `ProviderSettingsCard.tsx`：日志只写错误、不含凭据；二维码在挂载时生成；回调只做意图上抛；
  `loading` 只驱动禁用与图标；不叠加「已有二维码」的禁用条件。
- `CodingPlanContextUsage.tsx`：进入判定只看能否进入；挂载后空 `state` 返回 `null`；
  周额度用 `date` 口径；无重置时间保持 `undefined`；`quotaMeters` 不含空条目。
- `jsx-preview.tsx`：三类标签的判定顺序；`stripIncompleteTag` 的截断边界；
  `completeJsxTag` 的线性复杂度；栈只存 `tagName`；错误条不占位。
- `stack-trace.tsx`：先 `trim` 再匹配；`parseStackTrace` 不抛错；`timeoutRef` 用 0 免判空；
  默认展示内部帧；过滤放在渲染期。
- `usePlugins.ts`：服务缺失不抛错；刷新期间保留旧列表；安装前重读实时快照；不一致先补初始化；
  实时值优于闭包值。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=7cad6d4c files=6/6 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=40 auto_self_clear=0
gate: PASS order n=0 total=199.0s controllable=146.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 池外与进度

- 全仓 weak：`4,234 → 4,204`（**−30**），文件 `1,668 → 1,662`（**−6**，六个文件全部清零）。
- `done += 30`（池内自清 0）、`files -= 6`；本批 6 个文件均无池外残留。
- **句子级**：`done 6,458 / remain 963`，`6,458 + 963 = 7,421`，**87.0%**。
- 池外：`4,204 − 963 = 3,241`（不变）。
- **文件数两列（§6.2 第 13 条）**：可清 **376** / 含池外残留 **1,286**（floor 1,286）。
- 池内密度：**963 行 / 462 文件 = 2.08 行/文件**（b357 为 2.12）。

## 6. 计时（B 段第 9 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `f7bc695b`（11:46:20） | 批次提交 `7cad6d4c`（11:49:39） | 199.0s | 6.63s |
| `controllable` | `--start`（11:47:13） | 批次提交（11:49:39） | 146.0s | **4.87s** |
| 收口段 | 批次提交（11:49:39） | 台账提交 `8268b4ae`（11:50:56） | 77s | — |
| `批墙钟` | 最早产物 `b358-t-start.txt`（11:47:13） | 台账提交 `8268b4ae`（11:50:56） | 223.0s | 7.43s |

- 可控段 4.87 s/行是 B 段最低：30 行集中在前 21 个高密度文件里，两轮判据返修只占约 25s。
- 监控：收口 77s（阈值 150s，未触发）、可控 4.87 s/行（阈值 8，未触发）。
- 白名单 `preflight --whitelist` → `STALE-EXPECTED n=11 source=3 docs=8`（新判据，见 `preflight.mjs`），
  `--total-start f7bc695b --batch-commit 7cad6d4c` → `TOTAL-START OK`，两条均 1s 内，无手工排查。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `7cad6d4c` | `+30/−30` |
| `ZC-deep-b358-rewrite.tsv` + 本台账 + INDEX | `8268b4ae` | — |
