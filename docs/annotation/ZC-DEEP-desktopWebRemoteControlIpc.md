# ZC-DEEP：packages/desktop/src/main/desktopWebRemoteControlIpc.ts

> 状态：**已完成**（b1 一批落盘，69 单元全覆盖，五道门禁全零）
> 文件规模：原始 170 行 + 已插入 63 行 = 当前 233 行 / **69 可注单元** / 起始 6 covered（8.7%）/ 收口 100.0%
> 风险档：A（不可逆证据：跨进程入口——`ipcMain.handle` 四通道 + 窗口反查授权；R1.5）
> 口径：`deep-quality.mjs --metric-version v3`；批次目录 `_annot_baseline/DWRC-deep-b01/`

## 1. 批次清单

起始未覆盖 63 < 100，按 §2.9 直接进**逐条模式**。本文件是本回合第三个文件，与另两个各自独立成批、各自核对 Δ、各自提交（§2.14）。

锚点按 §2.9.1 从当批 `_uncovered.txt` 整段复制，**未按语句类型筛选**（接口成员行、参数续行、箭头函数续行、三元分支全部计入）。

| 批次 | 区域（原行号） | 插入行数 | 落盘后 UNCOVERED | 提交 |
| --- | --- | ---: | ---: | --- |
| b1 | 全文 43–168（逐条模式） | 63 | 0 | `35f676c6` |

**合计插入 63 行**；`Δuncovered = 63 → 0`，§2.7 不变量成立，无回滚。

**W 前置门禁拦下 1 行、零落盘**：anchor 91 原句「解析失败不上抛…」缺 ASCII 标识符，`exit 1` 后补 `parseRemoteWorkspaceIdentity` 一次通过。

## 2. 单元最终归属分布

| 归属 | 数量 | 占比 | 说明 |
| --- | ---: | ---: | --- |
| 已写注释（新增） | 63 | 91.3% | b1 插入 63 行 |
| 起始已是上游注释 | 6 | 8.7% | orig 快照内已有 |
| 未覆盖 | 0 | 0% | `UNCOVERED units=0` |
| **合计** | 69 | 100% | `covered=69`，覆盖率 100.0% |

`mappedStrict=69` **等于** `units=69`；`mappedBlock=74` 是包含文件头块注释在内的总映射数，不作为覆盖率分母。

## 3. 文件分段表

行号为插入完成后的当前值（170 + 63 = 233 行）。

| 行号（当前） | 段 | 内容 |
| --- | ---: | --- |
| 1–22 | 模块头 | **INV-01…INV-18 不变量表** + 模块职责/状态所有权/阅读顺序 |
| 23–37 | 依赖 | `BrowserWindow/ipcMain`、`@zcode/shared` 的遥测构造与 `PlatformChannels`、`WebRemoteControlStartAuthorization` |
| 39–41 | 接口前块注释 | 五个能力与「管理器由依赖注入」 |
| 42–66 | **管理器契约** | `WebRemoteControlIpcManager`：`authorizeStart` / `startAuthorized` / `notifyAuthStateChanged` / `stop` / `getStatus` |
| 68–73 | 依赖表 | `reportRemoteUsageEvent` + `webRemoteControlManager` 两项 |
| 76–92 | 遥测包装 | `reportRemoteUsageEventSafely`：唯一上报点 + 异常吞掉 |
| 94–98 | 类型推导 | `resolveWorkspaceKind`：按 `workspaceIdentity`/`remoteSessionId` 判 local / remote |
| 100–166 | **启动操作** | `runStartOperation`：先算遥测字段 → `sender` 反查窗口 → 空则抛给定文案 → `operation` → 成功/失败各上报一次 → 原样返回或重抛 |
| 168–233 | **四通道接线** | `registerWebRemoteControlIpcHandlers`：`on` 授权状态变更、`handle` 启动（186）/停止（212）/状态（223），全部用 `event.sender` 反查 |

## 4. 门禁记录

`zc-gate`、`zc-verify`、`deep-boilerplate --diff`、`check-upstream-comments`、`check-comments-in-strings`。

- 本批 `zc-gate --scan` **一次通过**，无 L/W/B/POEM 命中；`check-comments-in-strings` 的 `stringRanges=14` 与新增注释零交集（`addedViolations=0`）。
- 终态：`waterLines 0`、`deletedNonZero 0`、`nonCommentAdded 0`、`starSlash 0`、`syntaxErrorFiles 0`、`dups 0`、`upstream missing 0`、`addedViolations 0`。

**收口原始输出（直接粘贴，不转述）**

```text
$ node _annot_baseline/deep-quality.mjs d:\code\ZCode --files packages/desktop/src/main/desktopWebRemoteControlIpc.ts --metric-version v3 --field-mode ast --quiet --json ... --uncovered ...
UNCOVERED units=0 out=d:\code\_annot_baseline\DWRC-deep-b01\_uncovered_after.txt
SUMMARY metric=v3 files=1 units=69 coverage=100.0% branch=100.0% field=100.0% comments=98 substance=99.0% explain=100.0% filler=0.0% weak=0.0%
MAP comments=98 mappedStrict=69 mappedBlock=74 unmapped=24 reasons=import:22,structural:2,continuation:0,gap:0,eof:0,other:0
```

```text
$ node _annot_baseline/_ssh-insert.mjs ...\b1.json ...\desktopWebRemoteControlIpc.ts
inserted 63 lines at 63 anchors
$ git log --oneline -1 35f676c6
35f676c6 注释(desktop): desktopWebRemoteControlIpc.ts b1 — 远控启动操作与四通道接线（+63 行）
$ git cat-file -t 35f676c6
commit
```

```text
$ node _annot_baseline/zc-gate.mjs --scan ...\DWRC-deep-b01\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=0 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs DWRC-deep-b01
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=63
$ node _annot_baseline/deep-boilerplate.mjs d:\code\ZCode --diff --files packages/desktop/src/main/desktopWebRemoteControlIpc.ts
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs d:\code\ZCode ...\DWRC-deep-b01\_files.txt HEAD
SUMMARY files=1 checked=1 upstreamComments=97 missing=0
$ node _annot_baseline/check-comments-in-strings.mjs d:\code\ZCode ...\DWRC-deep-b01\_files.txt
SUMMARY files=1 scanned=1 stringRanges=14 violations=0 addedViolations=0
```

> `zc-gate` 为**提交后**复跑，`addedCommentLines` 归零是 diff 基准为 HEAD 所致；提交前同一命令为 `addedCommentLines=63`、`waterLines=0`。

**起始基线（存档，用于复核 `Δ = −63`）**

```text
UNCOVERED units=63 out=d:\code\_annot_baseline\DWRC-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=69 coverage=8.7% branch=0.0% field=0.0% comments=35 substance=97.1% explain=100.0% filler=0.0% weak=0.0%
MAP comments=35 mappedStrict=6 mappedBlock=11 unmapped=24 reasons=import:22,structural:2,continuation:0,gap:0,eof:0,other:0
```

**遗留项**：只做语法 fail-closed 校验，未执行 `tsc --noEmit` 与单元测试；不得据此宣称「构建通过」。
