# b396 · cap 20 第 6 批（20 文件 / 20 行，首轮全绿，阈值换代后首批）

> 提交：`5bde632b`（代码 20 行 / 20 文件，+20/−20）
> 批前基准：`b395-repo-post.txt`；批后快照：`b396-repo-post.txt`

## 0. 三列与判据

| 判据类 | 格式类 | lint |
| ---: | ---: | ---: |
| **0**（`judge-generic` hits=0） | **0**（`diffset-assert` missing=0 extra=0） | **首轮 5 → 修后 0** |

- lint 首轮 5 条：1 条 `、`+`，` 超限、2 条禁用词（「据此」「在此」）、2 条无锚点（`defaultProject`、`presentWorkspaceHookReviewRequestSchema`）。
  只改草稿脚本，未落盘返工。

## 0.1 cap 20：本批使用换代后的阈值 `173.25`

| 判据 | 阈值/公式 | b393 | b394 | b395 | b396 |
| --- | --- | --- | --- | --- | --- |
| `pool-diff` 首轮 `n` | **= 0** | 0 | 0 | 0 | **0** |
| `removed − selfclear_batch` | **= `plan.tsv` 行数** | 20 = 20 | 20 = 20 | 20 = 20 | **20 − 0 = 20** |
| `controllable` | **≤ 173.25**（b396 起） | 118.0 | 121.0 | 110.0 | **82.0** |

- **换代说明**：预登记规则「连续两批首轮干净 → `1.5 × 那两批 controllable 中位`」在 b394+b395 后满足，
  故 `1.5 × median(121.0, 110.0) = 173.25`。**本批用的是 `173.25`，不是 `181.5`**；旧值 `181.5` 留痕于 CLOSING §7。
- 首轮干净率 **5/6**，b394–b396 **连续三批**全过，维持「稳定」。

## 1. 逐文件（批前 → 批后）

| 文件 | 前 | 后 |
| --- | ---: | ---: |
| `packages/services/src/zcode-agent/agentStderrCollector.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/groupAttachmentUpload.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/localRuntimeNetworkCapture.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/modelTrajectory.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/topicResourceBridge.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/zcodeAgentPluginParams.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/zcodeProtocolClient.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/zcodeProtocolTransport.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/zcodeStdioTapDevConfig.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/zcodeStdioTransport.ts` | 1 | 0 |
| `packages/services/src/zcode-agent/zcodeStorageStartupGate.ts` | 1 | 0 |
| `packages/shared/src/bots.ts` | 1 | 0 |
| `packages/shared/src/forceUpdate.ts` | 1 | 0 |
| `packages/shared/src/permission-request-preview.ts` | 1 | 0 |
| `packages/shared/src/project-access-token-client.ts` | 2 | 1 |
| `packages/shared/src/session-debug.ts` | 1 | 0 |
| `packages/shared/src/source-server/contracts.ts` | 1 | 0 |
| `packages/shared/src/web-remote-control-rpc-transport.ts` | 1 | 0 |
| `packages/shared/src/zcode-protocol-v4/rows.ts` | 1 | 0 |
| `packages/shared/src/zcode-protocol-v4/workspace-hook-review.ts` | 1 | 0 |

| 清理 | 全仓清零 | 注解清零 | 归类清零 | 新进 |
| ---: | ---: | ---: | ---: | ---: |
| **20** | **19** | **19** | **0** | **0** |

- `全仓清零 19 = 表内 +10 + 表外 +9`：`CLEARED 197 → 207`、表外 `42 → 33`。
- **表外差集**：新增 **0** / 移除 **9**，9 行全 `annotation`；`mixed` 仍未观测到（规则按行级预置）。
- **池外残差**：`3,312 − 79 = 3,233`（两个输入都在 §3；恒定是两边同减的结果）。

## 2. 六闸原文（同一次跑）

```
gate: PASS scope n=0 plan=20 allow=0 diff_old=20 diff_new=20 out_of_scope_edits=0 plan_lines_covered=20/20
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=5bde632b files=20/20 numstat=20/20 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=20 added=0 selfclear_batch=0 allowed=38 auto_self_clear=0
gate: PASS order n=0 total=83.0s controllable=82.0s
GATE ALL PASS batch=b396 sha=5bde632b
```

- `allowed = 20 计划 + 18 已登记 + 0 自动 = 38`。

## 3. 进度与残余

| 项 | 值 |
| --- | --- |
| 池内可写行 | **79**（done 7,342 / 7,421 = **98.9%**；输入 1） |
| 池内文件 | **79**（done 928 / 1,007 = 92.2%），辅助 |
| 全仓 weak | **3,312 行 / 1,346 文件**（输入 2） |
| 池外残差 | **3,233 = 3,312 − 79**（**减法结果**，非实测、非基线） |
| 集合 | `1,346 = ACTIVE 1,313 + 表外 33`（定义恒等，非校验） |
| 表内 | `1,520 = ACTIVE 1,313 + CLEARED 207`（定义恒等，非校验） |

- `ALIGNED OK`：`acct_remain 79 == pool_remain 79`。
- 剩余形状 **79 文件 × 1 行**，cap 20 下 `ceil(79 / 20) = 4` 批。

## 4. 计时

| 读数 | 起点 | 终点 | 秒 |
| --- | --- | --- | ---: |
| `controllable` | `--start`（20:19:34.7） | 批次提交（20:20:56） | **82.0** |
| **S0** 收口准备 | 20:20:56 | 20:21:18 | **22.0** |
| **S1** 失败诊断 | — | — | **0.0** |
| **S2** 人工登记 + 二段闸 | — | — | **0.0** |
| **S3a** 台账与快照 | 20:21:18 | 20:22:11.7 | **53.7** |
| **S3b** CLOSING + INDEX 填数 | 20:22:11.7 | 20:22:16.0 | **4.3**（本批起与 S3a 分开打点） |
| **S4** 提交（数据行，`eec79644`） | 20:22:16.0 | 20:22:19.0 | **3.0** |
| **收口 S0–S4** | 20:20:56 | 20:22:19.0 | **83.0**（22.0 + 0 + 0 + 53.7 + 4.3 + 3.0） |
| **批墙钟** | 20:19:34.7 | 20:22:19.0 | **164.3** |
| **S5** 回填（计时 + 主报复算 + 回填提交） | 20:22:19 | 20:23:17 | **58.0**（计入常数 `57.0`，偏差 +1.0） |

TOOL_TRIP: 0.0（无重复执行）
S5_PER_BATCH: 57.0

- **端点容差**：b395 批 `墙钟 188.5` 与 `收口 79.3 + controllable 110.0 = 189.3` 差 `0.8s`，两端各 ±0.5s，**不默认相加相等**；
  本批同样只报端点实测值。

## 5. 主报

- 剩余 79 行 / 79 文件 → cap 20 下 `4` 批。
- 窗口 `b396 / b395 / b394`，净收口 `83.0 / 79.3 / 98.0` → 中位 **`83.0s`**（三个都没有工具往返，**本窗口中位不含构造值**）。
- **主报 `0.30h`**：`4 × (61.4 + 57.0) + 79 × 3.45 + 4 × 83.0 = 473.6 + 272.55 + 332.0 = 1078.15s`；区间 `0.22–0.36h`；包络 `0.18–0.24h`。
- 参考档：收口回到窗口最低 `79.3s` → `0.30h`（无差别）。
- **`S5_closeout` 不在 `0.30h` 里**：最后一批的全量总账、CLOSING 收口、INDEX 终表另记，按 §5.5 写死为口径外缺口。
- 本批**无口径变更**：执行 b396 前定稿的四项（残差改名、S3b 拆分、阈值 `173.25`、`S5_closeout` 定义）。
