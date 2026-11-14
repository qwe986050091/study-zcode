# ZC-DEEP-svc-p0b：P0 安全边界 17 文件函数级复查（终版）

> 范围：`ZC-DEEP-svc-triage.md` A 档中的 P0 安全边界 17 文件。
> 本批只做函数级补深，不重报 A 档整体，也不改动 P1/P2 的 34 个文件。
> 口径：**内文率 = 函数体内部整行中文注释行 ÷ 函数体内部代码行**（`zc-inner.mjs`，AST trivia + 字符覆盖掩码）。

## 1. 方法

按「漏了会被怎样滥用」排序，只补三类读者会写错的信息：

1. **前置条件**：什么必须为真才能进来，本函数不校验什么。
2. **顺序约束**：这两步为什么不能换。
3. **失败后果**：漏了会静默放宽成什么。

纯转发、纯日志、空实现不硬填。已有注释已把三类说清的，不重写；全部改动走 `zc-verify --rewrite`，没有追加「更正行」。

## 2. 函数级内文率前后值（17 文件，终版）

| 文件 | 前 | 后 | 增量 |
| --- | ---: | ---: | ---: |
| `oauth/repo/oauthCredentialRepo.ts` | 109/346（31.50%） | 117/346（33.82%） | +2.31 |
| `official-mcp/officialMcpCredentials.ts` | 82/252（32.54%） | 87/252（34.52%） | +1.98 |
| `paths.ts` | 52/164（31.71%） | 60/164（36.59%） | +4.88 |
| `file/workspaceFileIgnore.ts` | 67/209（32.06%） | 77/209（36.84%） | +4.78 |
| `storage/adapters/fsCleaner.ts` | 31/96（32.29%） | 36/96（37.50%） | +5.21 |
| `runtime-tools/runtimeToolResolver.ts` | 42/121（34.71%） | 47/121（38.84%） | +4.13 |
| `model-provider/accountProviderCredentialKey.ts` | 8/22（36.36%） | 9/22（40.91%） | +4.55 |
| `bots/providers/weixinRegistration.ts` | 42/112（37.50%） | 47/112（41.96%） | +4.46 |
| `subagents/subagentStorage.ts` | 16/46（34.78%） | 20/46（43.48%） | +8.70 |
| `providers/api/apiKeyHeaders.ts` | 6/15（40.00%） | 7/15（46.67%） | +6.67 |
| `runtime-tools/appCaCert.ts` | 19/47（40.43%） | 22/47（46.81%） | +6.38 |
| `git/config.ts` | 21/59（35.59%） | 28/59（47.46%） | +11.86 |
| `model-provider/accountProviderCredentialStore.ts` | 12/29（41.38%） | 14/29（48.28%） | +6.90 |
| `plugin-sync/pluginSyncPath.ts` | 12/29（41.38%） | 14/29（48.28%） | +6.90 |
| `skill-sync/skillSyncPath.ts` | 12/29（41.38%） | 14/29（48.28%） | +6.90 |
| `runtime-tools/agentProxyEnv.ts` | 27/68（39.71%） | 33/68（48.53%） | +8.82 |
| `project-storage/remote-policy.ts` | 8/16（50.00%） | 8/16（50.00%） | 0（已够，未动） |
| **合计** | **566/1,660（34.10%）** | **640/1,660（38.55%）** | **+4.45** |

- 158 个函数：零注释 18 → 1，`<30%` 60 → 24，中位 36.36% → 43.48%，最低 31.50% → 33.82%。
- 唯一零注释函数是 `fsCleaner.ts` 的 `catch(() => {})`：空箭头体没有可放整行注释的位置；「忽略 rm 失败」的语义写在外层循环行。没有为百分比改代码结构。

## 3. 按四类优先补的内容

### 3.1 凭据比较与身份头

- `oauthCredentialRepo`：`setActiveProvider` 的 provider 白名单前置条件；`loadActiveUserProfile` 的先取 active 再读 profile；`loadTokenSet` 只把解密失败当损坏（IO/权限错误上抛）；`clearProvider` 必须最先删 access token；`clearUserProfile`/`loadUserProfile` 的 provider 一致性；`inferBase64ImageMimeType` 不信文件名与后端 MIME；`toOAuthUserProfileFromRawZaiUser` 把密文当不可信输入。
- `officialMcpCredentials`：`fail` 不携带上游响应；`createSelectionFingerprint` 不含 token 原文；`identityOnlyOutcome` 的前置快照一致性；`resolveSelectedPlan` 的身份一致性；`resolveOfficialMcpCredentials` 的 family → MaaS JWT 读取顺序。
- `apiKeyHeaders`：返回空串而不是抛错的降级语义。
- `accountProviderCredentialKey` / `accountProviderCredentialStore`：空值必须抛错，不能退化成默认值/空串导致 key 碰撞；空串与 null 折叠成一个值。
- `weixinRegistration`：`readString` 不 trim、`readNumber` 不接受字符串数字、`unwrapData` 只浅合并、baseUrl 去尾斜杠、poll 的 qrCode 前置条件。

### 3.2 路径穿越与破坏性操作

- `paths`：workspace key/hash 的输入一致性；taskId 原样拼文件名、调用方必须保证不含分隔符；`nativeConfigDir` 必须是相对段（否则 `join` 丢根）；feedback 目录不参与清理；`validateDataBaseDirTarget` 不在两处各做一套归一。
- `pluginSyncPath` / `skillSyncPath`：外部同步包是不可信输入、只拒绝不修正；targetRoot 的可信性由调用方保证；归一结果必须再经 `resolve` 校验。
- `fsCleaner`：`errorCode` 只返回稳定 code 不透出 message；prefix/scopes 只能来自常量表；`lstat` 不跟随符号链接；`deleteFiles` 的 targets 来源与越界反查依赖。
- `workspaceFileIgnore`：规则文本交给 ignore 包；只认 ENOENT；读取不落盘；降级只在内存；目录路径补尾斜杠；`relativePath` 必须已转 POSIX。
- `subagentStorage`：workspacePath 必须已校验；相对路径按 cwd 解析；config.json 是不可信输入；读取失败统一等价于无配置。
- `remote-policy`：已有两类断言与失败语义，未改。

### 3.3 子进程与执行环境

- `runtimeToolResolver`：`resolveCommandOnPath` 的 env 必须与 spawn 同源；随包目录的空值候选；prepend/append 对同名工具优先级的相反影响；`findRuntimeToolBinary` 的 env 同源前置条件。
- `agentProxyEnv`：代理只来自显式配置、空值不覆盖；CA 路径不 resolve；NO_PROXY 空 token 会被误判为匹配全部主机；identity 只对 remote 有值。
- `appCaCert`：路径随数据根变化不缓存；先成对检查再生成，半套文件覆盖重写；私钥覆盖的失败后果。
- `git/config`：候选顺序即优先级；`getGitCommandEnv` 返回完整快照、调用方不得再合并 `process.env`；`NUL` 不能 stat；`normalizeGitPath` 不折叠 `..`；`normalizeWorkspaceInRepoPath` 空串折成 `.`；`GIT_UNTRACKED_STAT_CHUNK_BYTES` 与并发数必须成对调整。

## 4. 注释复核：只复述代码/相邻注释的 7 处

对 158 个函数的内文注释做了一遍复核，重点看 `<40%` 的 74 个。命中 7 处，全部按改写模式处理，没有保留「更正行」：

| # | 函数 | 问题 | 处理 |
| ---: | --- | --- | --- |
| 1 | `oauthCredentialRepo.saveActiveTokenSet` | 注释写「写 user_info 前…」，实际写 token，且自引本函数名 | 改写为写 token 的前置条件与串号后果 |
| 2 | `oauthCredentialRepo.toOAuthUserProfileFromRawZaiUser` | 两句同义重复（「三者全空」/「三个展示来源全空」） | 合并为一句 |
| 3 | `oauthCredentialRepo.saveLoginAttribution` | 两句同义重复（全空早返回） | 合并为一句 |
| 4 | `paths.getWorkspaceHash` | 新增行复述相邻既有行（INV-04） | 删除重复行，保留原句 |
| 5 | `workspaceFileIgnore.buildBuiltinDefaultsSection` | 新增行复述「判重保守」 | 改写为只写漏规则的后果 |
| 6 | `officialMcpCredentials.readIdentitySnapshot` | 新增行与下方「只接受内置 family」重复 | 删除重复行 |
| 7 | `agentProxyEnv.buildAgentProxyEnv` | 新增行与下方「空值返回空补丁」重复 | 删除重复行 |

结论：1 处是**写错对象**（token 写成 user_info），6 处是**复述/重复**；没有发现「只翻译代码、三类信息全无」的函数。

## 5. 注水旧账清零

23 行 HEAD 之后、本批之前已有的模块头单行句，按一换一改写为带真实标识符与后果的句子（例如 `getZCodeDataRootDir`、`GIT_UNTRACKED_STAT_CONCURRENCY`、`EACCES`、`assertRemoteProjectRoots`）。首轮改写后仍有 4 行因「列举式」被 L 规则命中，补上谓词与后果后清零。

```text
node _annot_baseline/zc-gate.mjs --scan _annot_baseline/ZC-deep-svc-p0b/_files.txt
SUMMARY files=17 badFiles=0 addedCommentLines=863 waterLines=0 waterRate=0.00%
新行命中：0（W=0，L=0，B/POEM=0）
```

## 6. 验收

```text
node _annot_baseline/zc-verify.mjs --rewrite ZC-deep-svc-p0b
SUMMARY files=17 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

```text
node _annot_baseline/zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src \
  --threshold 100 --top 20 --fns 999 --only <17 文件> --out _annot_baseline/ZC-p0-funcs-after.json
SUMMARY files=17 innerCode=1660 innerZh=640 below100=17 min=33.82 median=43.48
```

```text
node _annot_baseline/zc-stringscan.mjs D:/code/ZCode
SUMMARY repo=ZCode files=9818 hits=96 new=0 inHead=96 untracked=0
```

## 7. 收口：剩余未做项及理由

| 项 | 状态 | 理由 |
| --- | --- | --- |
| P0 安全边界 17 文件 | 完成 | 每个函数至少一条三类说明；注水 0；代码 token 0 差异 |
| P1 持久化/崩溃窗口 17 文件 | 未做函数级补深 | 本批限定 P0；A 档已全部 ≥30%，函数级 <15% 为 0，按「不做平均抬」留待 P1 专项 |
| P2 协议/生命周期 17 文件 | 未做函数级补深 | 同上；协议语义已在 A 档文件级说明，密度未按 P0 标准复查 |
| `fsCleaner` 空箭头 `catch(() => {})` | 保留 0 行内注释 | 函数体为 `{}`，无整行注释插入点；语义由外层循环行承担，不为百分比改代码结构 |
| 24 个 `<30%` 的函数 | 不继续补 | 均有 ≥1 条前置/顺序/后果说明；低比例来自多行对象字面量与 JSON，继续加只会复述 |
| B 档 29 文件 | 已完成 | 按「写尽即止」验收，不设 15% 阈值 |
| C 档 34 文件 | 维持 0 行 | 契约/类型/常量/测试夹具，补注只会重复类型名 |

未执行 `git add` / `git commit`；未改动 P1/P2 文件与任何代码 token。
