# ZC-DEEP：packages/desktop/src/main/resourceManagerNetwork.ts

> 状态：**已完成**（b1 一批落盘，70 单元全覆盖，五道门禁全零）
> 文件规模：原始 148 行 + 已插入 65 行 = 当前 213 行 / **70 可注单元** / 起始 5 covered（7.1%）/ 收口 100.0%
> 风险档：A（不可逆证据：鉴权——`authorize` 决定谁能读窗口的网络记录；IPC/桥接面 R1.5）
> 口径：`deep-quality.mjs --metric-version v3`；批次目录 `_annot_baseline/RMN-deep-b01/`

## 1. 批次清单

起始未覆盖 65 < 100，按 §2.9 直接进**逐条模式**：一次列全、一次落盘，不分批。与同回合另两个文件各自独立成批、各自核对 Δ、各自提交（§2.14）。

锚点取法按 §2.9.1：把当批 `_uncovered.txt` 的 65 个行号整段复制，**未按语句类型筛选**（`if` 条件行、参数续行、`webContentsId ? ... : null` 三元续行全部计入）。

| 批次 | 区域（原行号） | 插入行数 | 落盘后 UNCOVERED | 提交 |
| --- | --- | ---: | ---: | --- |
| b1 | 全文 30–146（逐条模式） | 65 | 0 | `a17e1a6e` |

**合计插入 65 行**（= 新增覆盖单元 65 个，§2.7 构造保证）。

`Δuncovered = 65 → 0`，恰为 −65，与插入行数相等，§2.7 不变量未被破坏，无回滚。

**W 前置门禁拦下 2 行、零落盘**：anchor 100 与 145 原句缺 ASCII 标识符（「停止同样幂等…」「主进程采集也要换标识」），`exit 1` 后补入 `captureId` 一次通过。`zc-gate --scan` 另判 2 行 L（见 §4）。

## 2. 单元最终归属分布

| 归属 | 数量 | 占比 | 说明 |
| --- | ---: | ---: | --- |
| 已写注释（新增） | 65 | 92.9% | b1 插入 65 行，与新增覆盖单元数相等 |
| 起始已是上游注释 | 5 | 7.1% | orig 快照内已有，按 §2.6 只新增不改写 |
| 豁免 | 0 | 0% | import 22 行属「非单元行」，不计入幂 |
| 未覆盖 | 0 | 0% | `UNCOVERED units=0` |
| **合计** | 70 | 100% | `covered=70`，覆盖率 100.0% |

`mappedStrict=70` **等于** `units=70`：本文件没有行尾注释，§2.13a 的 `mappedStrict < units` 口径不适用。

## 3. 文件分段表

行号为插入完成后的当前值（148 + 65 = 213 行）。

| 行号（当前） | 段 | 内容 |
| --- | --- | --- |
| 1–19 | 模块头 | **INV-01…INV-18 不变量表**（单会话、先分配标识再启动、只订应用自带会话、清空即换标识…） |
| 20–22 | 模块头 | 模块职责、状态所有权、阅读顺序 |
| 23–28 | 依赖 | `randomUUID`、`ipcMain/session/webContents`、`HostMessageTypes/PlatformChannels`、`createNodeNetworkCapture`、`NetworkCaptureBuffer`、`subscribeBeforeRequest` |
| 30–41 | 模块状态 | `buffer` / `nodeCapture` / `captureId` / `ownerId` / `currentHosts` / `disposers`（每个变量前一行注释） |
| 44–50 | 主机接入 | `configureNetworkCaptureHost`：无会话早退、只给单个 child 补发 |
| 52–60 | 控制消息 | `sendControl`：`HostMessageTypes.NetworkCapture` + `captureId`，异常吞掉不重启 Host |
| 62–132 | **启动与订阅** | `startResourceManagerNetwork`：早退 → 分配标识 → 记住 owner → `buffer.start` → 三个 session 订阅 → 逐请求入库（销毁/remote 过滤、三元取 pid）→ 补发 Host |
| 134–154 | **停止与事件** | `stopResourceManagerNetwork`：先清标识再退订、`buffer.stop`、通知全部 Host |
| 156–173 | 窗口绑定 | `observeNetworkWindow`：`closed` / `render-process-gone` / `destroyed` 三事件共用一个 stop |
| 175–185 | 主机批次汇入 | `ingestHostNetworkCapture`：只留 host/cli、host 记录改写为本机 pid |
| 187–213 | **IPC 授权** | `registerResourceManagerNetworkIpc`：`authorize` + 快照通道 + 清空通道（换 `captureId` 后重启缓冲并补发控制） |

## 4. 门禁记录

`zc-gate`（W/L/B/POEM）、`zc-verify`（deletedNonZero / nonCommentAdded / starSlash / syntaxErrorFiles）、`deep-boilerplate --diff`、`check-upstream-comments`（missing 必须为 0）、`check-comments-in-strings`（addedViolations 必须为 0）。

- **`zc-gate --scan` 首次判 2 行 L（无信息列举）**：anchor 43 原句「…唯一入口，启动、清空、热接入三处都调用它」含 2 个顿号；anchor 118 原句「…原样记录，不做大小写归一，报表侧按原值匹配」含 2 个逗号且无谓词词。分别改写为「启动与清空都走它，绕过它会让 Host 收不到 `captureId`」与「原样记录而不做大小写归一，报表侧按原值匹配才能和网络面板对上」后 `waterLines=0`。落盘后改的是同一行文本，行数不变。
- 终态：`waterLines 0`、`deletedNonZero 0`、`nonCommentAdded 0`、`starSlash 0`、`syntaxErrorFiles 0`、`dups 0 / dupLines 0`、`upstream missing 0`、`addedViolations 0`。

**收口原始输出（DEEP-SPEC §2.10，直接粘贴，不转述）**

```text
$ node _annot_baseline/deep-quality.mjs d:\code\ZCode --files packages/desktop/src/main/resourceManagerNetwork.ts --metric-version v3 --field-mode ast --quiet --json ... --uncovered ...
UNCOVERED units=0 out=d:\code\_annot_baseline\RMN-deep-b01\_uncovered_after.txt
SUMMARY metric=v3 files=1 units=70 coverage=100.0% branch=100.0% field=-% comments=93 substance=97.8% explain=100.0% filler=0.0% weak=0.0%
MAP comments=93 mappedStrict=70 mappedBlock=70 unmapped=23 reasons=import:22,structural:1,continuation:0,gap:0,eof:0,other:0
```

```text
$ node _annot_baseline/_ssh-insert.mjs ...\b1.json ...\resourceManagerNetwork.ts
inserted 65 lines at 65 anchors
$ git log --oneline -1 a17e1a6e
a17e1a6e 注释(desktop): resourceManagerNetwork.ts b1 — 网络采集会话与 IPC 授权（+65 行）
$ git cat-file -t a17e1a6e
commit
```

```text
$ node _annot_baseline/zc-gate.mjs --scan ...\RMN-deep-b01\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=0 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs RMN-deep-b01
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=65
$ node _annot_baseline/deep-boilerplate.mjs d:\code\ZCode --diff --files packages/desktop/src/main/resourceManagerNetwork.ts
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs d:\code\ZCode ...\RMN-deep-b01\_files.txt HEAD
SUMMARY files=1 checked=1 upstreamComments=92 missing=0
$ node _annot_baseline/check-comments-in-strings.mjs d:\code\ZCode ...\RMN-deep-b01\_files.txt
SUMMARY files=1 scanned=1 stringRanges=23 violations=0 addedViolations=0
```

> `zc-gate` 是**提交后**复跑的值，`addedCommentLines` 因此归零（diff 基准为 HEAD）；提交前同一命令为 `addedCommentLines=65`、`waterLines=0`。`check-upstream-comments` 同理含本批新增行。

**起始基线（存档，用于复核 `Δ = −65`）**

```text
UNCOVERED units=65 out=d:\code\_annot_baseline\RMN-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=70 coverage=7.1% branch=0.0% field=-% comments=28 substance=92.9% explain=100.0% filler=0.0% weak=0.0%
MAP comments=28 mappedStrict=5 mappedBlock=5 unmapped=23 reasons=import:22,structural:1,continuation:0,gap:0,eof:0,other:0
```

**遗留项**：只做语法 fail-closed 校验（TS 解析诊断 `syntaxErrorFiles=0`），未执行 `tsc --noEmit` 与单元测试；不得据此宣称「构建通过」。
