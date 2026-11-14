# ZCode 深度注释工程 · 完成度总览

> 范围：`d:\code\ZCode` 的 **core 与 apps 部分**，即计划文档 [ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)
> 定义的「本会话范围」：`packages/**`（**排除 `packages/services`**）+ `apps/**` + `scripts/` + `docs/`。
> `packages/services/**` 由另一会话负责，本工程不触碰。
>
> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）。
> 口径：`deep-density.mjs --mode code --threshold 30 --ext .ts,.tsx`；密度 = 注释行 ÷ 代码行。

## 1. 验收判据（每批必须全绿）

| 判据 | 工具 | 通过条件 |
| --- | --- | --- |
| 零删除 | `zc-verify.mjs <snapshot>` | `deletedNonZero=0` |
| 只新增注释 | 同上 | `nonCommentAdded=0` |
| 注释内无 `*/` | 同上 | `starSlash=0` |
| 语法可解析 | 同上（TypeScript parser） | `syntaxErrorFiles=0`；解析器缺失 fail-closed |
| 注水门禁 | `zc-gate.mjs --scan <files.txt>` | `badFiles=0` 且 `waterRate < 1%`（插入侧 `zc-insert.mjs` 落盘前同判据自检） |
| JSX 位置门禁 | `zc-gate.mjs`（`gateInsertion`） | 新增注释落在 `JsxText`（JSX 子节点）即整批不落盘；解析失败 fail-closed |
| 内文率 | `zc-inner.mjs` | 与注水率并列报告；函数体内中文注释行 ÷ 代码行 |
| 密度 | `deep-density.mjs` | 仅作参考，不再作硬门槛 |

批次基线与 `_files.txt` 统一放在 `d:\code\_annot_baseline\ZC-deep-bN{,a,b}\orig`。

> **统计口径（硬性）**：所有审计按「去重文件全量」扫描，同一 `rel` 只计一次；禁止按批次快照累加——
> 同一文件可能出现在多个批次目录（如 `b120` 与 `b120a`），累加会重复计数（曾把 37 行算成 74 行）。
> `zc-gate.mjs --scan` 与 `zc-clean-queue.mjs --all` 均按此口径。
>
> **注水分档（`zc-classify.mjs`）**：1 真注水（无标识符/谓词/前置/后果）→ 按 v2 重写；
> 2 可增强（有谓词或时序但缺锚点）→ 原地补真实标识符 + 一句「做错会怎样」；3 误判（顺序/条件与后果齐全，仅句子短）→ 记录保留。
> 只有 1/2 两类进修复队列，三类行数分开报告，不用单一水率概括。
>
> **段落级复核（`zc-para.mjs`，二遍判据）**：`zc-gate` 的 W/L 按行判，会把硬折行的续句与「枚举 + 后果」的长句误判为注水。
> poem run / B 堆叠仍按行（其定义就是连续短行），仅对 W/L 命中把同段连续 `//` 拼成一段重判。
> 2026-11-08 全量复核（1415 个命中文件）：行级 `waterLines=21,625`（17.11%）→ 真实 **7,420（5.87%）**，
> 其中 14,205 行为折行/枚举误判；真实待修 = poem 5,770 + W/L 真弱行 1,650。
> 门禁不变（`zc-gate` 仍 fail-closed、宁可误报），但**派活改按** `zc-para.mjs --queue` 的结果（`zc-work-queue-true.txt`）。
>
> **插入位置硬约束（v2 增补）**：插入点必须落在语句/声明之前，不得落在 JSX 子节点、字符串或模板字面量内部。
> `JsxText` 里的 `//` 不是注释而是渲染文本（FIX-B118 全仓 891 行即此类），插入侧由 `gateInsertion` 直接拦截。
> 判据落地：`zc-gate.mjs` 解析待落盘文本，新增行命中 `JsxText` 即 `JSX_TEXT` 违规、整批不写盘。

### 1.1 改写批（`zc-verify.mjs --rewrite`）

删除注释行必须同时满足三条，任一不满足即非零退出：

| 判据 | 字段 | 通过条件 |
| --- | --- | --- |
| 被删行是注释行 | `codeDeletion` | `0` |
| 被删行相对 git HEAD 是新增行（只删自己加的注释） | `upstreamCommentDeleted` | `0` |
| 代码 token 流与 HEAD 一致（剔除整行 `//` 后逐行比对） | `codeTokenDiff` | `0` |
| 未删字符串/模板字面量内部的 `//` 行 | `literalCommentDeletion` | `0` |

改写批单独记账：`rewrittenSegments` / `deletedOwnCommentLines` / `codeTokenDiff`，不并入原批次合计。

## 2. 已完成批次

| 批次 | 文件数 | 新增注释行 | 索引 |
| --- | ---: | ---: | --- |
| B1 | 1 | 1,175 | [ZC-DEEP-b1.md](./ZC-DEEP-b1.md) |
| B2 | 2 | 1,795 | [ZC-DEEP-b2.md](./ZC-DEEP-b2.md) |
| B3 | 2 | 1,700 | [ZC-DEEP-b3.md](./ZC-DEEP-b3.md) |
| B4 | 2 | 1,533 | [ZC-DEEP-b4.md](./ZC-DEEP-b4.md) |
| B5 | 3 | 1,803 | [ZC-DEEP-b5.md](./ZC-DEEP-b5.md) |
| B6 | 3 | 1,646 | [ZC-DEEP-b6.md](./ZC-DEEP-b6.md) |
| B7 | 3 | 1,558 | [ZC-DEEP-b7.md](./ZC-DEEP-b7.md) |
| B8 | 4 | 1,968 | [ZC-DEEP-b8.md](./ZC-DEEP-b8.md) |
| B9 | 4 | 1,955 | [ZC-DEEP-b9.md](./ZC-DEEP-b9.md) |
| B10 | 4 | 1,829 | [ZC-DEEP-b10.md](./ZC-DEEP-b10.md) |
| B11 | 5 | 2,119 | [ZC-DEEP-b11.md](./ZC-DEEP-b11.md) |
| B12 | 5 | 1,896 | [ZC-DEEP-b12.md](./ZC-DEEP-b12.md) |
| B13 | 5 | 1,798 | [ZC-DEEP-b13.md](./ZC-DEEP-b13.md) |
| B14 | 6 | 1,999 | [ZC-DEEP-b14.md](./ZC-DEEP-b14.md) |
| B15 | 6 | 1,860 | [ZC-DEEP-b15.md](./ZC-DEEP-b15.md) |
| B16 | 7 | 2,204 | [ZC-DEEP-b16.md](./ZC-DEEP-b16.md) |
| B17 | 7 | 2,146 | [ZC-DEEP-b17.md](./ZC-DEEP-b17.md) |
| B18 | 8 | 2,161 | [ZC-DEEP-b18.md](./ZC-DEEP-b18.md) |
| B19 | 8 | 1,952 | [ZC-DEEP-b19.md](./ZC-DEEP-b19.md) |
| B20 | 9 | 2,251 | [ZC-DEEP-b20.md](./ZC-DEEP-b20.md) |
| B21 | 9 | 1,999 | [ZC-DEEP-b21.md](./ZC-DEEP-b21.md) |
| B22 | 9 | 1,797 | [ZC-DEEP-b22.md](./ZC-DEEP-b22.md) |
| B23 | 8 | 1,513 | [ZC-DEEP-b23.md](./ZC-DEEP-b23.md) |
| B24 | 8 | 1,448 | [ZC-DEEP-b24.md](./ZC-DEEP-b24.md) |
| B25 | 8 | 1,388 | [ZC-DEEP-b25.md](./ZC-DEEP-b25.md) |
| B26 | 7 | 1,136 | [ZC-DEEP-b26.md](./ZC-DEEP-b26.md) |
| B27 | 8 | 1,256 | [ZC-DEEP-b27.md](./ZC-DEEP-b27.md) |
| B28 | 8 | 1,208 | [ZC-DEEP-b28.md](./ZC-DEEP-b28.md) |
| B29 | 11 | 1,539 | [ZC-DEEP-b29.md](./ZC-DEEP-b29.md) |
| B30 | 12 | 1,641 | [ZC-DEEP-b30.md](./ZC-DEEP-b30.md) |
| B31 | 12 | 1,707 | [ZC-DEEP-b31.md](./ZC-DEEP-b31.md) |
| B32 | 12 | 1,577 | [ZC-DEEP-b32.md](./ZC-DEEP-b32.md) |
| B33 | 12 | 1,485 | [ZC-DEEP-b33.md](./ZC-DEEP-b33.md) |
| B34 | 12 | 1,504 | [ZC-DEEP-b34.md](./ZC-DEEP-b34.md) |
| B35 | 12 | 1,423 | [ZC-DEEP-b35.md](./ZC-DEEP-b35.md) |
| B36 | 12 | 1,383 | [ZC-DEEP-b36.md](./ZC-DEEP-b36.md) |
| B37 | 12 | 1,358 | [ZC-DEEP-b37.md](./ZC-DEEP-b37.md) |
| B38 | 12 | 1,312 | [ZC-DEEP-b38.md](./ZC-DEEP-b38.md) |
| B39 | 12 | 1,287 | [ZC-DEEP-b39.md](./ZC-DEEP-b39.md) |
| B40 | 12 | 1,277 | [ZC-DEEP-b40.md](./ZC-DEEP-b40.md) |
| B41 | 12 | 1,248 | [ZC-DEEP-b41.md](./ZC-DEEP-b41.md) |
| B42 | 12 | 1,230 | [ZC-DEEP-b42.md](./ZC-DEEP-b42.md) |
| B43 | 12 | 1,190 | [ZC-DEEP-b43.md](./ZC-DEEP-b43.md) |
| B44 | 12 | 1,184 | [ZC-DEEP-b44.md](./ZC-DEEP-b44.md) |
| B45 | 12 | 1,159 | [ZC-DEEP-b45.md](./ZC-DEEP-b45.md) |
| B46 | 12 | 1,127 | [ZC-DEEP-b46.md](./ZC-DEEP-b46.md) |
| B47 | 12 | 1,102 | [ZC-DEEP-b47.md](./ZC-DEEP-b47.md) |
| B48 | 12 | 1,090 | [ZC-DEEP-b48.md](./ZC-DEEP-b48.md) |
| B49 | 12 | 1,060 | [ZC-DEEP-b49.md](./ZC-DEEP-b49.md) |
| B50 | 12 | 1,033 | [ZC-DEEP-b50.md](./ZC-DEEP-b50.md) |
| B51 | 12 | 1,000 | [ZC-DEEP-b51.md](./ZC-DEEP-b51.md) |
| B52 | 12 | 987 | [ZC-DEEP-b52.md](./ZC-DEEP-b52.md) |
| B53 | 12 | 969 | [ZC-DEEP-b53.md](./ZC-DEEP-b53.md) |
| B54 | 12 | 1,039 | [ZC-DEEP-b54.md](./ZC-DEEP-b54.md) |
| B55 | 12 | 972 | [ZC-DEEP-b55.md](./ZC-DEEP-b55.md) |
| B56 | 12 | 926 | [ZC-DEEP-b56.md](./ZC-DEEP-b56.md) |
| B57 | 12 | 927 | [ZC-DEEP-b57.md](./ZC-DEEP-b57.md) |
| B58 | 12 | 901 | [ZC-DEEP-b58.md](./ZC-DEEP-b58.md) |
| B59 | 12 | 862 | [ZC-DEEP-b59.md](./ZC-DEEP-b59.md) |
| B60 | 12 | 859 | [ZC-DEEP-b60.md](./ZC-DEEP-b60.md) |
| B61 | 12 | 840 | [ZC-DEEP-b61.md](./ZC-DEEP-b61.md) |
| B62 | 12 | 821 | [ZC-DEEP-b62.md](./ZC-DEEP-b62.md) |
| B63 | 12 | 815 | [ZC-DEEP-b63.md](./ZC-DEEP-b63.md) |
| B64 | 12 | 807 | [ZC-DEEP-b64.md](./ZC-DEEP-b64.md) |
| B65 | 12 | 792 | [ZC-DEEP-b65.md](./ZC-DEEP-b65.md) |
| B66 | 12 | 787 | [ZC-DEEP-b66.md](./ZC-DEEP-b66.md) |
| B67 | 12 | 787 | [ZC-DEEP-b67.md](./ZC-DEEP-b67.md) |
| B68 | 12 | 769 | [ZC-DEEP-b68.md](./ZC-DEEP-b68.md) |
| B69 | 12 | 762 | [ZC-DEEP-b69.md](./ZC-DEEP-b69.md) |
| B70 | 12 | 753 | [ZC-DEEP-b70.md](./ZC-DEEP-b70.md) |
| B71 | 12 | 751 | [ZC-DEEP-b71.md](./ZC-DEEP-b71.md) |
| B72 | 12 | 739 | [ZC-DEEP-b72.md](./ZC-DEEP-b72.md) |
| B73 | 12 | 729 | [ZC-DEEP-b73.md](./ZC-DEEP-b73.md) |
| B74 | 12 | 729 | [ZC-DEEP-b74.md](./ZC-DEEP-b74.md) |
| B75 | 12 | 712 | [ZC-DEEP-b75.md](./ZC-DEEP-b75.md) |
| B76 | 6 | 358 | [ZC-DEEP-b76.md](./ZC-DEEP-b76.md) |
| B77 | 6 | 351 | [ZC-DEEP-b77.md](./ZC-DEEP-b77.md) |
| B78 | 6 | 351 | [ZC-DEEP-b78.md](./ZC-DEEP-b78.md) |
| B79 | 6 | 349 | [ZC-DEEP-b79.md](./ZC-DEEP-b79.md) |
| B80 | 6 | 344 | [ZC-DEEP-b80.md](./ZC-DEEP-b80.md) |
| B81 | 6 | 343 | [ZC-DEEP-b81.md](./ZC-DEEP-b81.md) |
| B82 | 6 | 339 | [ZC-DEEP-b82.md](./ZC-DEEP-b82.md) |
| B83 | 6 | 328 | [ZC-DEEP-b83.md](./ZC-DEEP-b83.md) |
| B84 | 6 | 331 | [ZC-DEEP-b84.md](./ZC-DEEP-b84.md) |
| B85 | 6 | 327 | [ZC-DEEP-b85.md](./ZC-DEEP-b85.md) |
| B86 | 6 | 337 | [ZC-DEEP-b86.md](./ZC-DEEP-b86.md) |
| B87 | 6 | 325 | [ZC-DEEP-b87.md](./ZC-DEEP-b87.md) |
| B88 | 6 | 319 | [ZC-DEEP-b88.md](./ZC-DEEP-b88.md) |
| B89 | 6 | 320 | [ZC-DEEP-b89.md](./ZC-DEEP-b89.md) |
| B90 | 6 | 319 | [ZC-DEEP-b90.md](./ZC-DEEP-b90.md) |
| B91 | 6 | 322 | [ZC-DEEP-b91.md](./ZC-DEEP-b91.md) |
| B92 | 6 | 314 | [ZC-DEEP-b92.md](./ZC-DEEP-b92.md) |
| B93 | 6 | 318 | [ZC-DEEP-b93.md](./ZC-DEEP-b93.md) |
| B94 | 6 | 314 | [ZC-DEEP-b94.md](./ZC-DEEP-b94.md) |
| B95 | 6 | 317 | [ZC-DEEP-b95.md](./ZC-DEEP-b95.md) |
| B96 | 6 | 302 | [ZC-DEEP-b96.md](./ZC-DEEP-b96.md) |
| B97 | 6 | 325 | [ZC-DEEP-b97.md](./ZC-DEEP-b97.md) |
| B98 | 6 | 306 | [ZC-DEEP-b98.md](./ZC-DEEP-b98.md) |
| B99 | 6 | 303 | [ZC-DEEP-b99.md](./ZC-DEEP-b99.md) |
| B100 | 6 | 295 | [ZC-DEEP-b100.md](./ZC-DEEP-b100.md) |
| B101 | 6 | 297 | [ZC-DEEP-b101.md](./ZC-DEEP-b101.md) |
| B102 | 6 | 303 | [ZC-DEEP-b102.md](./ZC-DEEP-b102.md) |
| B103 | 6 | 296 | [ZC-DEEP-b103.md](./ZC-DEEP-b103.md) |
| B104 | 6 | 292 | [ZC-DEEP-b104.md](./ZC-DEEP-b104.md) |
| B105 | 6 | 283 | [ZC-DEEP-b105.md](./ZC-DEEP-b105.md) |
| B106 | 6 | 284 | [ZC-DEEP-b106.md](./ZC-DEEP-b106.md) |
| B107 | 6 | 285 | [ZC-DEEP-b107.md](./ZC-DEEP-b107.md) |
| B108 | 6 | 285 | [ZC-DEEP-b108.md](./ZC-DEEP-b108.md) |
| B109 | 6 | 276 | [ZC-DEEP-b109.md](./ZC-DEEP-b109.md) |
| B110 | 6 | 276 | [ZC-DEEP-b110.md](./ZC-DEEP-b110.md) |
| B111 | 6 | 273 | [ZC-DEEP-b111.md](./ZC-DEEP-b111.md) |
| B112 | 6 | 281 | [ZC-DEEP-b112.md](./ZC-DEEP-b112.md) |
| B113 | 6 | 294 | [ZC-DEEP-b113.md](./ZC-DEEP-b113.md) |
| B114 | 6 | 270 | [ZC-DEEP-b114.md](./ZC-DEEP-b114.md) |
| B115 | 6 | 274 | [ZC-DEEP-b115.md](./ZC-DEEP-b115.md) |
| B116 | 6 | 271 | [ZC-DEEP-b116.md](./ZC-DEEP-b116.md) |
| B117 | 6 | 297 | [ZC-DEEP-b117.md](./ZC-DEEP-b117.md) |
| B118 | 6 | 263 | [ZC-DEEP-b118.md](./ZC-DEEP-b118.md) |
| B119 | 6 | 263 | [ZC-DEEP-b119.md](./ZC-DEEP-b119.md) |
| B120a | 4 | 192 | [ZC-DEEP-b120a.md](./ZC-DEEP-b120a.md) |
| B120b | 2 | 85 | [ZC-DEEP-b120b.md](./ZC-DEEP-b120b.md) |
| B121 | 4 | 176 | [ZC-DEEP-b121.md](./ZC-DEEP-b121.md) |
| B122 | 4 | 171 | [ZC-DEEP-b122.md](./ZC-DEEP-b122.md) |
| B123 | 4 | 173 | [ZC-DEEP-b123.md](./ZC-DEEP-b123.md) |
| B124 | 4 | 169 | [ZC-DEEP-b124.md](./ZC-DEEP-b124.md) |
| B125 | 4 | 177 | [ZC-DEEP-b125.md](./ZC-DEEP-b125.md) |
| B126 | 4 | 171 | [ZC-DEEP-b126.md](./ZC-DEEP-b126.md) |
| B127 | 4 | 184 | [ZC-DEEP-b127.md](./ZC-DEEP-b127.md) |
| B128 | 4 | 173 | [ZC-DEEP-b128.md](./ZC-DEEP-b128.md) |
| B129 | 4 | 170 | [ZC-DEEP-b129.md](./ZC-DEEP-b129.md) |
| B130 | 4 | 176 | [ZC-DEEP-b130.md](./ZC-DEEP-b130.md) |
| B131 | 4 | 174 | [ZC-DEEP-b131.md](./ZC-DEEP-b131.md) |
| B132 | 4 | 168 | [ZC-DEEP-b132.md](./ZC-DEEP-b132.md) |
| B133 | 3 | 130 | [ZC-DEEP-b133.md](./ZC-DEEP-b133.md) |
| B134 | 3 | 121 | [ZC-DEEP-b134.md](./ZC-DEEP-b134.md) |
| B135 | 3 | 120 | [ZC-DEEP-b135.md](./ZC-DEEP-b135.md) |
| B136 | 4 | 165 | [ZC-DEEP-b136.md](./ZC-DEEP-b136.md) |
| B137 | 4 | 170 | [ZC-DEEP-b137.md](./ZC-DEEP-b137.md) |
| B138 | 4 | 177 | [ZC-DEEP-b138.md](./ZC-DEEP-b138.md) |
| B139 | 4 | 191 | [ZC-DEEP-b139.md](./ZC-DEEP-b139.md) |
| B140 | 4 | 161 | [ZC-DEEP-b140.md](./ZC-DEEP-b140.md) |
| B141 | 4 | 163 | [ZC-DEEP-b141.md](./ZC-DEEP-b141.md) |
| B142 | 4 | 167 | [ZC-DEEP-b142.md](./ZC-DEEP-b142.md) |
| B143 | 4 | 162 | [ZC-DEEP-b143.md](./ZC-DEEP-b143.md) |
| B144 | 4 | 165 | [ZC-DEEP-b144.md](./ZC-DEEP-b144.md) |
| B145 | 4 | 156 | [ZC-DEEP-b145.md](./ZC-DEEP-b145.md) |
| B146 | 4 | 163 | [ZC-DEEP-b146.md](./ZC-DEEP-b146.md) |
| B147 | 4 | 158 | [ZC-DEEP-b147.md](./ZC-DEEP-b147.md) |
| B148 | 4 | 158 | [ZC-DEEP-b148.md](./ZC-DEEP-b148.md) |
| B149 | 4 | 157 | [ZC-DEEP-b149.md](./ZC-DEEP-b149.md) |
| B150 | 4 | 160 | [ZC-DEEP-b150.md](./ZC-DEEP-b150.md) |
| B151 | 1 | 55 | [ZC-DEEP-b151.md](./ZC-DEEP-b151.md) |
| B152 | 4 | 162 | [ZC-DEEP-b152.md](./ZC-DEEP-b152.md) |
| B153 | 4 | 157 | [ZC-DEEP-b153.md](./ZC-DEEP-b153.md) |
| B154 | 4 | 155 | [ZC-DEEP-b154.md](./ZC-DEEP-b154.md) |
| B155 | 4 | 152 | [ZC-DEEP-b155.md](./ZC-DEEP-b155.md) |
| B156 | 4 | 155 | [ZC-DEEP-b156.md](./ZC-DEEP-b156.md) |
| B157 | 4 | 163 | [ZC-DEEP-b157.md](./ZC-DEEP-b157.md) |
| B158 | 4 | 154 | [ZC-DEEP-b158.md](./ZC-DEEP-b158.md) |
| B159 | 4 | 151 | [ZC-DEEP-b159.md](./ZC-DEEP-b159.md) |
| B160 | 4 | 150 | [ZC-DEEP-b160.md](./ZC-DEEP-b160.md) |
| B161 | 4 | 154 | [ZC-DEEP-b161.md](./ZC-DEEP-b161.md) |
| B162 | 4 | 147 | [ZC-DEEP-b162.md](./ZC-DEEP-b162.md) |
| B163 | 4 | 153 | [ZC-DEEP-b163.md](./ZC-DEEP-b163.md) |
| B164 | 4 | 149 | [ZC-DEEP-b164.md](./ZC-DEEP-b164.md) |
| B165 | 4 | 146 | [ZC-DEEP-b165.md](./ZC-DEEP-b165.md) |
| B166 | 4 | 147 | [ZC-DEEP-b166.md](./ZC-DEEP-b166.md) |
| B167 | 4 | 152 | [ZC-DEEP-b167.md](./ZC-DEEP-b167.md) |
| B168 | 4 | 155 | [ZC-DEEP-b168.md](./ZC-DEEP-b168.md) |
| B169 | 4 | 154 | [ZC-DEEP-b169.md](./ZC-DEEP-b169.md) |
| B170 | 4 | 142 | [ZC-DEEP-b170.md](./ZC-DEEP-b170.md) |
| B171 | 4 | 142 | [ZC-DEEP-b171.md](./ZC-DEEP-b171.md) |
| B172 | 4 | 147 | [ZC-DEEP-b172.md](./ZC-DEEP-b172.md) |
| B173 | 4 | 143 | [ZC-DEEP-b173.md](./ZC-DEEP-b173.md) |
| B174 | 4 | 145 | [ZC-DEEP-b174.md](./ZC-DEEP-b174.md) |
| B175 | 4 | 138 | [ZC-DEEP-b175.md](./ZC-DEEP-b175.md) |
| B176 | 4 | 139 | [ZC-DEEP-b176.md](./ZC-DEEP-b176.md) |
| B177 | 4 | 139 | [ZC-DEEP-b177.md](./ZC-DEEP-b177.md) |
| B178 | 4 | 140 | [ZC-DEEP-b178.md](./ZC-DEEP-b178.md) |
| B179 | 4 | 137 | [ZC-DEEP-b179.md](./ZC-DEEP-b179.md) |
| B180 | 4 | 137 | [ZC-DEEP-b180.md](./ZC-DEEP-b180.md) |
| B181 | 4 | 138 | [ZC-DEEP-b181.md](./ZC-DEEP-b181.md) |
| B182 | 4 | 138 | [ZC-DEEP-b182.md](./ZC-DEEP-b182.md) |
| B183 | 4 | 131 | [ZC-DEEP-b183.md](./ZC-DEEP-b183.md) |
| B184 | 4 | 139 | [ZC-DEEP-b184.md](./ZC-DEEP-b184.md) |
| B185 | 4 | 132 | [ZC-DEEP-b185.md](./ZC-DEEP-b185.md) |
| B186 | 4 | 136 | [ZC-DEEP-b186.md](./ZC-DEEP-b186.md) |
| B187 | 4 | 138 | [ZC-DEEP-b187.md](./ZC-DEEP-b187.md) |
| B188 | 4 | 134 | [ZC-DEEP-b188.md](./ZC-DEEP-b188.md) |
| B189 | 4 | 133 | [ZC-DEEP-b189.md](./ZC-DEEP-b189.md) |
| B190 | 4 | 133 | [ZC-DEEP-b190.md](./ZC-DEEP-b190.md) |
| B191 | 4 | 129 | [ZC-DEEP-b191.md](./ZC-DEEP-b191.md) |
| B192 | 4 | 129 | [ZC-DEEP-b192.md](./ZC-DEEP-b192.md) |
| B193 | 4 | 132 | [ZC-DEEP-b193.md](./ZC-DEEP-b193.md) |
| B194 | 4 | 128 | [ZC-DEEP-b194.md](./ZC-DEEP-b194.md) |
| B195 | 4 | 130 | [ZC-DEEP-b195.md](./ZC-DEEP-b195.md) |
| B196 | 4 | 130 | [ZC-DEEP-b196.md](./ZC-DEEP-b196.md) |
| B197 | 4 | 130 | [ZC-DEEP-b197.md](./ZC-DEEP-b197.md) |
| B198 | 4 | 132 | [ZC-DEEP-b198.md](./ZC-DEEP-b198.md) |
| B199 | 4 | 128 | [ZC-DEEP-b199.md](./ZC-DEEP-b199.md) |
| B200 | 4 | 125 | [ZC-DEEP-b200.md](./ZC-DEEP-b200.md) |
| B201 | 4 | 125 | [ZC-DEEP-b201.md](./ZC-DEEP-b201.md) |
| B202 | 4 | 126 | [ZC-DEEP-b202.md](./ZC-DEEP-b202.md) |
| B203 | 4 | 127 | [ZC-DEEP-b203.md](./ZC-DEEP-b203.md) |
| B204 | 4 | 129 | [ZC-DEEP-b204.md](./ZC-DEEP-b204.md) |
| B205 | 4 | 124 | [ZC-DEEP-b205.md](./ZC-DEEP-b205.md) |
| B206 | 4 | 123 | [ZC-DEEP-b206.md](./ZC-DEEP-b206.md) |
| B207 | 4 | 120 | [ZC-DEEP-b207.md](./ZC-DEEP-b207.md) |
| B208 | 4 | 121 | [ZC-DEEP-b208.md](./ZC-DEEP-b208.md) |
| B209 | 4 | 120 | [ZC-DEEP-b209.md](./ZC-DEEP-b209.md) |
| B210 | 4 | 120 | [ZC-DEEP-b210.md](./ZC-DEEP-b210.md) |
| B211 | 4 | 122 | [ZC-DEEP-b211.md](./ZC-DEEP-b211.md) |
| B212 | 4 | 120 | [ZC-DEEP-b212.md](./ZC-DEEP-b212.md) |
| B213 | 4 | 120 | [ZC-DEEP-b213.md](./ZC-DEEP-b213.md) |
| B214 | 4 | 120 | [ZC-DEEP-b214.md](./ZC-DEEP-b214.md) |
| B215 | 4 | 120 | [ZC-DEEP-b215.md](./ZC-DEEP-b215.md) |
| B216 | 4 | 120 | [ZC-DEEP-b216.md](./ZC-DEEP-b216.md) |
| B217 | 4 | 120 | [ZC-DEEP-b217.md](./ZC-DEEP-b217.md) |
| B218 | 4 | 120 | [ZC-DEEP-b218.md](./ZC-DEEP-b218.md) |
| B219 | 4 | 120 | [ZC-DEEP-b219.md](./ZC-DEEP-b219.md) |
| B220 | 4 | 120 | [ZC-DEEP-b220.md](./ZC-DEEP-b220.md) |
| B221 | 4 | 120 | [ZC-DEEP-b221.md](./ZC-DEEP-b221.md) |
| B222 | 4 | 120 | [ZC-DEEP-b222.md](./ZC-DEEP-b222.md) |
| B223 | 4 | 120 | [ZC-DEEP-b223.md](./ZC-DEEP-b223.md) |
| B224 | 4 | 120 | [ZC-DEEP-b224.md](./ZC-DEEP-b224.md) |
| B225 | 4 | 120 | [ZC-DEEP-b225.md](./ZC-DEEP-b225.md) |
| B226 | 4 | 120 | [ZC-DEEP-b226.md](./ZC-DEEP-b226.md) |
| **合计** | **1,410** | **127,929** | — |

所有批次均满足：`deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`，
且逐文件密度 ≥ 30%（最低 30.30%，最高 42.48%）。

> B16 行含开工 B17 前对 `taskRealtimeBus.ts` 的 +10 行补厚（30.00% → 31.03%），
> 避免贴线；该 10 行计入 B16 累计（2,194 → 2,204）。

## 3. 完成度（当前实测口径）

以 `d:\code\_annot_baseline\zc-measure.mjs`（与 `deep-density.mjs --mode code --threshold 30 --ext .ts,.tsx`
逐字符同口径）对当前工作树实测，可随时复跑复核：

```powershell
node zc-measure.mjs --out ZC-measure-all.json
# SUMMARY files=5032 coreBelow30=1818 needLines=25148 min=0.00 median=31.36
```

按范围拆分（同一份 `ZC-measure-all.json`）：

| 口径 | 文件数 | `coreBelow30` | `needLines` |
| --- | ---: | ---: | ---: |
| 全仓 | 5,032 | 1,818 | 25,148 |
| `packages/services`（另一会话） | 466 | 0 | 0 |
| 4 个 L0 i18n 字典（不计密度） | 4 | 4 | 4,592 |
| **本会话 core/apps 范围（排除以上）** | **4,562** | **1,814** | **20,556** |

| 指标 | 2026-11-06 基线 | 当前实测 | 剩余 |
| --- | ---: | ---: | ---: |
| 文件数（本会话范围） | 4,562 | 4,562 | 0 |
| `coreBelow30` | 3,224 | 1,814 | **1,814** |
| `needLines` | 141,590 | 20,556 | **20,556** |
| 完成度（按缺口行） | — | — | **85.5%** |

口径差异说明（旧表 3,566 / 28,573 的来源）：

- 旧「剩余文件 3,566」= 4,562 − 996（**已注释**文件数），把基线里本来就 ≥30% 的 1,406 个文件
  也算成待办，属概念错位。正确剩余 = 基线 3,224 − 已完成 1,410 = **1,814**，与实测一致。
- 旧「剩余行 28,573」= 141,590 − 113,017 的**线性推导**，默认新增行全部抵扣缺口。
  实际每文件按 31%~32% 落点，超出 30% 的 1%~2% 不抵扣其他文件；叠加并发开发新增代码，
  实测缺口 **20,556**，高于线性推导值。此后一律以实测值为准，不再用减法推导。
- 全仓与范围的差：文件 4 = L0 字典 4（services 已清零）；行数 4,592 = L0 字典。

> 以下为历史复扫记录，均为**全仓口径**（含 services 与 4 个 L0 字典），仅供趋势比对：
>
> B44 开工前扫描为
> `files=5032 coreBelow30=3306 needLines=99491 median=14.57`。
> B101 开工前复扫（同一口径）：`files=5032 coreBelow30=2357 needLines=44630 median=30.92`。
> B102 开工前复扫（机器重启后重测，同一口径）：`files=5032 coreBelow30=2351 needLines=44352 median=30.95`。
> B105 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2327 needLines=43245 median=31.11`。
> B109 开工前全仓复扫（机器重启后重测，同一口径）：`files=5032 coreBelow30=2309 needLines=42439 median=31.15`。
> B113 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2279 needLines=41128 median=31.19`。
> B114 开工前全仓复扫（机器重启后重测，同一口径）：`files=5032 coreBelow30=2279 needLines=41128 median=31.19`。
> B115 开工前全仓复扫（同一口径）：`files=5032 coreBelow30=2273 needLines=40870 median=31.21`。
> B116 开工前全仓复扫（同一口径）：`files=5032 coreBelow30=2267 needLines=40612 median=31.21`。
> B117 开工前全仓复扫（机器重启后重测，同一口径）：`files=5032 coreBelow30=2261 needLines=40354 median=31.22`。
> B118 开工前全仓复扫（机器重启后重测，同一口径）：`files=5032 coreBelow30=2255 needLines=40096 median=31.22`。
> B119 开工前全仓复扫（同一口径）：`files=5032 coreBelow30=2249 needLines=39842 median=31.22`。
> B120a 开工前全仓复扫（同一口径）：`files=5032 coreBelow30=2243 needLines=39589 min=0.00 median=31.22`。
> B124 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2220 needLines=38665 min=0.00 median=31.23`。
> B125 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2216 needLines=38499 min=0.00 median=31.25`。
> B126 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2212 needLines=38335 min=0.00 median=31.25`。
> B127 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2208 needLines=38174 min=0.00 median=31.25`。
> B128 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2204 needLines=38013 min=0.00 median=31.25`。
> B129 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2200 needLines=37852 min=0.00 median=31.25`。
> B130 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2196 needLines=37692 min=0.00 median=31.25`。
> B131 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2192 needLines=37529 min=0.00 median=31.25`。
> B132 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2188 needLines=37369 min=0.00 median=31.25`。
> B133 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2185 needLines=37249 min=0.00 median=31.25`。
> B134 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2182 needLines=37131 min=0.00 median=31.25`。
> B135 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2179 needLines=37014 min=0.00 median=31.25`。
> B136 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2175 needLines=36858 min=0.00 median=31.25`。
> B137 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2171 needLines=36702 min=0.00 median=31.25`。
> B138 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2167 needLines=36541 min=0.00 median=31.25`。
> B139 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2163 needLines=36385 min=0.00 median=31.26`。
> B140 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2159 needLines=36229 min=0.00 median=31.27`。
> B141 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2155 needLines=36073 min=0.00 median=31.27`。
> B142 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2151 needLines=35921 min=0.00 median=31.27`。
> B143 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2147 needLines=35768 min=0.00 median=31.27`。
> B144 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2143 needLines=35616 min=0.00 median=31.28`。
> B145 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2139 needLines=35464 min=0.00 median=31.28`。
> B146 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2135 needLines=35312 min=0.00 median=31.28`。
> B147 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2131 needLines=35160 min=0.00 median=31.28`。
> B148 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2127 needLines=35008 min=0.00 median=31.28`。
> B149 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2123 needLines=34856 min=0.00 median=31.28`。
> B150 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2119 needLines=34705 min=0.00 median=31.28`。
> B151 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2118 needLines=34665 min=0.00 median=31.28`。
> B152 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2114 needLines=34517 min=0.00 median=31.28`。
> B153 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2110 needLines=34369 min=0.00 median=31.28`。
> B154 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2106 needLines=34221 min=0.00 median=31.28`。
> B155 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2102 needLines=34073 min=0.00 median=31.28`。
> B156 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2098 needLines=33926 min=0.00 median=31.29`。
> B157 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2094 needLines=33782 min=0.00 median=31.29`。
> B158 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2090 needLines=33638 min=0.00 median=31.29`。
> B159 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2086 needLines=33494 min=0.00 median=31.29`。
> B160 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2082 needLines=33350 min=0.00 median=31.29`。
> B161 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2078 needLines=33207 min=0.00 median=31.30`。
> B162 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2074 needLines=33067 min=0.00 median=31.30`。
> B163 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2070 needLines=32927 min=0.00 median=31.30`。
> B164 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2066 needLines=32787 min=0.00 median=31.30`。
> B165 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2062 needLines=32647 min=0.00 median=31.30`。
> B166 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2058 needLines=32507 min=0.00 median=31.30`。
> B167 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2054 needLines=32367 min=0.00 median=31.30`。
> B168 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2050 needLines=32231 min=0.00 median=31.30`。
> B169 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2046 needLines=32094 min=0.00 median=31.30`。
> B170 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2042 needLines=31958 min=0.00 median=31.30`。
> B171 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2038 needLines=31822 min=0.00 median=31.31`。
> B172 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2034 needLines=31689 min=0.00 median=31.31`。
> B173 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2030 needLines=31555 min=0.00 median=31.31`。
> B174 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2026 needLines=31421 min=0.00 median=31.31`。
> B175 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2022 needLines=31289 min=0.00 median=31.31`。
> B176 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2018 needLines=31155 min=0.00 median=31.31`。
> B177 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2014 needLines=31022 min=0.00 median=31.31`。
> B178 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2010 needLines=30889 min=0.00 median=31.31`。
> B179 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2006 needLines=30756 min=0.00 median=31.31`。
> B180 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=2002 needLines=30624 min=0.00 median=31.32`。
> B181 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1998 needLines=30492 min=0.00 median=31.32`。
> B182 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1994 needLines=30361 min=0.00 median=31.32`。
> B183 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1990 needLines=30233 min=0.00 median=31.32`。
> B184 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1986 needLines=30105 min=0.00 median=31.32`。
> B185 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1982 needLines=29977 min=0.00 median=31.32`。
> B186 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1978 needLines=29849 min=0.00 median=31.32`。
> B187 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1974 needLines=29719 min=0.00 median=31.32`。
> B188 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1970 needLines=29591 min=0.00 median=31.33`。
> B189 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1966 needLines=29463 min=0.00 median=31.33`。
> B190 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1962 needLines=29338 min=0.00 median=31.33`。
> B191 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1958 needLines=29214 min=0.00 median=31.33`。
> B192 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1954 needLines=29090 min=0.00 median=31.33`。
> B193 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1950 needLines=28966 min=0.00 median=31.33`。
> B194 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1946 needLines=28842 min=0.00 median=31.33`。
> B195 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1942 needLines=28718 min=0.00 median=31.33`。
> B196 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1938 needLines=28594 min=0.00 median=31.33`。
> B197 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1934 needLines=28472 min=0.00 median=31.33`。
> B198 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1930 needLines=28352 min=0.00 median=31.33`。
> B199 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1926 needLines=28232 min=0.00 median=31.33`。
> B200 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1922 needLines=28112 min=0.00 median=31.34`。
> B201 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1918 needLines=27992 min=0.00 median=31.34`。
> B202 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1914 needLines=27872 min=0.00 median=31.34`。
> B203 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1910 needLines=27752 min=0.00 median=31.34`。
> B204 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1906 needLines=27634 min=0.00 median=31.34`。
> B205 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1902 needLines=27518 min=0.00 median=31.34`。
> B206 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1898 needLines=27402 min=0.00 median=31.34`。
> B207 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1894 needLines=27286 min=0.00 median=31.34`。
> B208 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1890 needLines=27170 min=0.00 median=31.34`。
> B209 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1886 needLines=27054 min=0.00 median=31.34`。
> B210 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1882 needLines=26938 min=0.00 median=31.34`。
> B211 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1878 needLines=26822 min=0.00 median=31.34`。
> B212 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1874 needLines=26706 min=0.00 median=31.34`。
> B213 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1870 needLines=26590 min=0.00 median=31.34`。
> B214 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1866 needLines=26474 min=0.00 median=31.34`。
> B215 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1862 needLines=26361 min=0.00 median=31.35`。
> B216 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1858 needLines=26249 min=0.00 median=31.35`。
> B217 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1854 needLines=26137 min=0.00 median=31.35`。
> B218 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1850 needLines=26025 min=0.00 median=31.35`。
> B219 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1846 needLines=25913 min=0.00 median=31.35`。
> B220 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1842 needLines=25801 min=0.00 median=31.35`。
> B221 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1838 needLines=25689 min=0.00 median=31.35`。
> B222 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1834 needLines=25580 min=0.00 median=31.35`。
> B223 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1830 needLines=25472 min=0.00 median=31.35`。
> B224 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1826 needLines=25364 min=0.00 median=31.35`。
> B225 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1822 needLines=25256 min=0.00 median=31.36`。
> B226 完成后全仓复扫（同一口径）：`files=5032 coreBelow30=1818 needLines=25148 min=0.00 median=31.36`。

## 4. 约定与已知边界

- 只新增 `//` 整行注释：不删行、不改 token/缩进/import 顺序/字符串，不改写既有注释。
- 文件头统一放 INV 不变量表，每条注明「守住它的位置」，并写清「改错了会出现什么故障」。
- 关键分支使用 `[并发]` / `[事务]` / `[资源]` / `[失败路径]` / `[权衡]` 标记。
- `packages/ui/src/i18n/locales/*`、`apps/zcode-cli/packages/i18n/src/locales/*` 为逐字字典，
  按母本 L0 处理：只要求文件头一行说明来源，不计入 30% 分母。
- 批次内被其他会话改动的文件按计划 5.4 剔除并在该批索引的「顺延」中记录。

### 范围声明与总账断言

- scope：`packages/**`（排除 `packages/services` 与 4 个 L0 字典）+ `apps/**` + `docs/**` + `scripts/**`，共 **4,562** 个生产文件。
- excluded：`packages/services/**` 466 + `.agents/**` 83 + `vitest.config.ts`/`vitest.setup.ts` 2 + 4 个 L0 字典 = **555**。
- 断言：`scopeFiles + excludedFiles = 全仓源码数` → **4,562 + 555 = 5,117**（磁盘 `.ts/.tsx`，跳过
  `node_modules/dist/build/out/coverage/target/.turbo/.tmp` 与测试/夹具/生成物/`.d.ts`）。
- 复核命令：`node d:\code\_annot_baseline\ledger-check.mjs zcode`；不平则以非零码退出并打印差额。当前 **PASS**。
- 注意：密度分母是 **5,032**，因为 `zc-measure.mjs` 的 ROOTS 只含 `apps/packages/scripts/docs`；
  差出的 85 个（`.agents/**` 83 + 根 `vitest.*` 2）已显式列入 excluded，不再是隐身文件。

### 4.1 踩坑记录

- **`deep-quality.mjs --uncovered <path>` 的 `<path>` 是输出文件，不是筛选条件。**
  误把源文件路径传进去，工具会把源文件覆盖成「未覆盖单元清单」（本次 `registry-service.ts` 379 行 → 164 行）。
  查看未覆盖单元时应先把输出写到临时文件，再读该文件，绝不能直接传源路径。
- **`unit` / `field` 是两个集合，定义只在 DEEP-SPEC，本仓不另写实现。**
  unit（覆盖单元）= 一行一个可解释点：类型成员、形参、语句行、对象字面量成员、模块常量。
  field（字段覆盖）= 只算类型层字段：`interface` 体、`type` 字面量、`class` 体里的成员；形参、对象字面量成员、
  调用实参、运行期属性一律不进 field。field 是窄指标（「类型契约的解释度」），不能当文件完整性达标的证据。
  已核：`scanTypeMemberLines` 全仓只有一份实现，在 `d:\code\_annot_baseline\deep-quality.mjs:346`
  （调用点 `:827`），本仓与 claude-code-main 共用，**集合不可能分叉**；本仓没有 `--field-mode` 的独立实现。
  定义原文见 `d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` §4.1.1，
  claude-code-main 侧见 `docs/annotation/README-rework.md` §1.6。
- **恢复必须从批次快照 `_annot_baseline/<batch>/orig/<rel>` 原样复制，禁止凭上下文重打。**
  重打的风险是语义等价但字面不同（空格、引号风格、数字写法）会生成成对 `-`/`+`；
  漏行还会连带制造更多删除。正确做法：
  `Copy-Item <batch>\orig\<rel> <repo>\<rel> -Force`，随后必须同时跑
  `check-code-tokens.mjs <repo> <files> <orig>`（要求 `codeTokenDiff=0`）与
  `validate-ts.mjs <repo> <files> <orig>`（要求 `syntaxFailed=0`），两条都过才算干净。
- 本次事故最终按上下文重打恢复，复验 `codeTokenDiff=0`、`syntaxFailed=0`、`git diff` 为纯注释新增（+45 / 0 删除）；
  结果虽对，流程仍记为违规，后续一律走快照复制。

## 5. 下一步

> 当前暂停扩批，先做注释质量改写（见 5.1）。恢复后再按缺口降序继续 **B227** 及后续批次，每批 **4 个文件**（同类、同目录优先，避免跨模块拼批；
> 单轮步数预算紧张时可拆成 a/b 子批，宁可多批也不要被截断），密度不再设硬门槛，按「内容优先」执行。
> 每批完成后新增 `ZC-DEEP-bN.md` 并回填本表。下一批文件清单由
> `d:\code\_annot_baseline\zc-next-batches.mjs` 基于当前工作树复算。

## 5.1 注释质量改写（单独记账）

> 判据：连续 ≥3 行、每行 <25 字符、且不含任何标识符的「短句三连」。扫描工具 `_annot_baseline\qc-poem-audit.mjs`。
> 命中总量：**1,830 处 / 7,399 行 / 514 文件**（B204–B226 为 0）。

| 改写批 | 文件数 | `rewrittenSegments` | `deletedOwnCommentLines` | `codeTokenDiff` | 索引 |
| --- | ---: | ---: | ---: | ---: | --- |
| FIX-B1（工具验证） | 1 | 4 | 21 | 0 | [ZC-fix-b1.md](./ZC-fix-b1.md) |
| FIX-B2（B29 第 1 个文件） | 1 | 15 | 58 | 0 | [ZC-fix-b2.md](./ZC-fix-b2.md) |
| FIX-B3（B29 剩余 4 文件） | 4 | 52 | 173 | 0 | [ZC-fix-b3.md](./ZC-fix-b3.md) |
| FIX-B108 | 6 | 35 | 138 | 0 | [ZC-fix-b108.md](./ZC-fix-b108.md) |
| FIX-B83 | 6 | 35 | 191 | 0 | [ZC-fix-b83.md](./ZC-fix-b83.md) |
| FIX-B105 | 6 | 33 | 132 | 0 | [ZC-fix-b105.md](./ZC-fix-b105.md) |
| FIX-B111 | 6 | 30 | 141 | 0 | [ZC-fix-b111.md](./ZC-fix-b111.md) |
| FIX-B112 | 6 | 29 | 144 | 0 | [ZC-fix-b112.md](./ZC-fix-b112.md) |
| FIX-B85 | 6 | 36 | 195 | 0 | [ZC-fix-b85.md](./ZC-fix-b85.md) |
| FIX-B110 | 6 | 30 | 144 | 0 | [ZC-fix-b110.md](./ZC-fix-b110.md) |
| FIX-B113 | 6 | 29 | 133 | 0 | [ZC-fix-b113.md](./ZC-fix-b113.md) |
| FIX-B114 | 6 | 37 | 143 | 0 | [ZC-fix-b114.md](./ZC-fix-b114.md) |
| FIX-B115 | 4 | 94 | 132 | 0 | [ZC-fix-b115.md](./ZC-fix-b115.md) |
| FIX-B116 | 4 | 23 | 108 | 0 | [ZC-fix-b116.md](./ZC-fix-b116.md) |
| FIX-B117 | 4 | 29 | 130 | 0 | [ZC-fix-b117.md](./ZC-fix-b117.md) |
| FIX-B118（JSX 文本 bug） | 120 | 319 | 891 | 0 | [ZC-fix-b118-jsx-text.md](./ZC-fix-b118-jsx-text.md) |
| FIX-B119～B124（单文件连批） | 6 | 39 | 189 | 0 | [ZC-fix-b119-b124.md](./ZC-fix-b119-b124.md) |
| FIX-B125（段落级判为误报） | 1 | 0 | 0（106 命中→0） | 0 | [ZC-fix-b125.md](./ZC-fix-b125.md) |
| FIX-B126～B128（清理第 1 批） | 4 | 26 | 58 | 0 | [ZC-fix-b126-b128.md](./ZC-fix-b126-b128.md) |
| FIX-B129（安全边界补深） | 1 | 0 | 152 | 0 | [ZC-fix-b129.md](./ZC-fix-b129.md) |
| FIX-B130（覆盖度补深第 1 批） | 5 | 2 | 144 | 0 | [ZC-fix-b130.md](./ZC-fix-b130.md) |

> FIX-B114 上回合被截断：清单 6 文件，实际落盘 2 文件（37 段 / −143 行），
> 另 4 文件未改动，连同命中数顺延到 FIX-B115。复跑时修掉 1 处越界删除（上游注释已原样恢复）。
> FIX-B115 处理完这 4 个顺延文件（94 段 / −132 行），首轮有 1 处把上游 `Bugfix:` 注释续行误判为新增行，
> 已原样恢复；恢复后残留的 1 条 `W` 属上游注释，不计入缺口。
>
> 新增验收口径：**内文率** = 函数体内部中文注释行 ÷ 函数体内部代码行（`zc-inner.mjs`）。
> 本批后全仓 `innerZh/innerCode = 80,011 / 461,886 = 17.32%`，中位 8.45%，低于 15% 的文件 2,132 个；
> B115 四个文件分别为 24.15% / 14.16% / 4.92% / 3.14%。清注水与补深都按内文率看效果，密度只作参考。
>
> FIX-B116 起改为「先装门禁、再清存量」：插入侧与清理侧共用 `zc-gate.mjs` 一套判据
> （poem run + `weaklines` 的 W/L/B），`zc-insert.mjs` 落盘前自检，命中即整批不落盘；
> 验收双指标并列：**内文率** + **注水率 < 1%**（`waterLines ÷ addedCommentLines`）。
> 本批 4 文件 23 段 / −108 行，`waterRate=0.00%`，内文率 13.74% / 2.40% / 0.00% / 12.33%。
> 另修正统计口径：`qc-poem-audit` 按批次快照累加会把跨批次文件重复计数（如 b120 与 b120a），
> 后续存量以 `zc-gate.mjs --scan` 的去重文件集合为准。
>
> 去重重扫（1,396 文件命中）：严格口径 `waterLines=22,227 / addedCommentLines=127,447 = 17.44%`；
> 分档 `class1=7,272`（真注水）/ `class2=14,671`（可增强）/ `class3=284`（误判，保留）；
> 修复队列 `workLines=21,943`。阶段分布按去重口径为 B1-120 16,582 / B121-180 4,051 / B181+ 1,594。
>
> FIX-B117 修正队列排序：`c1+c2` 头部 4 文件（`zcode-protocol/index.ts` 等）实测 `POEM=0 B=0`，
> 命中全是多行注释折行的 `L/W` 误报，块级复核后推翻。全仓 kind 分布为
> `POEM=5,950 / B=144 / W=10,025 / L=6,108`，故排序改为 **POEM+B 降序**，产物 `zc-work-queue-poem.txt`
> （原 `zc-work-queue.txt` 保留）。本批 4 文件 29 段 / −130 行 / +61 行，`waterRate=0.00%`，
> 三档为 c1 99 行 + JSX 文本 bug 16 行 + c2 8 行 / c3 0 行；内文率 26.42% / 7.43% / 4.29% / 5.41%。
>
> FIX-B118 是对「JSX 文本 bug」的跨仓库全量清算（`zx-jsx-comment.mjs`，AST 判定，
> `JsxText` 内以 `//` 开头的行即命中）：ZCode **891 行 / 120 文件**、gemini-cli **164 行 / 47 文件**；
> claude-code、mobx 为 0。ZCode 全部命中都是相对 HEAD 的新增行，涉及 65 个历史批次
> （`ZC-deep-b16` 84、`b15b` 64、`b57` 40 …），即**这些批次当初把注释插进了 JSX 渲染位**，
> 该注释会作为页面文本显示。已按文件聚合删除（`ZC-fix-b118`，891 行 / `rewrittenSegments=319`，
> `codeTokenDiff=0`、`codeDeletion=0`、`syntaxErrorFiles=0`），复扫 A 类归零；
> 删除前后 `waterRate` 18.80% → 17.44%（仅 291 行被注水判据命中，其余 600 行内容合格但位置错误）。
> 这 891 行属 bug 修复，不计入清注水业绩。gemini-cli 只出清单未改代码；B 类 `{// ...}` 四仓库均为 0。
> 归因是**位置错误而非注水**：891 行里仅 291 行被水率判据命中，其余 600 行内容合格、只是被放进 JSX
> children（插入脚本只按"最近的代码行"选锚点，未校验位置）。根因防线已并进 `zc-gate.mjs`：
> 新增行命中 `JsxText` 即整批不落盘；负向验证 `exit=1` 且文件未写盘，规范母本 `DEEP-SPEC.md`
> §5 已加第 7 条硬约束（插入点必须在语句/声明之前，不得落在 JSX 子节点、字符串、模板字面量内部）。
>
> FIX-B119～B124 恢复按 `zc-work-queue-poem.txt` 的 POEM+B 降序单文件推进（6 文件、39 段 / −189 行），
> 全部 `waterRate=0.00%`、`codeTokenDiff=0`。其中 5 个队列条目（`RootWorkspaceContent.tsx`、
> `virtualized-top-level-list.tsx`、`StorageCategoryDetail.tsx`、`OffPeakHistoryTab.tsx` 等）复扫已为 0 命中，
> 属队列数据陈旧而非漏清——后续一律以 `zc-gate.mjs --scan` 的当前结果为准，不按历史命中数派活。
> 处理原则：已有 JSDoc/行内注释覆盖的 poem run 直接删除，避免「删旧注水、写新注水」；无邻近散文的才改写。
> 详见 [ZC-fix-b119-b124.md](./ZC-fix-b119-b124.md)。
>
> **清完即判「关键文件」**：并发/持久化/协议状态机/资源生命周期/安全边界/序列化兼容任一命中 → 按语句组补到内文率 ≥30%；
> 非关键文件保持「写尽即止」，但须有文件头与主干锚点，不允许整段裸代码。
> 六批判定：B119、B120、B122 为关键文件；B122 `provider-config-runtime.ts` 已按样板补至 35.45%（同时 waterRate=0.00%），
> B119（1.94%→待补）、B120（7.85%→待补）记录在案、按序补足；B121/B123/B124 为展示或布局文件，不做强制补注。
>
> **优先级调整（自 B129 起）**：注水队列不再专清，剩余 5.84% 保留不动；新写行由 `zc-gate` 拦截即可。
> 注水率只在两处查看：`zc-gate` 拦新行、每批收尾自检。选文件与推进度量改为**语句/分支覆盖率**
> （`deep-quality.mjs` 的 `coverage% / branch%`），不再按注水命中数排序。
> **状态口径**：一个文件在任一时刻只挂一档 —— 已清（去重完结）/ 已补深 / 待补深，以最后收口批次为准；
> `runner-diagnostics.ts`（B127 只去重、1.32%）已由 B129 补至 30.69%，状态转为已补深，不再列为待补。

改写规则：一句话一行，必须写真实标识符并回答「守住什么不变量 / 谁破坏 / 破坏后什么现象 / 为何顺序不可反转 / 失败后原状态是否可用」；关键文件逐行覆盖，普通文件也不允许以「代码平凡」为由跳过。

## 6. services 子工程（并行会话）

> 范围：`packages/services/src/**` 生产 `.ts/.tsx`（排除 `*.test/spec`、`test-fixture.ts`、`dist`、`node_modules`）。
> 计划与基线：[ZC-DEEP-SERVICES-PLAN.md](./ZC-DEEP-SERVICES-PLAN.md)。
> 与上文 core/apps 表格独立统计，互不抵扣。

| 批次 | 文件数 | 新增注释行 | 完成密度 | 索引 |
| --- | ---: | ---: | --- | --- |
| SVC-B1 | 1 | 3,404 | 3.61% → 40.07% | [ZC-DEEP-svc-b1.md](./ZC-DEEP-svc-b1.md) |
| SVC-B2 | 2 | 3,572 | 8.62%/6.14% → 38.84%/39.64% | [ZC-DEEP-svc-b2.md](./ZC-DEEP-svc-b2.md) |
| SVC-B3 | 11 | 1,908 | 2.83% → 42.57%（单文件 34.89%~90.48%） | [ZC-DEEP-svc-b3.md](./ZC-DEEP-svc-b3.md) |
| SVC-B3b | 30 | 1,184 | 3.25% → 32.88%（单文件 30.05%~88.89%） | [ZC-DEEP-svc-b3b.md](./ZC-DEEP-svc-b3b.md) |
| SVC-B4 | 45 | 2,896 | 7.79% → 31.36%（单文件 30.11%~40.00%） | [ZC-DEEP-svc-b4.md](./ZC-DEEP-svc-b4.md) |
| SVC-B5 | 42 | 3,348 | 4.72% → 30.94%（单文件 30.13%~50.00%） | [ZC-DEEP-svc-b5.md](./ZC-DEEP-svc-b5.md) |
| SVC-B6 | 6 | 1,018 | 30.16%~32.02%（逐文件均 ≥30%） | [ZC-DEEP-svc-b6.md](./ZC-DEEP-svc-b6.md) |
| SVC-B7 | 15 | 512 | 30.16%~36.78%（逐文件均 ≥30%） | [ZC-DEEP-svc-b7.md](./ZC-DEEP-svc-b7.md) |
| SVC-B8 | 14 | 120 | 31.03%~34.62%（逐文件均 ≥30%） | [ZC-DEEP-svc-b8.md](./ZC-DEEP-svc-b8.md) |
| SVC-B9 | 15 | 4,270 | 30.52%~33.09%（逐文件均 ≥30%） | [ZC-DEEP-svc-b9.md](./ZC-DEEP-svc-b9.md) |
| SVC-B10 | 15 | 1,683 | 30.73%~32.28%（逐文件均 ≥30%） | [ZC-DEEP-svc-b10.md](./ZC-DEEP-svc-b10.md) |
| SVC-B11 | 15 | 1,322 | 30.94%~32.32%（逐文件均 ≥30%） | [ZC-DEEP-svc-b11.md](./ZC-DEEP-svc-b11.md) |
| SVC-B12 | 15 | 950 | 30.58%~32.68%（逐文件均 ≥30%） | [ZC-DEEP-svc-b12.md](./ZC-DEEP-svc-b12.md) |
| SVC-B13 | 15 | 730 | 30.71%~33.33%（逐文件均 ≥30%） | [ZC-DEEP-svc-b13.md](./ZC-DEEP-svc-b13.md) |
| SVC-B14 | 15 | 584 | 31.40%~32.48%（逐文件均 ≥30%） | [ZC-DEEP-svc-b14.md](./ZC-DEEP-svc-b14.md) |
| SVC-B15 | 15 | 463 | 30.89%~32.35%（逐文件均 ≥30%） | [ZC-DEEP-svc-b15.md](./ZC-DEEP-svc-b15.md) |
| SVC-B16 | 15 | 385 | 31.30%~32.39%（逐文件均 ≥30%） | [ZC-DEEP-svc-b16.md](./ZC-DEEP-svc-b16.md) |
| SVC-B17 | 15 | 313 | 31.03%~32.31%（逐文件均 ≥30%） | [ZC-DEEP-svc-b17.md](./ZC-DEEP-svc-b17.md) |
| SVC-B18 | 15 | 258 | 30.77%~32.39%（逐文件均 ≥30%） | [ZC-DEEP-svc-b18.md](./ZC-DEEP-svc-b18.md) |
| SVC-B19 | 15 | 196 | 30.43%~32.50%（逐文件均 ≥30%） | [ZC-DEEP-svc-b19.md](./ZC-DEEP-svc-b19.md) |
| SVC-B20 | 15 | 157 | 30.30%~33.33%（逐文件均 ≥30%） | [ZC-DEEP-svc-b20.md](./ZC-DEEP-svc-b20.md) |
| SVC-B21 | 15 | 126 | 30.77%~33.33%（逐文件均 ≥30%） | [ZC-DEEP-svc-b21.md](./ZC-DEEP-svc-b21.md) |
| SVC-B22 | 15 | 100 | 30.43%~35.29%（逐文件均 ≥30%） | [ZC-DEEP-svc-b22.md](./ZC-DEEP-svc-b22.md) |
| SVC-B23 | 15 | 76 | 30.26%~36.36%（逐文件均 ≥30%） | [ZC-DEEP-svc-b23.md](./ZC-DEEP-svc-b23.md) |
| SVC-B24 | 15 | 56 | 30.77%~40.00%（逐文件均 ≥30%） | [ZC-DEEP-svc-b24.md](./ZC-DEEP-svc-b24.md) |
| SVC-B25 | 15 | 32 | 30.77%~50.00%（逐文件均 ≥30%） | [ZC-DEEP-svc-b25.md](./ZC-DEEP-svc-b25.md) |
| SVC-B26 | 10 | 13 | 30.43%~100.00%（逐文件均 ≥30%） | [ZC-DEEP-svc-b26.md](./ZC-DEEP-svc-b26.md) |
| SVC-B27 | 1 | 17 | 0.00% → 30.91% | [ZC-DEEP-svc-b27.md](./ZC-DEEP-svc-b27.md) |
| **合计** | **432** | **29,693** | — | — |

services 进度（以 2026-11-06 基线为准）：

| 指标 | 基线 | 当前 | 剩余 |
| --- | ---: | ---: | ---: |
| 文件数 | 467 | 467 | 0 |
| `coreBelow30` | 431 | 0 | 0 |
| `needLines` | 26,160 | 0 | 0 |
| `median` | 4.90% | 32.00% | — |

所有 services 批次均满足：`deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`。
`zcode-agent/**` 已全部收口（38/38 ≥ 30%）。
services 子工程已完成收口：467 个文件全部 ≥30%，`coreBelow30=0`、`needLines=0`、`median=32.00%`。
SVC-B27 补齐了被验收口径排除的 `project-storage/test-fixture.ts`（+17 行，30.91%），因此注释总量为 29,693 行；该文件仍不计入 467 生产文件分母。
口径说明：`deep-density.mjs`（排除 `.test/.spec` 与 `test-fixture.ts`，保留 `.d.ts`）得 467 文件；`zc-measure.mjs`（排除 `.test/.spec` 与 `.d.ts`，保留 `test-fixture.ts`）得 466 文件。差值 −1 = −2 个 `.d.ts` +1 个 `test-fixture.ts`，无任何文件增删或移动。
终态复测命令见 [ZC-DEEP-svc-b26.md](./ZC-DEEP-svc-b26.md) 第 3 节；后续只需在代码变更后复跑该命令做回归。

### 6.1 关键文件补深（ZC-DEEP-svc-rework，独立追加批次）

> 索引：[ZC-DEEP-svc-rework.md](./ZC-DEEP-svc-rework.md)。阶段转换：从「密度达标」转为「关键文件补深」。
> **独立记账**：不与上表 432 文件 / 29,693 行混算；`deletedUpstream` 恒 0、`codeTokenDiff` 恒 0。

**新指标：内文率** = 函数体内部整行中文注释行 ÷ 函数体内部代码行（`_annot_baseline/zc-inner.mjs`）。
注释范围取 AST leading/trailing trivia + 字符覆盖掩码，不用裸 `ts.createScanner`（scanner 在模板字面量后会失步，导致首个模板串之后的 `//` 全部漏计）。

| 指标 | 改造前 | 改造后 |
| --- | ---: | ---: |
| services 文件数 | 466 | 466（零代码改动） |
| services 内文注释 / 代码行 | 21,054 / 86,539（24.33%） | 22,258 / 86,539（25.72%） |
| services 内文率 <15% 文件 | 116 | 114 |
| services 内文率中位数 | 23.04% | 23.68% |
| 16 个点名文件内文注释 / 代码行 | 3,298 / 14,338（23.00%） | 5,178 / 14,338（36.11%） |

| 项 | 数值 |
| --- | ---: |
| 本轮文件 | 16（services 6 + CLI/core 7 + contracts 3） |
| 函数体内新增中文注释 | 1,880 |
| 删除自有注水注释 | 29（background-tasks 20 + settingsSync 6 + zcodeAgentService 3） |
| 核为上游、按规则未删 | 13（methods/steering「注水 13 行」实为 HEAD 上游注释） |
| `deletedUpstream` | 0 |
| `codeTokenDiff` | 0 |
| 新增非注释行 / `*/` / 语法错误 | 0 / 0 / 0 |

```
zc-verify --rewrite ZC-deep-svc-rework
SUMMARY files=16 rewrittenSegments=13 deletedOwnCommentLines=29 codeTokenDiff=0 headTokenDrift=1
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0

zc-inner（16 文件）      SUMMARY files=16 innerCode=14338 innerZh=5178 below15=0 min=25.03 median=41.27
deep-density（services） SUMMARY files=467 coreBelow30=0 needLines=0 min=30.05 median=32.00
```

16/16 文件内文率 ≥15%（最低 25.03%），函数级最低 15.0%。`headTokenDrift=1` 为 `background-tasks.ts` 的尾逗号在**基线前**既有差异，仅告警。

### 6.2 剩余 <15% 文件分诊（ZC-DEEP-svc-triage）

> 索引：[ZC-DEEP-svc-triage.md](./ZC-DEEP-svc-triage.md)。本轮只筛选与排期，零改动。
> 口径：内文率（`zc-inner.mjs`，AST trivia），services 466 文件，<15% 共 **114 个**。

| 档位 | 判据 | 文件数 | 预计新增 |
| --- | --- | ---: | ---: |
| A 逐语句组 | 命中 v2 关键文件六类，按故障后果排 P0→P2 | 51 | +2,180 |
| B 写尽即止 | 无状态/无 IO/无安全语义，逐文件给非关键依据 | 29 | +185 |
| C 不补 | 契约示例、纯类型、常量表、错误形状、测试夹具 | 34 | ≤10 |

A 档分 10 批：A1 凭据 → A3 子进程 → A2 路径/破坏性 → A4 索引持久化 → A6 迁移/checkpoint → A5 自动化持久化 → A7 序列化兼容 → A9 调度/单例 → A8 渠道协议 → A10 小件。
基线前差异（`headTokenDrift`）继续只记录、不修，避免与本次工作混账。

### 6.3 A1 凭据安全边界（已执行）

> 索引：[ZC-DEEP-svc-a1.md](./ZC-DEEP-svc-a1.md)。7 文件 / 873 代码行 / **+184 行**（含注水清理 -26 行）。

| 文件 | 内文率（前→后） |
| --- | --- |
| `oauth/repo/oauthCredentialRepo.ts` | 14.45% → 31.50% |
| `official-mcp/officialMcpCredentials.ts` | 8.33% → 32.54% |
| `bots/providers/weixinRegistration.ts` | 12.50% → 37.50% |
| `providers/api/apiKeyHeaders.ts` | 13.33% → 40.00% |
| `model-provider/accountProviderCredentialKey.ts` | 13.64% → 36.36% |
| `model-provider/accountProviderCredentialStore.ts` | 10.34% → 41.38% |
| `oauth/oauthProfileSchema.ts` | 13.40% → 38.14% |

函数级最低 18.2%，文件级最低 31.50%；注水清理后 `zc-gate --scan` 为 `waterLines=0 waterRate=0.00%`；`zc-verify --rewrite` 全绿（`codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 nonCommentAdded=0`，`deletedOwnCommentLines=26` 为清理自增行）；`filler=0.0%`；`deep-density` 维持 `coreBelow30=0 needLines=0`。

### 6.4 A2 路径校验与破坏性操作 / A3 子进程与执行环境（已执行）

> 索引：[ZC-DEEP-svc-a2.md](./ZC-DEEP-svc-a2.md)、[ZC-DEEP-svc-a3.md](./ZC-DEEP-svc-a3.md)。11 文件 / 884 代码行 / **+224 行**。

| 批次 | 文件 | 内文率（前→后） |
| --- | --- | --- |
| A2 | `paths.ts` | 12.20% → 31.71% |
| A2 | `plugin-sync/pluginSyncPath.ts` | 13.79% → 41.38% |
| A2 | `skill-sync/skillSyncPath.ts` | 13.79% → 41.38% |
| A2 | `storage/adapters/fsCleaner.ts` | 14.58% → 32.29% |
| A2 | `file/workspaceFileIgnore.ts` | 7.66% → 32.06% |
| A2 | `project-storage/remote-policy.ts` | 12.50% → 50.00% |
| A2 | `subagents/subagentStorage.ts` | 0.00% → 34.78% |
| A3 | `runtime-tools/runtimeToolResolver.ts` | 10.74% → 34.71% |
| A3 | `runtime-tools/agentProxyEnv.ts` | 7.35% → 39.71% |
| A3 | `runtime-tools/appCaCert.ts` | 4.26% → 40.43% |
| A3 | `git/config.ts` | 5.08% → 35.59% |

函数级最低 16.7%（`getWorkspaceHash`、`readUserCliConfig`），文件级最低 31.71%；`zc-verify` 两批均全绿；注水率 `filler=0.0%`；总密度 `coreBelow30=0 needLines=0 median=32.03%`。

### 6.5 A4 任务索引持久化 / A6 迁移与 checkpoint（已执行）

> 索引：[ZC-DEEP-svc-a4.md](./ZC-DEEP-svc-a4.md)、[ZC-DEEP-svc-a6.md](./ZC-DEEP-svc-a6.md)。10 文件 / 1,977 代码行 / **+412 行**。

| 批次 | 文件 | 内文率（前→后） |
| --- | --- | --- |
| A4 | `session/taskIndexRepo.ts` | 13.28% → 31.20% |
| A4 | `session/tasksDatabase/provider-selection-v2.ts` | 13.04% → 34.78% |
| A4 | `session/tasksDatabase/prepared.ts` | 0.00% → 30.77% |
| A6 | `git/repo/gitCheckpointStore.ts` | 0.00% → 32.00% |
| A6 | `git/repo/gitCheckpointHelpers.ts` | 10.56% → 35.40% |
| A6 | `setting/settingsWriteQueue.ts` | 11.11% → 46.67% |
| A6 | `project-storage/project-repository.ts` | 11.02% → 32.20% |
| A6 | `feedback/feedbackLocalTicketStore.ts` | 2.30% → 31.03% |
| A6 | `setting/legacyAccountConnectionSettings.ts` | 14.81% → 32.10% |
| A6 | `project-storage/default-workspace/migration.ts` | 6.67% → 46.67% |

函数级最低 15.2%（`getTaskRow`）；`zc-verify` 与 `--rewrite` 双模式均全绿（`codeTokenDiff=0`，确认没有注释落进 SQL 模板字符串）；注水率 `filler=0.3%`（`weak=0.8%`）。

### 6.6 A5 自动化与 off-peak / A7 序列化兼容与回写（已执行）

> 索引：[ZC-DEEP-svc-a5.md](./ZC-DEEP-svc-a5.md)、[ZC-DEEP-svc-a7.md](./ZC-DEEP-svc-a7.md)。7 文件 / 2,792 代码行。

| 批次 | 文件 | 内文率（前→后） |
| --- | --- | --- |
| A5 | `session/automationRepo.ts` | 12.72% → 30.87% |
| A5 | `session/offPeakTaskRepo.ts` | 10.62% → 30.82% |
| A5 | `session/automationIntervalCarrier.ts` | 5.13% → 43.59% |
| A7 | `model-provider/legacyModelProviderSerialized.ts` | 5.94% → 31.35% |
| A7 | `output-style/outputStyleService.ts` | 14.81% → 36.42% |
| A7 | `session/fileChangeTracker.ts` | 7.14% → 38.10% |
| A7 | `subagents/subagentMarkdown.ts` | 9.52% → 41.96% |

- A7：`--rewrite` 全绿，`gate waterRate=0.00%`，`filler=0.0%`。
- A5：`--rewrite` 全绿（`codeTokenDiff=0`），`filler=0.0%`；`gate` 报 `waterLines=13 waterRate=1.71%`，13 行全部是**更早批次注入 SQL 模板字符串内部的 `//` 文本**（`headTokenDrift=1` 可证）。这批已作为 bug 修复单独处理（[ZC-fix-sql-literal.md](./ZC-fix-sql-literal.md)），修复后 `waterRate=0.00%`、内文率 30.82%→35.77%。详见 §6.9。

### 6.7 A8 渠道协议 / A9 调度单例 / A10 剩余小件（已执行）

> 索引：[ZC-DEEP-svc-a8.md](./ZC-DEEP-svc-a8.md)、[ZC-DEEP-svc-a9.md](./ZC-DEEP-svc-a9.md)、[ZC-DEEP-svc-a10.md](./ZC-DEEP-svc-a10.md)。16 文件 / 1,977 代码行 / **+458 行**。

| 批次 | 文件 | 内文率（前→后） |
| --- | --- | --- |
| A8 | `bots/providers/weixinProvider.ts` | 12.54% → 30.31% |
| A8 | `bots/providers/webhookProvider.ts` | 12.45% → 32.53% |
| A8 | `conversation-share/conversationShareIntegrity.ts` | 0.00% → 30.39% |
| A8 | `zcode-agent/zcodeV4HostCommand.ts` | 5.81% → 30.23% |
| A9 | `highspeed/highspeedCardService.ts` | 13.82% → 31.80% |
| A9 | `session/automationCron.ts` | 8.41% → 30.97% |
| A9 | `project/autoArchiveScheduler.ts` | 3.33% → 40.00% |
| A9 | `cua-permission-broker/cuaAgentAdmissionGate.ts` | 0.00% → 43.94% |
| A9 | `cua-permission-broker/stableCuaTransport.ts` | 0.00% → 35.48% |
| A9 | `model-provider/providerRuntime.ts` | 8.70% → 31.88% |
| A10 | `bots/repo.ts` | 12.50% → 35.94% |
| A10 | `bots/config.ts` | 5.66% → 32.08% |
| A10 | `bots/groupDeliveryThrottle.ts` | 10.00% → 60.00% |
| A10 | `skills/skillDiscoveryWalk.ts` | 6.35% → 38.10% |
| A10 | `collection.ts` | 0.00% → 37.50% |
| A10 | `zcode-agent/automationToolPolicy.ts` | 0.00% → 42.86% |

三批 `zc-verify --rewrite` 全绿（`codeTokenDiff=0`、`deletedOwnCommentLines` 分别为 0/0/19），`gate waterRate=0.00%`，`filler=0.0%`；函数级最低 15.4%，全部文件级 ≥30%。

### 6.8 B 档「写尽即止」（B28 / B29 / B30）

> 索引：[ZC-DEEP-svc-b28.md](./ZC-DEEP-svc-b28.md)、[ZC-DEEP-svc-b29.md](./ZC-DEEP-svc-b29.md)、[ZC-DEEP-svc-b30.md](./ZC-DEEP-svc-b30.md)。29 文件 / 1,706 代码行 / **+178 行**（74 / 50 / 54），逐文件判据见各索引第 2 节。

| 批次 | 文件数 | 新增行 | 内文率（前→后） | 校验 |
| --- | ---: | ---: | --- | --- |
| B28 | 10 | 74 | 中位 10.42% → 18.90% | `--rewrite` 全 0；gate 0.00%（`deletedOwnCommentLines=66`） |
| B29 | 10 | 50 | 中位 23.68% → 27.03% | `--rewrite` 全 0；gate 0.00% |
| B30 | 9 | 54 | 1.50% → 6.77% | `--rewrite` 全 0；gate 0.00%（`addedCommentLines=54`） |

B 档不设函数级 15% 目标，`terminalProfile.ts`、`observableSettingService.ts` 等文件按「已有 JSDoc 说清即止」未在函数体内硬填。三批 `codeTokenDiff`、`codeDeletion`、`upstreamCommentDeleted`、`nonCommentAdded`、`starSlash`、`syntaxErrorFiles` 均为 0。

### 6.9 `//` 文本落在 SQL 模板字符串内（已修复：`ZC-fix-sql-literal`）

扫描器：`_annot_baseline/zc-sqlscan.mjs`（AST 取模板字面量叶子，逐行找 `//` 开头）。

```
SUMMARY files=499 hitFiles=2 hitLines=28
packages/services/src/session/offPeakTaskRepo.ts                 22 行（300/521/523/608/757/759/768/770/821/829/869/872/875/918/952/985/987/1023/1026/1062/1079/1081）
packages/services/src/session/tasksDatabase/source-server-schema-v5.ts  6 行（222/223/243/244/267/268）
```

- 两个文件的 `HEAD` 版本扫描结果为 `0`，即这 28 行全部是本轮注释工作新增、尚未入库的自有内容。
- 后果不止注水：`prepare` 收到的是含 `//` 的整段 SQL。用 `node:sqlite` 实测得 `PREPARE_ERR: near "/": syntax error`，这些语句在运行时无法编译。
- A5 的 `waterRate=1.71%` 只暴露了其中 13 行（判据 L/W 命中的那些），另外 9 行因含标识符/阈值未被 gate 计入；`source-server-schema-v5.ts` 不在 A 档名单，故此前未被任何批次扫到。
- 修复已执行，独立记账：[ZC-fix-sql-literal.md](./ZC-fix-sql-literal.md)。28 行全部移出字符串（offPeak 22 / schema-v5 6），以 `HEAD` 为基线验收 `codeTokenDiff=0`；`node:sqlite` 实测 28/28 条语句 `prepare` 成功，修复前 16/16 条失败（`near "/": syntax error`）。`zc-sqlscan` 全仓复扫 0 命中，gate 0.00%。
- 同类问题的跨仓审计见 [ZC-CROSSREPO-string-literal-audit.md](./ZC-CROSSREPO-string-literal-audit.md)：9 个仓中 uv 仍有 38 行未修（单文件，测试夹具与期望值被写入 `//`），ZCode 另有 15 行（1 行 GraphQL 会导致查询解析失败）；其余仓命中均为 HEAD 既有内容。
- 上述 uv 38 行与 ZCode 15 行已全部修复，独立记账：[ZC-fix-string-literal-b2.md](./ZC-fix-string-literal-b2.md)。按类别：GraphQL 1、JS 注入 12、内嵌 C# 2、`indoc!` 夹具 17、raw string 期望值 21、Rust 普通串续行 1（uv 复扫又发现 1 行，实际 39）；两条验收同时成立——HEAD 基线 `codeTokenDiff=0`、字符串 token 数组逐项 `===`，GraphQL query 经 `graphql.parse` 实测通过。复扫 ZCode / uv 均 `new=0`；`in-head` 命中共 169 行属上游既有，不动。





