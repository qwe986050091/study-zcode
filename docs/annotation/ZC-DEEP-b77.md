# ZC-DEEP-b77

> 批次：B77（6 文件，按 31.4% 口径计算目标 351 行，实际 +351，无补插）。
> 沿用 B76 起的 6 文件上限，6 个 spec 并行编写、逐文件自检后一次插入。
> 断点续跑：B76 校验全绿、无半插入残留；本批复算后取缺口最高的 6 个 ui 文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b77\orig`；开工前 6 文件均为 `newComments=0`（30% 口径 needLines=336）。

## 校验

```
node zc-verify.mjs ZC-deep-b77
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=351

node check-batch.mjs ZC-deep-b77 ZC-deep-b77-files.txt
TOTAL added=351 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   289   205    64   58  packages/ui/src/ToolCallBlocks/fileSummaries.ts
31.34   278   201    63   58  packages/ui/src/remote-connection/RemoteConnectionHistoryInput.tsx
31.35   250   185    58   58  packages/ui/src/lib/builtinSkillI18n.ts
31.44   302   229    72   59  packages/ui/src/hooks/useComposerConnectionSwitch.ts
31.61   266   193    61   59  packages/ui/src/hooks/useSessionSubagents.ts
31.61   262   193    61   59  packages/ui/src/mentions/providers/sessionsMentionProvider.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.22 median=31.40 newComments=351
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/hooks/useComposerConnectionSwitch.ts` | Composer 连接切换 hook | INV-01~18；owner 票据与 inFlight 互斥；ready 版本闸门；readModels 双读后按 connectionKey 核对 | 59 |
| `ui/src/hooks/useSessionSubagents.ts` | 子会话列表分页 hook | INV-01~18；状态独占与快照；并发令牌；翻页去重；缺参会话与能力缺失两条失败路径 | 59 |
| `ui/src/lib/builtinSkillI18n.ts` | 内置技能文案映射 | INV-01~18；两份官方插件白名单；逐字字典的豁免边界；描述回退与官方判定短路 | 58 |
| `ui/src/mentions/providers/sessionsMentionProvider.ts` | 会话 @ 提及 provider | INV-01~18；当前工作区权重；时间/标题稳定序；标题前缀剥离；迁移镜像过滤 | 59 |
| `ui/src/remote-connection/RemoteConnectionHistoryInput.tsx` | 远程连接历史输入框 | INV-01~18；派生过滤；打开/关闭收敛；选中回写；键盘导航与空态 | 58 |
| `ui/src/ToolCallBlocks/fileSummaries.ts` | 工具调用文件摘要 | INV-01~18；display 归一化；hunk 坐标回落；空补丁失败路径；路径去重与顺序 | 58 |

合计 **351**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. owner 票据与 inFlight 互斥成对存在

`useComposerConnectionSwitch.ts` 用 owner 票据标记当前生效的切换请求，并用 inFlight 挡住重复提交。
只置其一会让旧请求的 finally 清掉新请求的票据，界面停在「切换中」而实际连接已就绪。

### 2. fetch 回调必须按 connectionKey 核对

`readModels` 双读之后要按 connectionKey 判定结果归属。
漏掉核对会让慢返回的旧连接模型列表覆盖新连接，用户看到的是上一个环境的模型。

### 3. 翻页结果按游标去重

`useSessionSubagents.ts` 用并发令牌区分「同一游标的重复触发」与「新一页」。
不按令牌去重会在快速滚动时把同一页追加两次，子会话列表出现重复行且计数虚高。

### 4. 标题前缀剥离只做一次

`sessionsMentionProvider.ts` 在排序前剥离标题前缀，后续比较必须用剥离后的键。
重复剥离或先后混用会让排序在不同刷新周期之间抖动，候选顺序不稳定。

### 5. 自动聚焦必须可拦截

`RemoteConnectionHistoryInput.tsx` 打开即聚焦，但外部显式拦截时必须让出焦点。
忽略拦截会在弹层嵌套场景抢走输入焦点，用户正在编辑的内容被打断。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| owner 票据未与 inFlight 成对清理 | 旧请求 finally 清掉新票据，界面卡在切换中 |
| readModels 结果不核对 connectionKey | 旧连接模型列表覆盖新连接 |
| 翻页不按并发令牌去重 | 快速滚动时同一页重复追加 |
| 状态与快照不同步 | 取消后仍按旧快照渲染 |
| 标题前缀重复剥离 | 候选排序在刷新间抖动 |
| 白名单写成单份 | 官方插件被误判为非官方，来源标签错误 |
| 缺省描述不回退 | 技能卡片出现空白描述 |
| 迁移镜像过滤后置 | 已迁移会话仍出现在候选里 |
| hunk 坐标未回落 | 摘要指向错误的文件区域 |
| 空补丁未提前返回 | 摘要渲染出空条目 |

## 断点报告（续跑基线）

- 最后完成批次：**B76**（6 文件 / +358 行 / 全绿）；B76 复验 `added=358`、硬校验全 0。
- 累计（core+apps）：**734 文件 / 99,753 行**。
- 半插入残留：无（B77 开工前 spec / files.txt / 快照目录均不存在，B76 六文件行数与 spec 吻合）。
- 剩余缺口：按基线推导 **2,490 个 coreBelow30 / 41,837 行**，完成度 **70.5%**；
  全仓实测 `files=5032 coreBelow30=2501 needLines=52045`（services 已收口）。

> 说明：每文件独立 spec，6 个并行编写，逐文件自检 `OK blocks / lines` 后统一插入。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.61%，`suspicious=0`。
