# ZC-DEEP：packages/desktop/src/main/localMediaPreviewProtocol.ts

> 状态：**已完成**（b1 一批落盘，100 单元全覆盖，五道门禁全零）
> 文件规模：原始 209 行 + 已插入 94 行 = 当前 303 行 / **100 可注单元** / 起始 6 covered（6.0%）/ 收口 100.0%
> 风险档：A（不可逆证据：鉴权——`isAuthorized` 决定 renderer 能否读本地任意文件）
> 口径：`deep-quality.mjs --metric-version v3`；批次目录 `_annot_baseline/LMP-deep-b01/`

## 1. 批次清单

起始未覆盖 94 < 100，按 §2.9 直接进**逐条模式**，不分批：一次列全、一次落盘。

锚点取法按 §2.9.1：把当批 `_uncovered.txt` 的 94 个行号整段复制，**未按语句类型筛选**（`if` 条件行、`interface` 成员行、`Map` 泛型续行全部计入）。

| 批次 | 区域（原行号） | 插入行数 | 落盘后 UNCOVERED | 提交 |
| --- | --- | ---: | ---: | --- |
| b1 | 全文 1–209（逐条模式） | 94 | 0 | `4702929e` |

**合计插入 94 行**（= 新增覆盖单元 94 个，§2.7 构造保证）。

`Δuncovered = 94 → 0`，恰为 −94，与插入行数相等，§2.7 不变量未被破坏，无回滚。

## 2. 单元最终归属分布

| 归属 | 数量 | 占比 | 说明 |
| --- | ---: | ---: | --- |
| 已写注释（新增） | 94 | 94.0% | b1 插入 94 行，与新增覆盖单元数相等 |
| 起始已是上游注释 | 6 | 6.0% | orig 快照内已有，按 §2.6 只新增不改写 |
| 豁免 | 0 | 0% | 结构性不可注的 22 条属「非单元行」（import 22），不计入单元分母 |
| 未覆盖 | 0 | 0% | `UNCOVERED units=0` |
| **合计** | 100 | 100% | `covered=100`，覆盖率 100.0% |

`mappedStrict=100` **等于** `units=100`：本文件没有行尾注释，DEEP-SPEC §2.13a 的 `mappedStrict < units` 口径不适用于此文件。

## 3. 文件分段表

行号为插入完成后的当前值（209 + 94 = 303 行）。

| 行号（当前） | 段 | 内容 |
| --- | --- | --- |
| 1–18 | 模块头 | **INV-01…INV-18 不变量表**（授权精确路径、规范化、TTL、LRU、二次复核、一次注册、三重校验…） |
| 19–22 | 模块头 | 模块职责、状态所有权、阅读顺序 |
| 23–26 | 依赖 | `fs/promises` 的 `realpath`、`fs` 的 `realpathSync`/`statSync`、`node:path` 的 `isAbsolute`、`@zcode/shared` 的 scheme 常量 |
| 29–40 | 类型 | `LocalMediaPreviewSchemeRegistrar`：只暴露 `registerSchemesAsPrivileged` |
| 43–46 | 类型 | `LocalMediaPreviewProtocolRequest`：handler 只需 `url` |
| 49 | 类型 | `LocalMediaPreviewProtocolResponse = string \| { error: number }` |
| 52–65 | 类型 | `LocalMediaPreviewProtocol`：`registerFileProtocol` 最小接口 |
| 68–70 | 模块状态 | `installedProtocols`（WeakSet 去重）、`NET_ERR_INVALID_URL = -300` |
| 73–81 | 契约 | `LocalMediaPreviewPathRegistry`：`authorize` / `isAuthorized` / `clear` |
| 83–85 | 常量 | TTL 30 分钟、上限 256 条 |
| 87–230 | **授权表** | `createLocalMediaPreviewPathRegistry`：依赖注入、`pruneExpired`、`evictLeastRecentlyUsed`、`authorize` 写入、`isAuthorized` 二次复核、`clear` |
| 232–255 | 方案特权 | `registerLocalMediaPreviewScheme`：`standard`/`secure`/`stream` 一次注册，并入 `additionalSchemes` |
| 258–301 | **请求处理** | `installLocalMediaPreviewProtocol`：WeakSet 去重、`registerFileProtocol`、host/path/授权三重校验、错误码、注册失败抛错 |
| 303 | 导出 | 转出 `buildLocalMediaPreviewUrl` |

**授权表方法索引**（当前行号）：

| 行号 | 方法 | 要点 |
| --- | --- | --- |
| 89–99 | `pruneExpired` | 按 `expiresAt <= observedAt` 清理，遍历中删除当前项安全 |
| 101–114 | `evictLeastRecentlyUsed` | `while` 而非 `if`（一次可能超多条），线性找最小 `lastUsedAt` |
| 117–131 | `authorize` | 非绝对路径抛错 → `realpath` 规范化 → 写入带两个时间戳 → 立即淘汰 |
| 133–148 | `isAuthorized` | 先清过期 → 未登记直接 false → `realpathSync` + `isRegularFileSync` 复核，失败即撤销 |
| 150–152 | `clear` | 窗口销毁整表丢弃 |

## 4. 门禁记录

`zc-gate`（W/L/B/POEM）、`zc-verify`（deletedNonZero / nonCommentAdded / starSlash / syntaxErrorFiles）、`deep-boilerplate --diff`、`check-upstream-comments`（missing 必须为 0）。

- **W 前置门禁（`_ssh-insert.mjs`）拦下 4 行**：anchors 181 / 138 / 106 / 105 的注释正文缺 ASCII 标识符（如「已装过同一实例直接返回…」），`exit 1`、文件**零落盘**；补成 `installedProtocols`、`realpathSync`/`isRegularFileSync`、`lastUsedAt`、`authorizedPaths`/`maxEntries` 后一次通过。累计拦截 4 行、返工 0 行。
- **`zc-gate --scan` 首次判 1 行 L（无信息列举）**：anchor 191 原句「三重校验：host 固定 local、路径固定 /preview、且已授权。」含 2 个顿号且无谓词词，命中 L 规则；改写为「三重校验缺一不可：host 与 path 都能被任意协议链接伪造，必须靠 `isPathAuthorized` 拒绝未授权路径。」（因果句）后 `waterLines=0`。落盘后改的是同一行文本，行数不变。
- 终态：`waterLines 0`、`deletedNonZero 0`、`nonCommentAdded 0`、`starSlash 0`、`syntaxErrorFiles 0`、`dups 0 / dupLines 0`、`upstream missing 0`。

**收口原始输出（DEEP-SPEC §2.10，直接粘贴，不转述）**

```text
$ node _annot_baseline/deep-quality.mjs d:\code\ZCode --files packages/desktop/src/main/localMediaPreviewProtocol.ts --metric-version v3 --field-mode ast --quiet --json ... --uncovered ...
UNCOVERED units=0 out=d:\code\_annot_baseline\LMP-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=100 coverage=100.0% branch=100.0% field=100.0% comments=134 substance=96.3% explain=100.0% filler=0.0% weak=0.0%
MAP comments=134 mappedStrict=100 mappedBlock=112 unmapped=22 reasons=import:22,structural:0,continuation:0,gap:0,eof:0,other:0
```

```text
$ node _annot_baseline/_ssh-insert.mjs ...\b1.json ...\localMediaPreviewProtocol.ts
inserted 94 lines at 94 anchors
$ git log --oneline -1 4702929e
4702929e 注释(desktop): localMediaPreviewProtocol.ts b1 — 授权表与本地媒体协议注册（+94 行）
$ git cat-file -t 4702929e
commit
```

```text
$ node _annot_baseline/zc-gate.mjs --scan ...\LMP-deep-b01\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=94 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs LMP-deep-b01
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=94
$ node _annot_baseline/deep-boilerplate.mjs d:\code\ZCode --diff --files packages/desktop/src/main/localMediaPreviewProtocol.ts
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs d:\code\ZCode ...\LMP-deep-b01\_files.txt HEAD
SUMMARY files=1 checked=1 upstreamComments=159 missing=0
```

> `zc-gate` 与 `check-upstream-comments` 是**提交前**跑的值（提交后复跑 `addedCommentLines` 会归零，`upstreamComments` 会含本批新增行，不再有对照意义）。

**起始基线（存档，用于复核 `Δ = −94`）**

```text
UNCOVERED units=94 out=d:\code\_annot_baseline\LMP-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=100 coverage=6.0% branch=0.0% field=0.0% comments=40 substance=87.5% explain=100.0% filler=0.0% weak=0.0%
MAP comments=40 mappedStrict=6 mappedBlock=18 unmapped=22 reasons=import:22,structural:0,continuation:0,gap:0,eof:0,other:0
```

**遗留项**：只做语法 fail-closed 校验（TS 解析诊断 `syntaxErrorFiles=0`），未执行 `tsc --noEmit` 与单元测试；不得据此宣称「构建通过」。
