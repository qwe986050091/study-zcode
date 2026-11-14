# ZC-DEEP-svc-b5：`conversation-share/**`、`settings-sync/**`、`model-provider/**` 深度注释索引

> 范围：`packages/services/src/` 下三个目录的 42 个生产文件（`*.test/spec`、`test-fixture.ts` 不在范围内）。
> 基线：`d:\code\_annot_baseline\ZC-deep-svc-b5\orig\`，清单 `_files.txt`（42 项）。
> 硬约束：只新增整行 `//` 注释；`deletedNonZero=0`；`nonCommentAdded=0`；`starSlash=0`；`syntaxErrorFiles=0`；不做 git 提交。
> 行尾：源码为 CRLF；所有插入经 `_ins.mjs` 以 `\r\n` 回拼，`git diff --no-index --numstat` 删除列全为 0。
> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（文件头 INV 表 + 关键分支 `[并发]/[事务]/[资源]/[失败路径]/[权衡]`）。

## 结果

| 文件 | 基线注释/代码 | 完成后注释/代码 | 新增 | 验收 |
| --- | ---: | ---: | ---: | --- |
| `conversation-share/conversationShareService.ts` | 166 / 2,324 | 716 / 2,324 = **30.81%** | +550 | PASS |
| `conversation-share/conversationSharePublicProjection.ts` | 16 / 761 | 231 / 761 = **30.35%** | +215 | PASS |
| `conversation-share/conversationShareArtifactDiscovery.ts` | 18 / 687 | 212 / 687 = **30.86%** | +194 | PASS |
| `conversation-share/conversationShareHttpClient.ts` | 30 / 524 | 159 / 524 = **30.34%** | +129 | PASS |
| `conversation-share/conversationShareWorkflowSnapshot.ts` | 9 / 425 | 131 / 425 = **30.82%** | +122 | PASS |
| `conversation-share/conversationShare.ts` | 44 / 421 | 134 / 421 = **31.83%** | +90 | PASS |
| `conversation-share/conversationShareArtifactSource.ts` | 16 / 297 | 91 / 297 = **30.64%** | +75 | PASS |
| `conversation-share/conversationShareConnectionScope.ts` | 3 / 134 | 41 / 134 = **30.60%** | +38 | PASS |
| `conversation-share/conversationShareInlineImages.ts` | 3 / 123 | 39 / 123 = **31.71%** | +36 | PASS |
| `conversation-share/sharedContextFormatter.ts` | 3 / 114 | 37 / 114 = **32.46%** | +34 | PASS |
| `conversation-share/conversationShareIntegrity.ts` | 23 / 123 | 41 / 123 = **33.33%** | +18 | PASS |
| `settings-sync/settingsSyncService.ts` | 13 / 2,214 | 667 / 2,214 = **30.13%** | +654 | PASS |
| `settings-sync/settingsSync.ts` | 0 / 39 | 13 / 39 = **33.33%** | +13 | PASS |
| `settings-sync/types.ts` | 0 / 28 | 11 / 28 = **39.29%** | +11 | PASS |
| `model-provider/legacyZCodeConfigProviderReader.ts` | 31 / 907 | 280 / 907 = **30.87%** | +249 | PASS |
| `model-provider/legacyModelProviderSerialized.ts` | 46 / 741 | 229 / 741 = **30.90%** | +183 | PASS |
| `model-provider/codingPlanProviderAvailability.ts` | 25 / 494 | 153 / 494 = **30.97%** | +128 | PASS |
| `model-provider/providerProvisioningTarget.ts` | 15 / 358 | 108 / 358 = **30.17%** | +93 | PASS |
| `model-provider/providerFacadeServices.ts` | 6 / 252 | 77 / 252 = **30.56%** | +71 | PASS |
| `model-provider/accountProviderConnectionResolver.ts` | 39 / 304 | 94 / 304 = **30.92%** | +55 | PASS |
| `model-provider/providerRuntime.ts` | 10 / 200 | 62 / 200 = **31.00%** | +52 | PASS |
| `model-provider/zaiStartPlanBilling.ts` | 7 / 167 | 51 / 167 = **30.54%** | +44 | PASS |
| `model-provider/providerProvisioningSource.ts` | 9 / 157 | 50 / 157 = **31.85%** | +41 | PASS |
| `model-provider/legacyPersonalProviderConfigImporter.ts` | 12 / 123 | 41 / 123 = **33.33%** | +29 | PASS |
| `model-provider/providerConfigRuntime.ts` | 4 / 75 | 23 / 75 = **30.67%** | +19 | PASS |
| `model-provider/legacyTeamOrganizationResolver.ts` | 3 / 46 | 14 / 46 = **30.43%** | +11 | PASS |
| `model-provider/providerSettingsConnectivity.ts` | 4 / 36 | 11 / 36 = **30.56%** | +7 | PASS |
| `model-provider/providerProvisioning.ts` | 1 / 10 | 5 / 10 = **50.00%** | +4 | PASS |
| `model-provider/accountProviderRequestAuthService.ts` | 3 / 147 | 47 / 147 = **31.97%** | +44 | PASS |
| `model-provider/accountProviderApiKeyResolver.ts` | 1 / 88 | 28 / 88 = **31.82%** | +27 | PASS |
| `model-provider/accountProviderTeamPlanRequestKey.ts` | 1 / 82 | 26 / 82 = **31.71%** | +25 | PASS |
| `model-provider/accountProviderCredentialService.ts` | 2 / 68 | 22 / 68 = **32.35%** | +20 | PASS |
| `model-provider/accountProjectTokenClient.ts` | 2 / 54 | 17 / 54 = **31.48%** | +15 | PASS |
| `model-provider/accountProviderApiTypes.ts` | 0 / 30 | 10 / 30 = **33.33%** | +10 | PASS |
| `model-provider/accountProviderCredentialStore.ts` | 5 / 40 | 13 / 40 = **32.50%** | +8 | PASS |
| `model-provider/accountProviderApiClient.ts` | 1 / 25 | 8 / 25 = **32.00%** | +7 | PASS |
| `model-provider/zcodeBuiltinRemoteConfig.ts` | 1 / 20 | 7 / 20 = **35.00%** | +6 | PASS |
| `model-provider/offPeakModelSelectionView.ts` | 1 / 17 | 6 / 17 = **35.29%** | +5 | PASS |
| `model-provider/accountProviderCredentialKey.ts` | 6 / 34 | 11 / 34 = **32.35%** | +5 | PASS |
| `model-provider/accountRequestAuthService.ts` | 6 / 33 | 11 / 33 = **33.33%** | +5 | PASS |
| `model-provider/bigmodelStartPlanZcodeJwt.ts` | 3 / 20 | 7 / 20 = **35.00%** | +4 | PASS |
| `model-provider/accountProviderInvalidation.ts` | 7 / 29 | 9 / 29 = **31.03%** | +2 | PASS |
| **合计** | 603 / 12,771 = 4.72% | 3,951 / 12,771 = **30.94%** | **+3,348** | — |

> 小文件（10~20 行代码）因粒度下限落在 35%~50%：再减 1 行就会跌破 30%，
> 不是刻意冲高；`providerProvisioning.ts` 从 30.00% 补到 50.00%（+2 行）以避免贴线。

## 分段明细

| 段 | 文件 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| seg1 | `settings-sync/*` 3 个 | 四类资源（skills/commands/plugins/MCP）扫描表 → 候选 → 跳过判定 → 写入状态机；目标目录与 source 的只读边界；Windows junction/硬链接/复制回退；config.json 读全量再合并；`file#server` 唯一键 | +678 |
| seg2 | `conversation-share/*` 11 个 | 分享会话的预检（preflight）/发布（publish）/确认（confirmUntilReady）三段式；公开投影的字段白名单与脱敏；附件发现与上传顺序；HTTP 客户端的幂等与重试；完整性校验的失败分类；内联图片的尺寸/体积边界；共享上下文的格式化口径 | +1,501 |
| seg3 | `model-provider` 大文件 14 个 | v1/v2 序列化契约与 tombstone；旧 `config.json` 多代结构优先级与 `preferOpenCodeFields`；Coding Plan 权益状态机（available/pending/unavailable/unknown 与 401/403）；Provisioning 的 `syncId` 幂等与逐域 CAS 回滚；`zai` 余额查询的 in-flight 合并与保留窗口；Facade 三重连通性门与 ModelSelection revision 单调性 | +984 |
| seg4 | `model-provider` 小文件 14 个 | account 体系的凭据 key 编码、Project Token 换证的信封/瞬时错误三态、pending 合并键与清理时序、跨 await 的登录态复核、失效标记；内置远端配置与首启模型选择视图 | +183 |
| seg5 | `model-provider/providerProvisioning.ts` | 契约描述符与接口同名约定；补厚贴线文件 | +2 |
| **合计** | — | — | **+3,348** |

## 校验输出原文

```text
SUMMARY files=42 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=3348
```

```text
SUMMARY files=42 coreBelow30=0 needLines=0 min=30.13 median=31.59 newComments=3348
PASS: all 42 file(s) >= 30% (mode=code)
```

全目录重测（`packages/services/src`，467 个生产文件，已用 `--exclude` 排除 `*.test.*` / `*.spec.*` / `test-fixture.ts`）：

```text
SUMMARY files=467 coreBelow30=300 needLines=12731 min=0.00 median=10.34 newComments=16312
```

相对 b4 收口：`coreBelow30 342 → 300`（本批 42 个文件全部达标）、
`needLines 15,989 → 12,731`（−3,258，等于本批文件原始缺口之和）、
`median 7.14% → 10.34%`、累计 `newComments 12,964 → 16,312`（+3,348）。

## 本批重点不变量

1. **源目录只读**（`settingsSyncService.ts`）：只读取外部 Agent 的目录与配置，写入目标永远是 `~/.zcode` 或 `<ws>/.zcode`；写错方向会污染用户的 Claude/Codex 配置。
2. **扫描路径只由表决定**：`SUPPORTED_*_AGENT_SOURCES` 是唯一真相；新增 Agent 只改表，否则 detect 与 import 会看到不同集合。
3. **detect 与 import 共用判定**：`collect*Candidates` + `get*SkipReason` 两处复用，任何一处单独实现都会让「可导入数」与实际结果不一致。
4. **目标存在一律跳过**：`targetExists` / `sameNameExists` 优先于覆盖；静默覆盖会丢掉用户手工修改且不可见。
5. **symlink 平台差异**：Windows 目录用 junction、命令文件用硬链接（免提权）；硬链接跨分区失败回退复制，不能中断整批。
6. **单个候选失败不中断**：失败只累加 `failedCount` 并写一条结果，避免用户重试时面对半套结果。
7. **config.json 合并式写入**：保留未知字段，只覆盖目标 server/dir；同名覆盖仅用于兜并发。
8. **分享发布的三段式**（`conversationShareService.ts`）：preflight 只校验不写、publish 落远端、confirm 轮询到终态；任一段失败都保留可重试的中间态，禁止把 confirm 失败当成发布成功。
9. **公开投影白名单**（`conversationSharePublicProjection.ts`）：对外字段必须显式列举，禁止整对象透传；新增内部字段不会自动外泄。
10. **附件发现顺序即清单顺序**（`conversationShareArtifactDiscovery.ts`）：排序不稳定会让同一会话两次分享产生不同 manifest，导致远端去重失效。
11. **余额查询 in-flight 合并**（`zaiStartPlanBilling.ts`）：同一 provider 的并发查询共享一次请求，并保留短窗口；取消失败的请求不得写入负缓存。
12. **Provisioning 幂等**（`providerProvisioningTarget.ts`）：`syncId` 相同即视为同一批；逐域 CAS 的提交顺序就是回滚的逆序，不能任意重排。

## “看起来该改其实不能改”的点

1. `settingsSyncService.ts` 对不可读目录/损坏 manifest 一律静默跳过，看似吞错；设置页是旁路功能，单个坏文件不应让整次扫描失败，用户仍能看到其余可导入项。
2. `settingsSyncService.ts` 的 `collectCommandMarkdownPaths` 自己实现遍历而不复用技能遍历，看似重复；命令允许任意深度且要跳过 `.git` 等点目录，复用会让语义混淆。
3. `settingsSyncService.ts` 的插件 id 固定为 `name@inline`，看似丢失来源信息；去重只关心「同一插件」，把路径拼进 id 会让同一插件换个目录就重复导入。
4. `settingsSyncService.ts` 的 `pathExists` 用 `lstat` 不跟随软链，看似会误判断链；断链目标应视为「已占用」，否则会在断链上重复建链并报错。
5. `settingsSyncService.ts` 的复制失败不做半成品清理，看似留下垃圾；路径由外部输入拼接，递归删除有误删风险，交给结果里的路径让用户处理更安全。
6. `settingsSyncService.ts` 不缓存磁盘结果，看似每次设置页打开都全盘扫描；外部 Agent 目录可能在两次调用之间变化，缓存会让用户「刚装的资源看不见」。
7. `conversationShareService.ts` 的 preflight 与 publish 有大量重复分支，看似应抽公共函数；两段对「失败后是否可重试」的处理不同，强行合并会把重试语义抹平。
8. `conversationShareService.ts` 的 `confirmUntilReady` 轮询到上限才判失败，看似应缩短；远端投影是异步生成的，过早判失败会让用户重复发布并产生多个分享。
9. `conversationSharePublicProjection.ts` 逐字段赋值而不做对象展开，看似啰嗦；展开会把新增内部字段一并带出，形成隐性泄漏。
10. `accountProviderInvalidation.ts` 只有 2 行注释增量，看似敷衍；该文件本身只有 29 行代码且已有 24% 注释，补到 31% 即满足口径。
11. `providerProvisioning.ts` 只有 10 行代码，看似注释比例过高；这是文件粒度下限，2 行注释覆盖「描述符与接口同名」与通道归属，已是最小充分说明。

以上均为阅读结论，本批未改动任何代码 token。
