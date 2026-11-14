# 基线弱行清单生成记录（weak-own-by-file.tsv）

> 目的：补上 `snapshot/weak-own-by-file.tsv`（1,007 文件 / 7,421 行）缺失的生成记录。
> 本文只补可审计性，不改口径、不改分母；旧文件未覆盖。

## 1. 产物与指纹（SHA-256）

| 文件 | SHA-256 |
| --- | --- |
| `_annot_baseline/snapshot/weak-own-by-file.tsv` | `AC46A8528E913B3F8B8E450C049974F063E10861764877AA4E4AA07F008949F3` |
| `_annot_baseline/snapshot/weak-own-lines.tsv` | `444176F1B339F106B235B6ABEBF769513787D2B78913D1CCE1D9EEA468C8DF1F` |
| `_annot_baseline/snapshot/q-main-head.json`（输入快照） | `6BC92B74D64AB4FCA88130B60B42152DFE9ADDCDEC3A0086B19EEAACC38C90F5` |
| `_annot_baseline/snapshot/repro-filelist.txt`（1,726 文件清单） | `6474D7F38B8E76C9AD5617320B744A1514ED05167C1593991B1162BCFEA94075` |

## 2. 运行时坐标

- 扫描提交：`611b24a5`（2026-11-10 14:40，`chore(注释工具): 门禁基线参数 + 审计范围不变量 + 回填脚本落库`）
- own 基线：`8f7daaf0`；own 集合 = `git diff -U0 8f7daaf0 611b24a5` 的 `+` 行
- 尺子：`deep-quality.mjs` v2.0（`5144fefd8888`），`--metric-version v3`、`--field-mode ast`
- 范围：原快照为 1,726 个 `.ts/.tsx` 文件（部分工作树 `_annot_head`，已删除）；
  文件清单从 `q-main-head.json` 的 `rows[].path` 还原并冻结为 `repro-filelist.txt`

## 3. 复现命令

```powershell
# 1) 在 611b24a5 的干净 worktree 上，按原 1,726 文件清单重扫
node _annot_baseline/deep-quality.mjs <wt-611b24a5> `
  --file-list _annot_baseline/snapshot/repro-filelist.txt `
  --json _annot_baseline/snapshot/repro-q-611b24a5.json --quiet

# 2) 套 diffsets 的 own 过滤与分档，输出到 repro-*（不覆盖旧文件）
node _annot_baseline/baseline-repro.mjs
```

## 4. 复现结果（2026-11-11 实跑）

- 重扫 SUMMARY 与旧 JSON 逐项一致：`files=1726 units=359138 comments=187759 substance=86.1% weak=4.3%`，
  `MAP` 的 `mappedStrict/mappedBlock/unmapped` 与 reasons 亦逐项一致。
- own weak：**7,421 行 / 1,007 文件**，与旧清单相同。
- 两份输出**逐字节一致**：
  - `weak-own-by-file.tsv`：`same=true`，sha256 同上表。
  - `weak-own-lines.tsv`：`same=true`，sha256 同上表。
- 逐行差异：`WEAKLINE-DIFF n=0`（1,726 文件全部 weak 行集合相同）。

结论：基线清单可复算，输入（JSON）→ own 过滤 → 分档 全链路可回放。

## 5. 备注

- 原始生成命令当时未落盘；上面第 3 节是等价重建，现已作为权威命令。
- 旧 `q-main-head.json` 未标注提交号，按文件 mtime（2026-11-10 14:46）与提交时间定位到 `611b24a5`；
  重扫结果的 `comments/units/mapping` 完全一致，可反证该坐标正确。
- 复现产物 `snapshot/repro-*` 仅作证据保留，不参与计数；`weak-own-by-file.tsv` 未被覆盖。
