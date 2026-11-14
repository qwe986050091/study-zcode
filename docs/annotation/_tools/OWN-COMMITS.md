# 本线归属白名单（own-commits）

`zc-commit --rewrite-annot` 判断「这行是谁写的」不再看 commit 标题，只看 **blame sha 在不在本表**：

- 在 → 本线（可删可改，逐行登记）；
- 不在 → 上游（删/改一律拒绝，任何理由不例外，DEEP-SPEC §2.6）。

为什么改：v1–v5 用标题前缀（`bNNN` / `注释` / `snapshot(annot)`）。b236 就漏了 `docs(注释): …`
（L2-B10b 起的新写法），把 3 行本线注释判成上游；而反过来「把上游判成本线」会直接放行改写上游注释，
比多拒一次严重得多。标题可以随时换写法，sha 不会。

## 1. 表格之外的批次提交（自动）

各批台账 `docs/annotation/ZC-*.md` 里按惯例写的 `提交 <sha>`、`git log` 证据块里的
`<sha> bNNN …`、以及 `安全快照 <sha>`，由 `own-commits.mjs` 自动抽取，**不需要**抄到本表。
当前自动抽出 12 条（b229–b236、b230–b233、a8784b7e、b34d5ba5、b18/b135 补提交），
`node docs/annotation/_tools/own-commits.mjs d:\code\ZCode` 可随时复算。

## 2. 需要手工登记的（没有独立批次台账）

L2 覆盖线一次性补提交的注释没有单独台账，按下表登记；新增同类提交时追加一行。

| sha | 日期 | 提交标题 |
| --- | --- | --- |
| `ad6dc0eb` | 2026-11-03 | docs(注释): L2-B2 runtime |
| `54f51bad` | 2026-11-03 | docs(注释): L2-B3 handlers a-o |
| `c3590b12` | 2026-11-03 | docs(注释): L2-B4 handlers p-z 与 tool 其余 |
| `878e95da` | 2026-11-03 | docs(注释): L2-B5 contracts |
| `522e851e` | 2026-11-03 | docs(注释): L2-B6 adapters |
| `deb218da` | 2026-11-03 | docs(注释): L2-B7 bootstrap-v4 |
| `0f2ef80d` | 2026-11-03 | docs(注释): L2-B8 bootstrap 其余 |
| `73782160` | 2026-11-03 | docs(注释): L2-B9 context/memory/workflow |
| `a7af675d` | 2026-11-03 | docs(注释): L2-B10b 覆盖补齐 tui 与 office-runtime |
| `b3cc6d24` | 2026-11-03 | docs(注释): L2-B10b 覆盖补齐 telemetry 与 prompt-trajectory |
| `10e9df51` | 2026-11-03 | docs(注释): L2-B10b-1 覆盖补齐 a-c 段索引 |
| `55f48e6d` | 2026-11-04 | docs(注释): 收尾提交 插件宿主与 dev-docs 纯注释增量 |
| `ee933d52` | 2026-11-03 | docs(注释): 补齐被剔除的 contracts/bootstrap-v4 注释改写 |
| `c788b9f1` | 2026-11-03 | docs(注释): 收尾提交 core 与 contracts 纯注释增量 |

## 3. 维护规则

1. 批次改完在批台账里写 `提交 <sha>`（现有惯例），白名单自动增长；漏写会导致下一批把本线行判成上游（只会更严，不会放行）。
2. 只有「本线一次性补提交、且不打算单独立台账」的才进 §2；进表必须带日期与完整标题，便于审计。
3. 表里的 sha 必须能被 `git rev-parse --verify <sha>^{commit}` 解析。v2 起解析失败不再静默跳过：
   `--check` 会把它判成 **未解析** 并 `exit 3`，报告里单列「待定 n 条」、计入未完成。
   未解析的行必须人工定归属（`git log -1 --format='%an %ae %s'`、是否在批次台账）后回填本表，才允许放过。
