# ZC-DEEP-svc-a1 深度注释报告（凭据安全边界）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v2）
> 分诊计划：[ZC-DEEP-svc-triage.md](./ZC-DEEP-svc-triage.md) §3 P0 第 1~6 项与 P1 第 34 项。
> 范围：`packages/services/src` 下 7 个凭据 / 令牌 / schema 文件。
> 口径：**内文率** = 函数体内整行中文注释 ÷ 函数体内代码行（`zc-inner.mjs`，AST trivia）。
> 硬约束：不改代码 token、缩进、import、字符串；注释只允许新增，清理阶段只允许删除/改写本批新增的注释行；不 git add / commit。

## 1. 结果

| 文件 | 代码行 | 内文（前→后） | 内文率（前→后） | 新增 |
| --- | ---: | --- | --- | ---: |
| `oauth/repo/oauthCredentialRepo.ts` | 346 | 50 → 109 | 14.45% → 31.50% | 55 |
| `official-mcp/officialMcpCredentials.ts` | 252 | 21 → 82 | 8.33% → 32.54% | 61 |
| `bots/providers/weixinRegistration.ts` | 112 | 14 → 42 | 12.50% → 37.50% | 28 |
| `providers/api/apiKeyHeaders.ts` | 15 | 2 → 6 | 13.33% → 40.00% | 4 |
| `model-provider/accountProviderCredentialKey.ts` | 22 | 3 → 8 | 13.64% → 36.36% | 5 |
| `model-provider/accountProviderCredentialStore.ts` | 29 | 3 → 12 | 10.34% → 41.38% | 8 |
| `oauth/oauthProfileSchema.ts` | 97 | 13 → 37 | 13.40% → 38.14% | 23 |
| **合计** | **873** | **106 → 296** | **12.14% → 33.91%** | **184** |

文件级最低 31.50%，中位 37.50%；函数级最低 18.2%（`loadActiveUserProfile`），7 个文件全部满足「函数级 ≥15%、文件级 ≥30%」。

## 2. 补深方式

- 每个语句组、每个分支只解释四件事：在做什么、为什么必须这样、依赖什么前置条件、做错会出现什么现象。
- 注释贴住紧邻代码，不写文件级排比，不重复 JSDoc；同一事实只在一个位置说一次。
- 空 catch、三元回落、别名链、日志字段等「看起来简单」的位置同样写，但不为凑数拆行。

重点覆盖的故障面：

- `oauthCredentialRepo`：`oauth:*` key 命名契约、active provider 与 token 的两跳读取、解密错误的清理边界、头像 base64 往返校验。
- `officialMcpCredentials`：两轮防竞态、family 与套餐模式匹配、scope 头成对发送、日志去重键不含 token 原文。
- `weixinRegistration`：`ret`/`errcode` 双错误码、`scaned` 历史拼写、取消与超时同归过期、轮询超时只降级为 pending。
- `apiKeyHeaders`：先剥 `Bearer` 再截 ASCII 前缀，避免双前缀与换行注入。
- `accountProviderCredentialKey` / `Store`：key 分段编码、空值折叠为 `null` 与删除语义、读写同一校验口径。
- `oauthProfileSchema`：`rawProfile` 版本与 `retry-after` 互斥、401/403 终结迁移、暂时性失败持久化退避。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs --rewrite ZC-deep-svc-a1
SUMMARY files=7 rewrittenSegments=21 deletedOwnCommentLines=26 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

内文率复测：

```text
SUMMARY files=7 innerCode=873 innerZh=296 below15=0 min=31.50 median=37.50
```

注水率：

```text
SUMMARY files=7 units=642 coverage=46.7% branch=55.8% field=0.0% comments=559 substance=87.5% explain=99.6% filler=0.0% weak=0.4%
```

总密度回归（services，467 个生产文件）：

```text
SUMMARY files=467 coreBelow30=0 needLines=0 min=30.05 median=32.00 newComments=31079
FAIL: 34 error(s); see above (fail-closed)
```

34 个 error 全部是**基线快照缺失的测试文件**（`*.test.ts`），与本次改动无关；`coreBelow30=0`、`needLines=0` 成立。`headTokenDrift` 本批为 0。

## 4. 注水清理

A1 落盘后 `zc-gate --scan` 报 `waterLines=23 waterRate=5.16%`（`addedCommentLines=446`）。按「只删/改写相对 git HEAD 新增的注释行」清理：

- `oauthCredentialRepo.ts`：改写 INV-01 破坏后果、头像归一、仓储依赖边界三条；`{ params, expiresAt }` 四行近义块合并为一行（保留上游 HEAD 的「兼容本分支早期…」原句）；删除「过滤后为空则删除」「三个展示字段齐全才接受」两处与紧邻行重复的句子；删除损坏恢复边界处的 2 行同义重复。
- `weixinRegistration.ts`：改写轮询间隔、二维码别名表、baseurl 缺口、API 前缀、HTTP 出口五处列举句，把并列逗号拆成分句；删除 botId、expired 终态、ret/errcode 判定、状态别名、error 透传、pending 间隔六处重复行。
- `officialMcpCredentials.ts`：改写「可判别联合」「SelectedPlan 中间态」两处无信息列举句。
- `oauthProfileSchema.ts`：改写 `rawProfile` 版本、哨兵值说明、`retry-after` 标记三处列举句，并把与上一行重复的半句并入上一行。
- `accountProviderCredentialStore.ts`：删除与函数体内注释重复的「保存前规范化」与「Token 清洗」各 1 行。

前后对照：

```text
清理前：SUMMARY files=7 badFiles=5 addedCommentLines=446 waterLines=23 waterRate=5.16%
清理后：SUMMARY files=7 badFiles=0 addedCommentLines=429 waterLines=0 waterRate=0.00%
```

`--rewrite` 摘要：`rewrittenSegments=21 deletedOwnCommentLines=26`，`codeTokenDiff` / `codeDeletion` / `upstreamCommentDeleted` / `nonCommentAdded` / `starSlash` / `syntaxErrorFiles` 全为 0。

## 5. 锚定的不变量

- `oauth:*` 三个 key 的拼接函数是唯一命名入口；改名等于已存密文全部失配。
- active provider 是互斥域的唯一事实源；写 token / user_info 前必须重新读取，不得由调用方传入。
- 解密失败才清理会话，IO / 权限错误必须上抛；否则一次磁盘故障会把用户登出。
- 共享 JWT 只在内置 provider（`zai` / `bigmodel`）下读写，自定义 provider 读到它会串身份。
- MCP 头中的 scope 三元组必须同进同出；两轮解析之间不允许新鲜度混用。
- `retry-after` 与版本号互斥；写版本号时必须删除 `retry-after`。

## 6. 看似该改、其实不能改

- 不把 `delete` 改成写空串：读取侧会把空串当成合法 provider id。
- 不在 `inferBase64ImageMimeType` 里对未知格式抛错：头像失败只应降级为占位图。
- 不把 `scaned` 从同义集合删掉：它是服务端真实出现过的拼写，删掉会让轮询永远停在 pending。
- 不把两轮解析改成一轮：MaaS JWT 与身份必须来自同一代，否则会拼出跨轮的凭证。
- 不合并 `getCachedProfileSchemaVersion` 与 `getCachedProfileMigrationRetryAfter`：一个判断迁移是否完成，一个判断是否仍在退避期。
