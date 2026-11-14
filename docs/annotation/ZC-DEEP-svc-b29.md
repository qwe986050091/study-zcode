# SVC-B29 注释批次索引（B 档「写尽即止」第 2 组 / 分诊 B2）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`
> 分诊依据：`docs/annotation/ZC-DEEP-svc-triage.md` §4（B 档 29 文件，不设函数级 15% 目标）
> 范围：10 个普通文件；只新增整行中文 `//` 注释，不改代码、不改上游注释。
> 口径：内文率 = 函数体内「整行中文注释行」÷ 函数体内「代码行」（`zc-inner.mjs`）。

## 1. 结果

| 文件 | 代码行 | 内文前→后 | 新增 |
| --- | ---: | --- | ---: |
| `plugins/officialPluginCache.ts` | 34 | 0.00% → 17.65%（6/34） | 6 |
| `session/claude-native/importedClaudeTaskFileFilter.ts` | 37 | 13.51% → 27.03%（10/37） | 5 |
| `cua-permission-broker/cuaHelperInstaller.ts` | 32 | 0.00% → 18.75%（6/32） | 6 |
| `storage/adapters/inProcessScanRunner.ts` | 33 | 6.06% → 24.24%（8/33） | 6 |
| `storage/adapters/volumeProbe.ts` | 30 | 6.67% → 23.33%（7/30） | 5 |
| `storage/adapters/rootsResolver.ts` | 22 | 0.00% → 18.18%（4/22） | 4 |
| `remote-sync/remoteSyncWriteAccess.ts` | 25 | 12.00% → 28.00%（7/25） | 4 |
| `task-facts/repairSubagentTaskIndex.ts` | 30 | 13.33% → 30.00%（9/30） | 5 |
| `zcode-session/zcodeSessionDraftRegistry.ts` | 27 | 11.11% → 29.63%（8/27） | 5 |
| `zcode-session/importedClaudeSessionRepair.ts` | 21 | 9.52% → 28.57%（6/21） | 4 |
| **合计** | **291** | 中位 23.68% → 27.03% | **50** |

## 2. 每文件「为何非关键」判据（分诊 §4）

- `plugins/officialPluginCache.ts`：只读扫描缓存目录并排序，不安装、不加锁、不写 `installed_plugins.json`。
- `session/claude-native/importedClaudeTaskFileFilter.ts`：纯数据变换（深拷贝后按路径剔字段），无 IO、无状态。
- `cua-permission-broker/cuaHelperInstaller.ts`：字符串归一化 + 依赖包装，不触碰文件系统与安装流程。
- `storage/adapters/inProcessScanRunner.ts`：扫描编排，不持锁、不落盘，单根失败只进 `errors`。
- `storage/adapters/volumeProbe.ts`：容量探测，任一步失败降级 `null`，不向调用方抛错。
- `storage/adapters/rootsResolver.ts`：纯路径拼接与规范化，路径来源由调用方注入。
- `remote-sync/remoteSyncWriteAccess.ts`：写前探测，失败只返回 `ok:false`，不改目录状态。
- `task-facts/repairSubagentTaskIndex.ts`：幂等清理派生索引行，不碰 Agent 转录。
- `zcode-session/zcodeSessionDraftRegistry.ts`：进程内 `Set` 标记，无持久化、重启即丢。
- `zcode-session/importedClaudeSessionRepair.ts`：参数适配与失败降级，修复返回 null 时原样返回入参。

## 3. 校验命令原文

```text
node d:\code\_annot_baseline\zc-insert.mjs d:\code\_annot_baseline\ZC-deep-svc-b29\spec.json
TOTAL inserted 50 comment lines
```

```text
node d:\code\_annot_baseline\zc-verify.mjs --rewrite ZC-deep-svc-b29
SUMMARY files=10 rewrittenSegments=15 deletedOwnCommentLines=16 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

`deletedOwnCommentLines=16` 来自水线清理：这 16 行均为本线此前新增、不在 HEAD 的注水行，改写而非删除上游注释（`upstreamCommentDeleted=0`）。

```text
node d:\code\_annot_baseline\zc-gate.mjs --scan d:\code\_annot_baseline\ZC-deep-svc-b29\_files.txt
SUMMARY files=10 badFiles=0 addedCommentLines=138 waterLines=0 waterRate=0.00%
```

```text
node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <10 文件> --threshold 15 --fns 0
SUMMARY files=10 innerCode=291 innerZh=71 below15=0 min=17.65 median=27.03
```

```text
node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files <同列表> --quiet --top 20
SUMMARY files=10 units=197 coverage=42.6% branch=45.2% field=0.0% comments=172 substance=72.7% explain=100.0% filler=0.0% weak=0.0%
```

## 4. 本批锚定的不变量

- `officialPluginCache`：`DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 必须与 bootstrap 的 `defaultEnabled` 逐项一致；版本目录按数字感知降序，跳过 `.backup` / `.seed-lock` / `.tmp-`。
- `importedClaudeTaskFileFilter`：先 `structuredClone` 再删除，绝不修改调用方入参；路径或形状不匹配时静默返回。
- `cuaHelperInstaller`：`readExecutableArchs` 返回前必须归一化，唯一装配入口是 `createCanonicalCuaHelperInstaller`。
- `inProcessScanRunner`：单根失败只进 `errors`，不中断其余根；最终 `onProgress` 必须与返回值一致。
- `volumeProbe`：失败一律 `null`；用 `bavail` 而非 `bfree` 计算用户可用空间。
- `rootsResolver`：home 恒在首位；仅当自定义目录 ≠ 家目录时追加第二个根。
- `remoteSyncWriteAccess`：成功返回前必须删除 marker；失败也尽力清理，不覆盖原始错误。
- `repairSubagentTaskIndex`：可见会话永不删除；child 身份只由 CLI 权威结果裁决。
- `zcodeSessionDraftRegistry`：remember / has / forget 必须共用同一 key 推导（identity 优先）。
- `importedClaudeSessionRepair`：修复失败时原样返回入参快照，resume 链路不得因历史损坏中断。

## 5. 不可改项

- 不修改任何代码 token；不删除 HEAD 中已有的上游注释。
- 不在模板字符串内部插入注释（本批锚点全部落在语句或对象属性行之前）。
- 不把 `officialPluginCache` 改成写缓存或加锁，也不改版本排序策略。
- 不把 `volumeProbe` 的 `null` 降级改成抛错或返回 0 容量。
- 不把 `rootsResolver` 的根顺序或 `hasCustomDataBaseDir` 语义改成按字符串推断。
- 不把 `remoteSyncWriteAccess` 的探针移到系统临时目录，也不吞掉 `rm` 之外的真实错误。
- 不为过线在纯 DTO / 路径拼接处硬填注释；本批单文件新增 4~6 行，均对应输入来源、降级路径或调用方依赖。
