# SVC-B16 深度注释索引（git / storage / media-preview / providers / memory / gen-ui）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 106~120 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `git/config.ts` | 110 | 7 → 35 | 31.82% | 28 |
| `media-preview/mediaPreview.ts` | 85 | 0 → 27 | 31.76% | 27 |
| `storage/app/scanJob.ts` | 100 | 4 → 32 | 32.00% | 28 |
| `storage/adapters/fsCleaner.ts` | 108 | 7 → 34 | 31.48% | 27 |
| `git/repo/gitCheckpointStore.ts` | 86 | 0 → 27 | 31.40% | 27 |
| `storage/domain/usageAggregate.ts` | 94 | 4 → 30 | 31.91% | 26 |
| `project-storage/schema.ts` | 81 | 0 → 26 | 32.10% | 26 |
| `providers/api/apiJson.ts` | 81 | 0 → 26 | 32.10% | 26 |
| `client-config/clientConfigService.ts` | 87 | 2 → 28 | 32.18% | 26 |
| `credential/providers/credentialCipherProvider.ts` | 93 | 4 → 30 | 32.26% | 26 |
| `memory/projectMemoryStableRead.ts` | 85 | 3 → 27 | 31.76% | 24 |
| `providers/sourceHeaders.ts` | 78 | 1 → 25 | 32.05% | 24 |
| `gen-ui/adapters/service.ts` | 71 | 0 → 23 | 32.39% | 23 |
| `setting/legacyAccountConnectionSettings.ts` | 93 | 6 → 30 | 32.26% | 24 |
| `file/workspaceFileMentionFilter.ts` | 115 | 13 → 36 | 31.30% | 23 |
| **合计** | **1,367** | — | — | **385** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b16a | `git/config.ts` | 配置来源优先级、缺失键回退、写入时机 | 28 |
| b16a | `mediaPreview.ts` | 预览尺寸推导、MIME 白名单、跨平台路径 | 27 |
| b16a | `scanJob.ts` | 扫描作业状态机、取消语义、结果落盘顺序 | 27 |
| b16a | `fsCleaner.ts` | 白名单保护、删除顺序、部分失败继续 | 28 |
| b16b | `gitCheckpointStore.ts` | 存储布局、原子写、读取失败降级 | 27 |
| b16b | `usageAggregate.ts` | 聚合窗口、按 identity 归并、空值语义 | 26 |
| b16b | `schema.ts` | 建表 SQL 不拆分、迁移幂等、索引契约 | 26 |
| b16b | `apiJson.ts` | 响应解析容错、非 JSON 兜底、错误码透传 | 26 |
| b16c | `clientConfigService.ts` | 缓存与失效、远端覆盖本地、缺省值 | 26 |
| b16c | `credentialCipherProvider.ts` | GCM 密钥派生、空密文边界、解密错误码 | 26 |
| b16c | `projectMemoryStableRead.ts` | 三次 stat 交叉校验、5 MiB 上限、稳定读失败降级 | 24 |
| b16c | `sourceHeaders.ts` | 来源头生成规则、未知来源兜底 | 24 |
| b16d | `gen-ui/adapters/service.ts` | 适配器边界、宿主能力注入、错误包装 | 23 |
| b16d | `legacyAccountConnectionSettings.ts` | 旧键仅供回滚、两段式 Team key、ENOENT 视为无配置 | 24 |
| b16d | `workspaceFileMentionFilter.ts` | 目录黑名单退役、隐藏目录保留、apiKey 跳过 | 23 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b16
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=385
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 31.30%，最高 32.39%）。

b9~b16 八个快照在批后统一复核，全部 `deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。

全 services 复测（b16 后）：

```text
SUMMARY files=467 coreBelow30=145 needLines=1267 min=0.00 median=31.23 newComments=28349
```

## 4. 本批锚定的不变量

- `git/config.ts`：配置来源有固定优先级；缺失键回退到默认值而不是报错；写入集中在单一入口。
- `mediaPreview.ts`：预览尺寸由源尺寸推导；只接受 MIME 白名单；路径按平台分隔符处理。
- `scanJob.ts`：作业状态单向推进；取消后不再写结果；结果落盘先临时后替换。
- `fsCleaner.ts`：受保护目录永不删除；删除按深度倒序；单条失败不中断整批。
- `gitCheckpointStore.ts`：存储布局固定；写入必须原子；读取失败降级为空而不是抛错。
- `usageAggregate.ts`：聚合窗口固定；按 identity 归并；缺值按 0 参与而不跳过条目。
- `project-storage/schema.ts`：建表 SQL 作为整体执行；迁移可重复执行；索引名是契约。
- `apiJson.ts`：非 JSON 响应必须兜底；错误码原样透传；不吞掉解析异常上下文。
- `clientConfigService.ts`：远端配置覆盖本地默认；缓存有明确失效点。
- `credentialCipherProvider.ts`：密钥由固定参数派生；空密文是合法输入；解密错误映射为固定错误码。
- `projectMemoryStableRead.ts`：需三次 stat 交叉校验；超过 5 MiB 直接拒绝；失败降级为不注入。
- `sourceHeaders.ts`：来源头由来源标识派生；未知来源有兜底值。
- `gen-ui/adapters/service.ts`：适配器不持有宿主状态；能力经注入获得；错误统一包装。
- `legacyAccountConnectionSettings.ts`：旧键只用于回滚读取；Team key 仅两段；ENOENT 视为无配置。
- `workspaceFileMentionFilter.ts`：已退役目录不再遍历；隐藏目录保留；apiKey 类文件跳过。

## 5. 看似该改、其实不能改

- `git/config` 不能在缺键时抛错：会让旧配置整体不可用。
- `mediaPreview` 不能放开 MIME 白名单：会尝试渲染不可解码格式。
- `scanJob` 不能在取消后补写结果：会覆盖更新一次扫描的产物。
- `fsCleaner` 不能按遍历顺序删除：父目录先删会让后续子项 stat 失败。
- `gitCheckpointStore` 不能直接覆盖写：崩溃会留下截断文件。
- `usageAggregate` 不能跳过缺值条目：会让占比统计失真。
- `schema` 不能把建表 SQL 拆成多段执行：DDL 非事务，半途失败会留下不完整表。
- `apiJson` 不能把解析失败直接上抛：流式接口会返回空体。
- `clientConfigService` 不能永久缓存：远端下发的新配置需要生效。
- `credentialCipherProvider` 不能把空密文当错误：未设置凭据是正常状态。
- `projectMemoryStableRead` 不能省略 stat 交叉校验：并发写会读到半截内容。
- `sourceHeaders` 不能对未知来源返回 undefined：下游会拼出畸形头。
- `gen-ui/adapters/service` 不能让适配器直接读全局单例：测试与多宿主场景会串状态。
- `legacyAccountConnectionSettings` 不能删除旧键读取：回滚路径仍需可用。
- `workspaceFileMentionFilter` 不能重新遍历已退役目录：会引入大量噪声候选。
