# ZC-DEEP-SVC-A3（子进程与执行环境，4 文件 / 86 行）

> 基线：`d:\code\_annot_baseline\ZC-deep-svc-a3\orig`（改写前工作树）。
> 范围：`packages/services/src/runtime-tools/{runtimeToolResolver,agentProxyEnv,appCaCert}.ts` 与 `packages/services/src/git/config.ts`。
> 约束：只新增整行中文 `//` 注释，未改动任何代码 token（`deletedNonZero=0`、`nonCommentAdded=0`）。

## 1. 结果表

| 文件 | 代码行（函数体内） | 内文前 → 后 | 新增行 |
| --- | ---: | --- | ---: |
| `runtime-tools/runtimeToolResolver.ts` | 121 | 10.74% → 34.71% | 29 |
| `runtime-tools/agentProxyEnv.ts` | 68 | 7.35% → 39.71% | 22 |
| `runtime-tools/appCaCert.ts` | 47 | 4.26% → 40.43% | 17 |
| `git/config.ts` | 59 | 5.08% → 35.59% | 18 |
| **合计** | **295** | **7.80%（23/295）→ 36.95%（109/295）** | **86** |

最低函数（`zc-inner --fns 30` 明细）：`toWorkspaceRelativeGitPath` 23.1%（3/13），`isExecutableFile` 25.0%（2/8），`buildAgentNoProxyEnv` 27.3%（3/11）。全部函数 ≥15%，全部文件 ≥30%。

## 2. 补深方式（按故障面）

- **可执行文件解析（runtimeToolResolver）**：写清 `constants.X_OK` 与 `F_OK` 的差别（目录会被 `existsSync` 放行、失败点后移到 `spawn` 的 `EACCES`）；`resolveExistingPath` 的「存在 + 可执行」短路与数组顺序即 `INV-01`；`PATHEXT` 缺失回退 `.EXE/.CMD/.BAT/.COM` 与裸命令名、自带扩展名不二次补全；空 `PATH` 条目在 POSIX 等价 cwd 的劫持风险；`bundle-tools/<platform>-<arch>` 五种相对根与 `moduleDir` 为 `null` 时不得进 `join`；`buildRuntimeToolEnvPatch` 只产出补丁、`appendPathEntries` 而非 prepend 的遮蔽语义。
- **代理与 CA 注入（agentProxyEnv）**：`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/ZCODE_HTTP_PROXY` 四键同值的原因、`NO_PROXY` 与 `no_proxy` 两键必须都写；空值返回 `{}` 表示「保留继承的 shell 变量」而不是清空；`...proxyEnv` 展开顺序即覆盖顺序、CA 组最后展开；裸 `host:port` 补 `http://`、已带 scheme 不重复加；`NODE_EXTRA_CA_CERTS` 与 `ZCODE_AGENT_CA_CERT` 双写边界；`ZCODE_BASE_URL` 压过继承的 `ZCODE_ENDPOINT_ORIGIN`。
- **自签 CA（appCaCert）**：`certs/` 目录与文件名固定（改名等同换 CA、已信任 `agent` 失效）；证书与私钥必须成对才复用，半写状态重生成；`0600` 在 `writeFileSync` 创建时生效；`cA=true` 与 `keyCertSign` 必须 critical、`SHA-256` 不可降级；过期后 `agent` 握手直接失败。
- **git 子进程（config）**：`ZCODE_GIT_BINARY` > `git` > `ProgramW6432`/`ProgramFiles(x86)` 的候选顺序；只删枚举的 `GIT_LOCAL_ENV_VARS` 而不按 `GIT_` 前缀匹配（避免误删 `GIT_TERMINAL_PROMPT`）；先删 local env 再叠加 `GIT_OPTIONAL_LOCKS/GIT_PAGER/LC_ALL`，否则会被同名键复活并「串仓」；`NUL` 与 `/dev/null` 的平台差异；`normalizeGitPath` 不折叠 `.`/`..`；`startsWith(`${workspace}/`)` 防 `foo` 误匹配 `foobar`。

## 3. 校验原文

`node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-a3`：

```text
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=86
```

`node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only ... --threshold 15 --fns 30`：

```text
SUMMARY files=4 innerCode=295 innerZh=109 below15=0 min=34.71 median=39.71

低于 15% 的文件（innerZh/innerCode）：

最差的 4 个文件（含函数明细前 3）：
34.71%	42/121	packages/services/src/runtime-tools/runtimeToolResolver.ts
	  isExecutableFile@18  25.0% 2/8
	  resolvePlatformScopedBundledToolRoots@96  30.0% 3/10
	  findRuntimeToolBinary@158  34.5% 10/29
	  resolveCommandOnPath@52  34.6% 9/26
	  resolveExistingPath@32  36.4% 4/11
	  buildRuntimeToolEnvPatch@207  41.2% 7/17
	  joinUniquePathEntries@133  41.7% 5/12
35.59%	21/59	packages/services/src/git/config.ts
	  toWorkspaceRelativeGitPath@161  23.1% 3/13
	  normalizeWorkspaceInRepoPath@124  33.3% 2/6
	  isPathInWorkspaceScope@139  40.0% 4/10
	  getGitCommandEnv@83  41.2% 7/17
	  getGitBinaryCandidates@70  42.9% 3/7
39.71%	27/68	packages/services/src/runtime-tools/agentProxyEnv.ts
	  buildAgentNoProxyEnv@59  27.3% 3/11
	  buildAgentProxyEnv@28  36.4% 4/11
	  buildAgentRuntimeEnv@82  37.5% 3/8
	  buildAgentCaCertEnv@44  40.0% 4/10
	  normalizeProxyValue@139  40.0% 4/10
	  normalizeNoProxyValue@154  42.9% 3/7
	  buildAgentEndpointOriginEnv@117  57.1% 4/7
40.43%	19/47	packages/services/src/runtime-tools/appCaCert.ts
	  generateSelfSignedCa@64  37.9% 11/29
	  getAppCaCertPaths@28  42.9% 3/7
	  ensureAppCaCert@45  45.5% 5/11
```

`node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files ... --quiet --top 20`：

```text
SUMMARY files=4 units=213 coverage=54.5% branch=63.3% field=66.7% comments=226 substance=81.0% explain=100.0% filler=0.0%
```

## 4. 锚定的不变量

- `INV-01`：候选优先级固定为显式 env > `ZCODE_SERVER_RUNTIME_ROOT` / `resourcesPath` > bundled-tools 相对根 > PATH，顺序不可调换。
- `INV-02`：候选项必须同时通过 `existsSync` 与 `X_OK`，只判存在即把目录当工具。
- `INV-03`：env 补丁只追加不删除，PATH 先去空段再去重、保留首次出现位置。
- appCaCert：证书与私钥成对存在才复用（`INV`），绝不混用旧私钥签新证书。
- agent env：只注入设置页显式值；空值 = 保留继承，不是清空；同一事实只写一次。
- git：命令只依赖显式 cwd，local `GIT_*` 必须清空后再叠加 ZCode 约束变量。

## 5. 看似该改其实不能改

- 不调整 `findRuntimeToolBinary` 的候选数组顺序（等于改部署行为）。
- 不把 `isExecutableFile` 简化成 `existsSync`，也不改成 `F_OK`。
- 不在 `resolveExistingPath` 里 `realpath` 归一返回路径（日志会与实际执行位置不一致）。
- 不让 `resolveCommandOnPath` 支持空 `PATH` 条目（POSIX cwd 劫持）。
- 不把 `appendPathEntries` 改成 prepend（会让随包版本顶掉用户显式安装）。
- 不在 `joinUniquePathEntries` 里排序或大小写归一（`/Bin` 与 `/bin` 是不同目录）。
- 不让 `buildRuntimeToolEnvPatch` 返回完整 env（会泄漏宿主临时变量）。
- 不把 `NO_PROXY` 与 `no_proxy` 合并成一键，也不在空值分支写空串。
- 不对 `caCertPath` 做 `resolve`（host 与 agent 必须看到同一字面量）。
- 不合并 `ZCODE_BASE_URL` 与 `ZCODE_ENDPOINT_ORIGIN`；本地 workspace 不写空 identity。
- 不让 `ensureAppCaCert` 单文件复用、不改 `zcode-network-ca.pem` 文件名、不放宽 `0o600`。
- 不删除 `basicConstraints.cA`/`keyUsage.keyCertSign` 的 `critical`，不降级到 `SHA-1`。
- 不把 `GIT_LOCAL_ENV_VARS` 改成 `GIT_*` 前缀过滤，不直接改 `process.env`。
- 不在 `normalizeGitPath` 折叠 `.`/`..`，不把工作区判断改成裸 `startsWith(workspace)`。
