# ZC-fix-B125：`packages/shared/src/zcode-protocol/index.ts`

> 队列第一顺位（去重全量扫描 waterLines=106）。**结论：0 修复**——106 行全部为判据误报，文件移出真实队列。

## 1. 行级命中

```
node zc-gate.mjs --file packages/shared/src/zcode-protocol/index.ts
SUMMARY files=1 badFiles=1 addedCommentLines=853 waterLines=106 waterRate=12.43%
```

命中形态：W 42 行、L 61 行、poem/B 0 行（无连续短行，该文件不是注水插入的产物）。

## 2. 段落级复核

把同段连续 `//` 拼成一段再判：

```
node zc-para.mjs --file packages/shared/src/zcode-protocol/index.ts
SUMMARY added=853 poem=0 wl=106 artifact=106 genuine=0
```

106 行全部属于 `wlArtifact`。两类成因：

| 成因 | 例子 | 为何是误报 |
| --- | --- | --- |
| 折行续句 | `945` 行注释被硬折成两行，第二行以「的往返次数线性上升；改大则可能触发单帧上限」开头 | 单行看无主语，拼段后主语、条件、后果齐全 |
| 枚举 + 后果 | 「私有反向频道名：附件只走已建立的连接，不新开端口，避免在 NAT/防火墙环境下额外协商。」 | L 判据只看「≥2 个 `、,，` 且无谓词」，`避免` 不在谓词表内 |

该文件是协议契约文件，注释按 ~40 字硬折行，天然触发按行判定的 W/L。**不做任何改写**：
逐行补锚点会把一段完整论证拆成多条重复句，等于制造新噪声。

## 3. 由此得到的口径修正

`zc-gate` 的 W/L 是「行级」判据，对硬折行的散文系统性偏高。全仓复核（1415 个命中文件）：

| 口径 | waterLines | 水率 |
| --- | ---: | ---: |
| 行级（`zc-gate`，fail-closed 门禁） | 21,625 | 17.11% |
| 段落级（`zc-para`，真实待修） | **7,420** | **5.87%** |

其中 14,205 行为折行/枚举误报；真实待修 = poem run 5,770 + W/L 真弱行 1,650。
因此：

- **门禁不变**：插入侧仍用 `zc-gate`，宁可误报，命中即整批不落盘；
- **派活改口径**：清理队列改用 `zc-para.mjs --queue`，只修 poem 与 `wlGenuine`；
- 真实队列写入 `_annot_baseline/zc-work-queue-true.txt`（列：`genuine \t poem \t rel`）。

## 4. 下一批

真实队列头部：`apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`（genuine=23, poem=0）。

## 5. 验证

本批未改动代码，`zc-verify` 无需运行；文件当前状态已由上面的 `zc-gate` / `zc-para` 两次扫描覆盖。
