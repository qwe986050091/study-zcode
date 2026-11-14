# ZC-deep-b359

> 批次：b359 ｜ **30 行 / 6 文件** ｜ 提交 `19b537c4`
> 尺子：`deep-quality.mjs` v2.0、`zc-commit-v13.mjs`、`precheck-assert.mjs`、`gate-run.mjs`、`preflight.mjs`

## 0. 方案 ① 普通批；`fix=1`

- `TALLY {"ownIn":30,"ownOut":0,"upIn":0,"upOut":0,"pending":0,"planIn":30,"planOut":0}` / `plan=30` / `files=6/6`。
- **首轮 `hits=1`**：`W` 单行无信息 1 条 —— `fileMentionProvider.ts:194`，
  原句「异常统一收敛成作用域错误…」无标识符锚点；补 `scope.error` 后归零。
  这一条属**无锚点**类（起草时没写标识符），不计入 L。
- `hit_rate = 1 ÷ 30 = 3.3%`（b358 为 30.0%）。`fix≥2` 连续计数回到 **0**（b358 计 1、b359 未达 2）。
- 本轮是 L 谓词表扩表后的首批（`不等/区分/来自/控制/不需要` 已进表），首轮 L 命中 0。

## 1. 选行与目录分布

| 文件 | 池内 | 本批 | 批后 weak | 目录 |
| --- | ---: | ---: | ---: | --- |
| `packages/ui/src/mentions/providers/fileMentionProvider.ts` | 5 | 5 | 0 | ui/mentions/providers |
| `packages/ui/src/mentions/providers/subagentsMentionProvider.ts` | 5 | 5 | 0 | ui/mentions/providers |
| `packages/ui/src/ToolCallBlocks/renderers/cron-create.tsx` | 5 | 5 | 0 | ui/ToolCallBlocks/renderers |
| `packages/ui/src/ToolCallBlocks/renderers/cua.tsx` | 5 | 5 | 0 | ui/ToolCallBlocks/renderers |
| `packages/ui/src/project-sidebar/TaskGroupedView.tsx` | 5 | 5 | 0 | ui/project-sidebar |
| `packages/ui/src/workspace-file-tree/WorkspaceFileTreeList.tsx` | 5 | 5 | 0 | ui/workspace-file-tree |
| **合计** | **30** | **30** | **0** | — |

- **目录分布**：**1 个顶层目录**（`packages/ui`），4 个子域（两对各同目录）。
- ≥5 行档在本批后由 15 文件降到 **9 文件 / 45 行**，下一批仍是 6 文件 × 5 行。

## 2. 改动内容

- `fileMentionProvider.ts`：会话/项目/工作区三种作用域的根解析顺序与失败语义；异常收敛成 `scope.error`。
- `subagentsMentionProvider.ts`：优先级三档（`0/1/2`）；禁用先淘汰；去重键归一；来源标签前置。
- `cron-create.tsx`：类型守卫只做准入；`candidates` 优先取直接输出；禁用不隐藏；提前返回位置。
- `cua.tsx`：标题三处回退；`bundle_id`/`bundleId` 双键；目标形状两种；截图随 `success`；按键名读取入口。
- `TaskGroupedView.tsx`：内存草稿归属；重命名草稿生命周期；移动的本地投影时序；两步式 `moveTask`；浮层宽度来源。
- `WorkspaceFileTreeList.tsx`：遮罩区域；选中比较先归一；行键取完整路径；虚拟项越界判空；三态分支复用通知组件。

## 3. 六闸

```
gate: PASS scope n=0 plan=30 allow=0 diff_old=30 diff_new=30 out_of_scope_edits=0 plan_lines_covered=30/30
gate: PASS record n=0 same=0 indent=0/0 mtime=0 drift=0 record_runs=1
gate: PASS verify n=0 same=0 indent=0/0 mtime=0 drift=n/a record_runs=1 verify_ok=true
gate: PASS commit n=0 sha=19b537c4 files=6/6 numstat=30/30 删代码=0 删上游=0 新增非注释=0 搬移=0 判据=0 嵌套=0 标点=0
gate: PASS pool-diff n=0 removed=30 added=0 allowed=40 auto_self_clear=0
gate: PASS order n=0 total=122.0s controllable=109.0s
```

## 4. 自清

- `auto_self_clear=0`；累计仍 **10 行 / 10 文件**。

## 5. 池外与进度

- 全仓 weak：`4,204 → 4,174`（**−30**），文件 `1,662 → 1,656`（**−6**，六个文件全部清零）。
- `done += 30`（池内自清 0）、`files -= 6`；本批 6 个文件均无池外残留。
- **句子级**：`done 6,488 / remain 933`，`6,488 + 933 = 7,421`，**87.4%**。
- 池外：`4,174 − 933 = 3,241`（不变）。
- **文件数两列**：可清 **370** / 含池外残留 **1,286**（floor 1,286）。
- 池内密度：**933 行 / 456 文件 = 2.05 行/文件**。

## 6. 计时（B 段第 10 批）

| 读数 | 起点 | 终点 | 本批 | 每行 |
| --- | --- | --- | ---: | ---: |
| `total` | 上一提交 `d4ee6674`（11:54:05） | 批次提交 `19b537c4`（11:56:07） | 122.0s | 4.07s |
| `controllable` | `--start`（11:54:18） | 批次提交（11:56:07） | 109.0s | **3.63s** |
| 收口段 | 批次提交（11:56:07） | 台账提交 `f0b3a728`（11:57:08） | 61s | — |
| `批墙钟` | 最早产物 `b359-t-start.txt`（11:54:18） | 台账提交 `f0b3a728`（11:57:08） | 170.0s | 5.67s |

- 可控段 3.63 s/行，B 段第二低；只有 1 条无锚点返修，判据返修成本 ≈8s。
- 收口 **61s** 正好落在普通收口中位数（61s）上；与 b358 的 77s 同为 `STALE-EXPECTED` 生效后的读数。
- 监控：收口 61s（阈值 150s，未触发）、可控 3.63 s/行（阈值 8，未触发）。
- 白名单 `preflight --whitelist` → `STALE-EXPECTED n=15 source=4 docs=11`；
  `--total-start d4ee6674` 校验通过（`TOTAL-START OK`），两条均 1s 内。

## 7. 提交

| 内容 | 提交 | numstat |
| --- | --- | --- |
| 批次本体（6 文件 1→1 改写） | `19b537c4` | `+30/−30` |
| `ZC-deep-b359-rewrite.tsv` + 本台账 + INDEX | `f0b3a728` | — |
