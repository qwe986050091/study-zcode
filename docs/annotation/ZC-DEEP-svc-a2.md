# ZC-DEEP-svc-a2 深度注释报告（路径校验与破坏性操作）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v2）
> 分诊计划：[ZC-DEEP-svc-triage.md](./ZC-DEEP-svc-triage.md) §3 A 档第 2 项。
> 范围：`packages/services/src` 下 7 个路径安全 / 清理 / 远端约束文件。
> 口径：**内文率** = 函数体内整行中文注释 ÷ 函数体内代码行（`zc-inner.mjs`，AST trivia）。
> 硬约束：只新增整行 `//` 中文注释；不改代码 token、缩进、import、字符串；不 git add / commit。

## 1. 结果

| 文件 | 代码行 | 内文（前→后） | 内文率（前→后） | 新增 |
| --- | ---: | --- | --- | ---: |
| `paths.ts` | 164 | 20 → 52 | 12.20% → 31.71% | 32 |
| `plugin-sync/pluginSyncPath.ts` | 29 | 4 → 12 | 13.79% → 41.38% | 8 |
| `skill-sync/skillSyncPath.ts` | 29 | 4 → 12 | 13.79% → 41.38% | 8 |
| `storage/adapters/fsCleaner.ts` | 96 | 14 → 31 | 14.58% → 32.29% | 17 |
| `file/workspaceFileIgnore.ts` | 209 | 16 → 67 | 7.66% → 32.06% | 51 |
| `project-storage/remote-policy.ts` | 16 | 2 → 8 | 12.50% → 50.00% | 6 |
| `subagents/subagentStorage.ts` | 46 | 0 → 16 | 0.00% → 34.78% | 16 |
| **合计** | **589** | **60 → 198** | **10.19% → 33.62%** | **138** |

文件级最低 31.71%（`paths.ts`），中位 34.78%；函数级最低 16.7%（`getWorkspaceHash` 1/6、`readUserCliConfig` 2/12）。7 个文件全部满足「函数级 ≥15%、文件级 ≥30%」。

## 2. 补深方式

- 每个语句组、每个分支只解释四件事：在做什么、为什么必须这样、依赖什么前置条件、做错会出现什么现象。
- 注释贴住紧邻代码，不重复文件头 JSDoc 与上方已有的「[权衡]」段；同一事实只在一个位置说一次。
- 空 catch、三元回落、单行 getter、注释掉的自动创建块同样写，但不为凑数拆行。

本批覆盖的故障面：

- `paths`：`win32.normalize → resolve → 去尾分隔符 → toLowerCase` 的比较键顺序；`readEnvValue` 的精确匹配与大小写回退；五个安装目录候选的来源与去重；`copyDataDirectory` 的 `force:false` 与 `setting.json*` 过滤边界。
- `pluginSyncPath` / `skillSyncPath`：盘符相对路径（`C:foo`）、POSIX 绝对路径、`..` 段、跨盘符 `relative` 返回绝对路径、根目录本身写入。
- `fsCleaner`：枚举只读元数据、删除只删普通文件、`join` 之后才做越界反查、`force:false` 让并发删除记为失败、固定 8 worker、空目录自底向上收敛。
- `workspaceFileIgnore`：双标记精确匹配与反向区间拒绝、默认段去重口径、原子写的 `wx` + `sync` + 同目录 rename、三条降级路径与 `source` 标记、目录判定必须补尾斜杠。
- `remote-policy`：豁免只看持库宿主、远端正单根、根不可变、cwd 必须等于唯一根、附加目录一律拒绝。
- `subagentStorage`：home 三级回落、`~/` 单前缀展开、相对路径按 cwd 解析、配置损坏等价于无配置。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-a2
SUMMARY files=7 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=138
```

内文率复测：

```text
node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only packages/services/src/paths.ts,packages/services/src/plugin-sync/pluginSyncPath.ts,packages/services/src/skill-sync/skillSyncPath.ts,packages/services/src/storage/adapters/fsCleaner.ts,packages/services/src/file/workspaceFileIgnore.ts,packages/services/src/project-storage/remote-policy.ts,packages/services/src/subagents/subagentStorage.ts --threshold 15 --fns 30
SUMMARY files=7 innerCode=589 innerZh=198 below15=0 min=31.71 median=34.78

低于 15% 的文件（innerZh/innerCode）：

最差的 7 个文件（含函数明细前 3）：
31.71%	52/164	packages/services/src/paths.ts
	  getWorkspaceHash@255  16.7% 1/6
	  getProviderWorkspaceConfigDir@291  20.0% 1/5
	  collectWindowsForbiddenAppInstallDirs@144  25.9% 7/27
32.06%	67/209	packages/services/src/file/workspaceFileIgnore.ts
	  <anonymous>@326  19.2% 5/26
	  readOptionalFile@264  20.0% 2/10
	  isWorkspaceFileSearchPathIgnored@420  20.0% 1/5
32.29%	31/96	packages/services/src/storage/adapters/fsCleaner.ts
	  errorCode@20  20.0% 1/5
	  <anonymous>@136  21.1% 4/19
	  listRecursive@64  22.2% 2/9
34.78%	16/46	packages/services/src/subagents/subagentStorage.ts
	  readUserCliConfig@80  16.7% 2/12
	  resolveConfigPath@68  33.3% 2/6
	  resolveUserHomeDir@19  42.9% 3/7
41.38%	12/29	packages/services/src/plugin-sync/pluginSyncPath.ts
	  normalizePluginSyncRelativePath@17  35.7% 5/14
	  resolvePluginSyncPathWithin@43  46.7% 7/15
41.38%	12/29	packages/services/src/skill-sync/skillSyncPath.ts
	  normalizeSkillSyncRelativePath@17  35.7% 5/14
	  resolveSkillSyncPathWithin@43  46.7% 7/15
50.00%	8/16	packages/services/src/project-storage/remote-policy.ts
	  assertRemoteProjectRoots@12  50.0% 3/6
	  assertRemoteTaskDirectories@28  50.0% 5/10
```

注水率：

```text
node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files packages/services/src/paths.ts,packages/services/src/plugin-sync/pluginSyncPath.ts,packages/services/src/skill-sync/skillSyncPath.ts,packages/services/src/storage/adapters/fsCleaner.ts,packages/services/src/file/workspaceFileIgnore.ts,packages/services/src/project-storage/remote-policy.ts,packages/services/src/subagents/subagentStorage.ts --quiet --top 20
SUMMARY files=7 units=390 coverage=50.3% branch=56.5% field=50.0% comments=384 substance=72.4% explain=100.0% filler=0.0%
```

## 4. 锚定的不变量

- `paths`：安装目录比较键必须 `win32.resolve` + 去尾分隔符 + 小写，且目录包含判定保留 `=== root` 分支（INV-03）。
- `paths`：`getWorkspaceHash` 的输入只由 `getWorkspaceKey` 决定，换分隔符或加盐会让已落盘 sessions 目录失联（INV-04）。
- `paths`：迁移只复制 `.zcode/v2`，并排除 `setting.json` 与 `setting.json.*` 原子写中间态。
- `pluginSyncPath` / `skillSyncPath`：拒绝绝对路径、盘符前缀、反斜杠写法与任意 `..` 段；拼接结果必须严格位于根目录之下（不含根本身）。
- `fsCleaner`：枚举阶段只读元数据且不跟随符号链接；删除阶段只删普通文件，目录只由 `pruneEmptyParents` 在删除成功后收敛；`keepDirectories` 永不进入删除候选。
- `fsCleaner`：`freedBytes` 来自枚举快照，是估算值；`deletedCount` 只统计真正 `rm` 成功的项。
- `workspaceFileIgnore`：`.zcodeignore` 是搜索规则的单一真相源；双标记缺失或顺序颠倒时退化为整体重建，不再做局部拼接。
- `workspaceFileIgnore`：规则解析完全交给 `ignore` 包，本仓库不手写 gitignore 解析。
- `remote-policy`：豁免只依据持库宿主 `ownerHostId`；远端项目单根、根不可变、cwd 必须等于唯一根。
- `subagentStorage`：存储根优先级为 `storage.dir` → `~/.zcode`；工作区级 agent 目录固定在 `workspacePath/.zcode/agents`，不受配置影响。

## 5. 看似该改、其实不能改

- 不把 `path.includes("\\")` 换成只看 `normalized`：`normalized` 已把反斜杠替换成正斜杠，等于没检查。
- 不在 `normalizeWindowsComparablePath` 去掉 `win32.resolve`：不展开 `..` 就能用 `ProgramFiles\ZCode\..\ZCode` 绕过安装目录判定。
- 不把 `normalizedPath === normalizedRoot` 合并进 `startsWith`：目标恰好等于安装目录时 `startsWith` 返回 false，会漏掉最危险的配置。
- 不把 `collectWindowsForbiddenAppInstallDirs` 的候选压成常量数组：`ProgramFiles(x86)`、`ProgramW6432`、`LOCALAPPDATA` 在 32/64 位进程与 per-user 安装下取值不同。
- 不给 `deleteFiles` 的 `rm` 加 `force: true`：那会把「文件已被并发删除」吞成成功，`deleted` 列表与 `pruneEmptyParents` 的判断都会失真。
- 不把 `DELETE_CONCURRENCY` 改成 `Promise.all` 全量并发：Windows 上大量并行 unlink 会放大句柄与杀软扫描抖动。
- 不在 `listShallow` 改用 `readdir({ withFileTypes: true })`：拿不到 `size` 与 `mtimeMs`，`freedBytes` 就无从统计。
- 不把 `splitWorkspaceFileSearchIgnoreSections` 的 `defaultsIndex <= syncIndex` 删掉：反向 `slice` 会让默认段与自定义段互换内容。
- 不在 `atomicWriteIgnoreFile` 去掉 `handle.sync()` 或改用跨目录临时文件：前者会留下空文件，后者让 rename 失去原子性。
- 不把 `transformWorkspaceFileSearchIgnore` 的读取失败改成抛出：设置页只是生成预览内容，失败应退回模板。
- 不在 `remote-policy` 改用请求里的 `hostId` 判豁免：客户端可自称 `local` 绕过全部远端约束。
- 不把 `resolveConfigPath` 简化成直接返回 `storageDir`：相对路径会随进程 cwd 漂移，跨进程比较失效。
- 不合并 `pluginSyncPath` 与 `skillSyncPath` 的实现：两条同步链路的安全策略需各自演进（文件头已声明）。
