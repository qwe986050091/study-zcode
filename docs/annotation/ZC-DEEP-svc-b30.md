# SVC-B30 深度注释索引（B 档「写尽即止」第 3 组 / 分诊 B3）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v2）与 `ZC-DEEP-svc-triage.md` §4。
> 范围：`packages/services/src` 下 9 个 B 档文件（B3 组）。
> 口径：内文率 = 函数体内部「整行中文注释行」÷ 函数体内部「代码行」（`zc-inner.mjs`）。
> 本档不设函数级 15% 目标，只解释「输入从哪来、异常怎么降级、调用方依赖什么」。

## 1. 结果

| 文件 | 代码行 | 内文率（HEAD→当前） | 新增 |
| --- | ---: | --- | ---: |
| `model-provider/accountProviderApiClient.ts` | 20 | 5.00% → 10.00% | 7 |
| `model-provider/providerSettingsConnectivity.ts` | 20 | 0.00% → 10.00% | 7 |
| `model-provider/accountProviderInvalidation.ts` | 15 | 6.67% → 6.67% | 2 |
| `feedback/compactLogArchive.ts` | 15 | 0.00% → 13.33% | 10 |
| `setting/observableSettingService.ts` | 18 | 0.00% → 0.00% | 4 |
| `official-mcp/officialMcpIssuanceAudit.ts` | 17 | 0.00% → 11.76% | 6 |
| `oauth/callbackAttribution.ts` | 13 | 0.00% → 0.00% | 6 |
| `client-scenes/clientScenesService.ts` | 8 | 0.00% → 0.00% | 5 |
| `bots/groupReply.ts` | 7 | 0.00% → 0.00% | 7 |
| **合计** | **133** | **1.50% → 6.77%** | **54** |

> 任务表给出的「前值」与本批落盘后的当前值一致（注释已在工作区生效、未提交），因此表中前值统一取 `HEAD:` 版本实测，便于看出本批增量。

## 2. 为何非关键（逐文件一句判据）

| 文件 | 判据 |
| --- | --- |
| `accountProviderApiClient.ts` | 单方法 HTTP 包装，业务失败一律降级 null，无状态、无持久化。 |
| `providerSettingsConnectivity.ts` | 只把已落盘配置转成连通性结论，异常折叠为 `success=false`，不消费流。 |
| `accountProviderInvalidation.ts` | 单向事件桥，白名单 key 触发刷新，不持有状态。 |
| `compactLogArchive.ts` | 打包编排，压缩与进度计算委托底层，删除尽力而为。 |
| `observableSettingService.ts` | 提交后通知包装，不新增持久化路径、不扩大 RPC 契约。 |
| `officialMcpIssuanceAudit.ts` | 进程内有界去重集合，不落盘、非安全审计依据。 |
| `callbackAttribution.ts` | 纯参数提取，无 IO、无状态，不参与鉴权。 |
| `clientScenesService.ts` | 一次只读 GET，无缓存、无重试、无响应加工。 |
| `groupReply.ts` | 锚点失效的有限降级纯函数，无 IO。 |

## 3. 命令原文与输出

快照：

```text
$root='D:/code/ZCode'; $batch='D:/code/_annot_baseline/ZC-deep-svc-b30'
# 9 个文件复制到 $batch/orig，文件清单写入 $batch/_files.txt
```

插入（本批 54 行已落盘；`spec.json` 为落盘后的锚点记录，带 `_applied` 标记，勿重复执行）：

```text
node d:\code\_annot_baseline\zc-insert.mjs d:\code\_annot_baseline\ZC-deep-svc-b30\spec.json
```

校验：

```text
node d:\code\_annot_baseline\zc-verify.mjs --rewrite ZC-deep-svc-b30
SUMMARY files=9 rewrittenSegments=8 deletedOwnCommentLines=9 codeTokenDiff=0 headTokenDrift=0
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

注水门禁（首轮 9 行 L/W，改写这 9 行自有注释后复测）：

```text
node d:\code\_annot_baseline\zc-gate.mjs --scan d:\code\_annot_baseline\ZC-deep-svc-b30\_files.txt
SUMMARY files=9 badFiles=0 addedCommentLines=54 waterLines=0 waterRate=0.00%
```

内文率（仅记录，不设阈值）：

```text
node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <9 文件> --threshold 15 --fns 0
SUMMARY files=9 innerCode=133 innerZh=9 below15=9 min=0.00 median=6.67
```

质量/填充率：

```text
node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files <9 文件> --quiet --top 20
SUMMARY files=9 units=114 coverage=18.4% branch=16.7% field=0.0% comments=72
        substance=77.8% explain=100.0% filler=0.0% weak=0.0%
```

## 4. 本批锚定的不变量

- `accountProviderApiClient`：`code` 为 `null/undefined`、`0`、`200`、`"0"`、`"200"` 都算成功；业务失败返回 `null`，网络/解析异常仍由 `readApiJson` 抛出。
- `providerSettingsConnectivity`：只复用正式执行链，不复制错误码映射表；对外永不抛出。
- `accountProviderInvalidation`：只有 `providerFamilyDomain` / `providerFamilyConnectionSelections` / `zcodeEndpointOrigin` 三个 key 触发刷新。
- `compactLogArchive`：默认分支必须有 2MiB 上限；`full` 分支只走注入实现；清理上跳一级且失败静默。
- `observableSettingService`：事件只在 `base.update` 成功后发布；空 patch 不发事件。
- `officialMcpIssuanceAudit`：容量钳制 ≥1，按 Map 插入顺序 FIFO 淘汰。
- `callbackAttribution`：先 `trim` 再判空，全空返回 `undefined`；只认 `channel_id` / `utm_source` / `utm_campaign`。
- `clientScenesService`：端点取自 `apiEndpoints` 常量，响应原样透传。
- `groupReply`：非话题只清 `replyToMessageId`；话题下 root 失效返回 `null`，禁止重试同一锚点。

## 5. 看似该改、其实不能改

- 不能把业务失败改成抛异常：调用方以 `null` 判空，改抛错会击穿设置页。
- 不能给 `fetchRemoteData` 加缓存：设置页改 Key 后需立刻命中新值。
- 不能把 `ACCOUNT_PROVIDER_SETTING_KEYS` 扩成前缀/通配匹配：会把无关设置变化变成账号重建。
- 不能给默认归档去掉 `maxTotalBytes` 或改成 `undefined` 显式传参：条件展开语义是「不存在」。
- 不能在 `observableSettingService.update` 里先发事件再 `await base.update`：会让监听者读到未落盘的值。
- 不能把 `officialMcpIssuanceAudit` 改成无界 Map 或落盘：前者内存随插件增长，后者变成持久化事实源。
- 不能在 `callbackAttribution` 里放宽为全参数透传：会污染统计口径并引入非白名单字段。
- 不能在 `clientScenesService` 里硬编码 URL、裁剪响应字段或自行加鉴权头。
- 不能在 `groupReply` 里对失效锚点重试，或把话题消息降级发到群主聊天。
