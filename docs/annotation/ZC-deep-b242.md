# b242 改写批（合并第 3 批：6 文件 + 三件跟办）

- 日期：2026-11-10
- base：`3ddc34f2`（b241 台账提交，本批改写前 HEAD）
- 提交：`14c0e7e1 b242 改写 6 文件的水句 (+9/−14)`
- 尺子：`zc-commit v8`（本批返工中从 v7 升到 v8，见 §7）

## 1. 本批选谁

1–2 行档剩余排序取下一组，并回收 b241 剩下的 1 行本线：

| 文件 | 实测 weak |
| --- | ---: |
| `bootstrap/src/zcode-protocol-v4/product-projection.ts` | 4（1 本线 + 3 上游） |
| `core/src/runtime/helpers/attachment-media-resolver.ts` | 5 |
| `core/src/runtime/internal-methods.ts` | 2 |
| `core/src/runtime/internal-turn-methods.ts` | 2 |
| `core/src/runtime/methods/session-fork.ts` | 2 |
| `core/src/session-context/read-session-context.ts` | 3 |

合计 18 行，可改 15 行。

## 2. 归属预检（v6 白名单）

| sha | 行数 | 判定 | 处置 |
| --- | ---: | --- | --- |
| `a8784b7e` | 11 | 本线 | 改写/删除 |
| `ad6dc0eb`（`docs(注释): L2-B2 runtime`） | 3 | 本线 | 改写/删除 |
| `ee933d52` | 1 | 本线（b242 补录，见 §3） | 改写 |
| `c788b9f1` | 1 | 本线（b242 补录，见 §3） | 删除 |
| `872ad960`（`feat: open source`） | 3 | **上游** | 不改，登记豁免 |

白名单 28 → **31 条**（b241 台账的 `da7c8668`、`3ddc34f2` 自动进表，加手工 2 条）。

## 3. `ee933d52` 取证结论（指令第 3 件）

```text
$ git log -1 --format='%H %an %ad %s' ee933d52
ee933d5234c6629b61a9dd6851c579cbceb21c11  zhanglingfeng  2026-11-03 23:02  docs(注释): 补齐被剔除的 contracts/bootstrap-v4 注释改写

$ git show --stat ee933d52
83 files changed, 2177 insertions(+), 4 deletions(-)

$ git show ee933d52 -- .../product-projection.ts  （筛非注释新增行）
added=763 nonComment=0
```

判定为**本线漏登记的注释提交**：作者同人、标题 `docs(注释):`、0 行非注释新增、4 行删除也全是注释（英文注释 1 + 中文 3）。

按同一标准回头检查 `read-session-context.ts:465` 的 `c788b9f1`：标题 `docs(注释): 收尾提交 core 与 contracts 纯注释增量`，
83 files / +2177 / −4，本文档内 `added=38 nonComment=0`（那 1 行是空行），删除 4 行亦全为注释。
与已登记的 `55f48e6d`（`docs(注释): 收尾提交 插件宿主与 dev-docs 纯注释增量`）同族。

两条都**有取证**才补进 `OWN-COMMITS.md`；没有「为了清零」放宽：`872ad960` 仍是上游，本批 3 行照旧不改。

## 4. 门禁七行原文（v8，含 self 行）

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=d5dc8bd91446
=== 改写门禁（base=HEAD）===
删本线注释    n=14  （允许，逐行登记）
删代码        n=0  （必须 0）
删上游注释    n=0  （必须 0）
新增非注释行  n=0  （必须 0）
原行搬移      n=0  （不变量：不计入改写量、不计入新增注释行数；行号见下方明细）
标点级改写    n=0  （必须 0：去标点后与删除行相同但原文不同）
新增注释行    n=9  其中判据命中 0  （必须 0；已扣除搬移行）
```

`ruler=` 从此抄 `GATE self=` 这一行，不再人手填。

## 5. TSV 与「删本线注释」逐条对应（14 条 = 门禁 n=14）

```text
 1  bootstrap/src/zcode-protocol-v4/product-projection.ts:2548   ee933d52  * 不得在本地发明补丁或误删。
 4  core/src/runtime/helpers/attachment-media-resolver.ts:118      a8784b7e  // 内存媒体按类型分三条子链路。
    :236                                                          a8784b7e  // 其余类型交回上层继续分派。
    :310                                                          ad6dc0eb  * - 其余大小/格式问题…
    :648                                                          ad6dc0eb  * 无副作用。
 2  core/src/runtime/internal-methods.ts:231                       a8784b7e  // 启动预留同样计入繁忙。
    :232                                                          a8784b7e  // 常驻池使用独立判定方法。
 2  core/src/runtime/internal-turn-methods.ts:322                  a8784b7e  // 代价是同一次调用遍历两遍工具列表…
    :520                                                          a8784b7e  // 只记录待生效的模型切换…
 2  core/src/runtime/methods/session-fork.ts:223                   a8784b7e  // [权衡] 一次性预分配全部 id…
    :379                                                          a8784b7e  // [权衡] 大历史下两遍遍历是 O(n)…
 3  core/src/session-context/read-session-context.ts:52            a8784b7e  // 默认值只在调用方没给预算时兜底…
    :112                                                          a8784b7e  // 输出预算先夹紧再下传…
    :465                                                          c788b9f1  // 剩余预算太小时宁可不追加…
```

删除 5 行（重复句 / 重复段），改写 9 行（1→1，补标识符锚点）；`新增注释行 n=9` 与 numstat `+9` 对齐。
`internal-methods.ts` 是 2 删 1 增：`启动预留同样计入繁忙。` 与上方 JSDoc 重复，删；`常驻池使用独立判定方法。` 改写成带 `hasResidencyBlockingWork` 的版本。

## 6. 度量与覆盖

| | SUMMARY | RATIOS |
| --- | --- | --- |
| 改前 | `files=6 units=5225 coverage=10.0% branch=11.1% field=2.4% comments=2690 substance=80.7% explain=99.3% filler=0.0% weak=0.7%` | `weak=18/2690 filler=0/2690` |
| 改后 | `files=6 units=5225 coverage=10.0% branch=11.1% field=2.4% comments=2685 substance=81.1% explain=99.9% filler=0.0% weak=0.1%` | `weak=3/2685 filler=0/2685` |

`--list-weak`：18 → **3**，全部在 `product-projection.ts` 且全为 `872ad960` 的分区线（§9）。

覆盖差集（`path|unitText`）：`pre=3369 post=3369 onlyPre=0 onlyPost=0`。

numstat：

```text
+1 −1  bootstrap/src/zcode-protocol-v4/product-projection.ts
+1 −4  core/src/runtime/helpers/attachment-media-resolver.ts
+1 −2  core/src/runtime/internal-methods.ts
+2 −2  core/src/runtime/internal-turn-methods.ts
+2 −2  core/src/runtime/methods/session-fork.ts
+2 −3  core/src/session-context/read-session-context.ts
合计 +9 −14
```

## 7. 返工打点

| # | 区间 | 内容 | 耗时 |
| --- | --- | --- | ---: |
| 1 | 17:46:22.187 → 17:46:57.296 | 门禁 v7 首跑 `新增注释行 n=7`，与 numstat `+9` 差 2；查出 v7 只把 `//` 行计入新增注释，JSDoc `*` 行被静默丢掉（既没计数也没过判据）。改 v8（`//` 与 `*` 都收，剥前缀后同样过 W/L/POEM），归档 `zc-commit-v8.mjs`，复跑 `n=9 命中 0` | 35.1s |

返工发生在首次门禁之后、提交之前，计入段 3。

## 8. 三段计时

| 段 | 打点 | 秒 |
| --- | --- | ---: |
| T0 → T1（读上下文 + 归属预检） | 17:44:41.474 → 17:45:44.934 | 63.5 |
| T1 → T2（编辑 15 行） | 17:45:44.934 → 17:46:05.154 | 20.2 |
| T2 → T3（快照 + 门禁 + 返工 + 提交） | 17:46:05.154 → 17:47:10.671 | 65.5 |
| **合计 == 墙钟** | 17:44:41.474 → 17:47:10.671 | **149.2** |

每文件均摊：149.2 / 6 = **24.9 秒/文件**。

阈值计数（b241 §2 的表）：

| 条件 | 计数 | 结果 |
| --- | ---: | --- |
| 连续 2 批 > 40 | 0（b242 已 <40，b241 的 1 被打破） | 维持 6 个 |
| 连续 2 批 < 25 | **1**（b242 = 24.9） | 暂不抬到 8 个；**b243 若也 <25 则试 8 个** |

## 9. 上游 weak 豁免（3 行，b241 已有，未变）

```text
product-projection.ts:2688  无解释  ── 生命周期 ──   872ad960  feat: open source
product-projection.ts:3238  无解释  ── 流式输出 ──   872ad960  feat: open source
product-projection.ts:6551  无解释  ── 内部工具 ──   872ad960  feat: open source
```

**已知上游，故意不改**，登记在此备查；不改判据、不绕过。

## 10. 三件跟办

### 10.1 旧副本处置

- `_tools/zc-commit.mjs`（v4 内容，blob `f2661d7008ee`）→ `git mv` 为 `_tools/zc-commit-pre-v6-DO-NOT-RUN.mjs`，INDEX §2/§10 标注**当前不执行**。
- 活文件仍是 `_annot_baseline/zc-commit.mjs`（因 §7 升到 v8，blob `d5dc8bd91446`），并归档 `_tools/zc-commit-v8.mjs`。
- **流程失误**：`git mv` 先暂存了改名，而门禁提交用 `git commit -F` 提交全部已暂存内容，于是这个 0 行改动的改名被 `14c0e7e1`（代码提交）带走，而不是随文档提交。内容无影响（`0 files changed` 的重命名），但「代码提交只含 6 个源文件」这句话不成立：`14c0e7e1` 实为 6 源码 + 1 改名。后续批次若要先 `git mv`，必须在代码提交前 `git reset` 该暂存项，或用路径限定的 `git commit -- <files>`。

### 10.2 门禁自报 sha1

v7 起七行之前多一行：

```text
GATE self=d:\code\_annot_baseline\zc-commit.mjs blob=19d38e36b73b
```

b242 实跑（v8）打印 `blob=d5dc8bd91446`，本报告 §4 的 `ruler=` 即抄自此行。

### 10.3 `ee933d52` 结论

见 §3：本线漏登记，已补白名单并清那 1 行（`product-projection.ts:2548`）。`872ad960` 维持上游。

## 11. 下一步

1. b243 仍 6 文件；若每文件均摊再 <25 秒，按阈值表试 8 个；
2. 1–2 行档清完后、切 5–9 档前，先做 3 文件验证批（报每批秒数与每文件均摊），实测前不动 143 批估算。
