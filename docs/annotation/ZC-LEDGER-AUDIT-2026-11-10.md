# ZC 批次台账审计（2026-11-10）

> 目的：核对全部 `ZC-DEEP-b*.md` 登记的「文件 + 行数」是否真的在仓库里有提交号，找出「有台账、无提交」的批次。
> 方法：`_annot_baseline/audit-ledgers2.mjs`，逐文件取 `git log -1 --format=%h`、`git diff --numstat`、`git status --porcelain`。
> 原始数据：`_annot_baseline/ledger-audit.tsv`（1,411 行）。
> **快照时点**：本表在补提交之前生成。`packages/server/src/remote/remoteAssetInstaller.ts` 已于 `89d591aa` 补提交（54 行水句改写后落盘），因此该行「未提交」只代表快照当时的状态；其余行仍适用。执行顺序见 DEEP-SPEC §2.17：白名单只减不增。

## 1. 总数

| 判定 | 文件数 | 含义 |
| --- | ---: | --- |
| 未提交 | 1098 | 工作区增量恰好等于台账登记行数，仓库里没有对应提交 |
| 部分未提交 | 183 | 工作区增量小于登记行数 |
| 台账与实测不符 | 18 | 路径不存在 / 增量大于登记 / 干净但无注释提交 |
| 已提交且干净 | 111 | 工作区无改动，末次提交为注释提交 |
| 台账解析失败 | 1 | 台账正文无法解析出文件表 |
| **合计** | **1411** | **1300 个文件未落提交，合计 115,870 行** |

## 2. 分批汇总

| 批次 | 登记文件 | 登记行数 | 已提交且干净 | 未落提交文件 | 未落提交行数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| ZC-DEEP-b1 | 1 | 1175 | 0 | 1 | 1175 |
| ZC-DEEP-b2 | 2 | 1795 | 0 | 2 | 1795 |
| ZC-DEEP-b3 | 2 | 1700 | 1 | 1 | 853 |
| ZC-DEEP-b4 | 2 | 1533 | 0 | 2 | 1533 |
| ZC-DEEP-b5 | 3 | 1803 | 0 | 3 | 1801 |
| ZC-DEEP-b6 | 3 | 1646 | 0 | 3 | 1646 |
| ZC-DEEP-b7 | 3 | 1558 | 1 | 2 | 1045 |
| ZC-DEEP-b8 | 4 | 1968 | 1 | 3 | 1475 |
| ZC-DEEP-b9 | 4 | 1955 | 0 | 4 | 1955 |
| ZC-DEEP-b10 | 4 | 1829 | 2 | 2 | 933 |
| ZC-DEEP-b11 | 5 | 2119 | 0 | 5 | 2119 |
| ZC-DEEP-b12 | 5 | 1896 | 0 | 5 | 1896 |
| ZC-DEEP-b13 | 5 | 1798 | 0 | 5 | 1798 |
| ZC-DEEP-b14 | 6 | 1999 | 1 | 5 | 1667 |
| ZC-DEEP-b15 | 6 | 1860 | 0 | 6 | 1783 |
| ZC-DEEP-b16 | 7 | 2194 | 1 | 6 | 1834 |
| ZC-DEEP-b17 | 7 | 2146 | 0 | 7 | 2146 |
| ZC-DEEP-b18 | 8 | 2161 | 1 | 7 | 1991 |
| ZC-DEEP-b19 | 8 | 1952 | 1 | 7 | 1702 |
| ZC-DEEP-b20 | 9 | 2251 | 0 | 9 | 2251 |
| ZC-DEEP-b21 | 9 | 1999 | 0 | 9 | 1999 |
| ZC-DEEP-b22 | 9 | 1797 | 1 | 8 | 1687 |
| ZC-DEEP-b23 | 8 | 1513 | 3 | 5 | 952 |
| ZC-DEEP-b24 | 8 | 1448 | 1 | 7 | 1217 |
| ZC-DEEP-b25 | 8 | 1388 | 0 | 8 | 1388 |
| ZC-DEEP-b26 | 7 | 1136 | 0 | 7 | 1136 |
| ZC-DEEP-b27 | 8 | 1256 | 0 | 8 | 1256 |
| ZC-DEEP-b28 | 8 | 1208 | 0 | 8 | 1208 |
| ZC-DEEP-b29 | 11 | 1539 | 0 | 11 | 1375 |
| ZC-DEEP-b30 | 12 | 1641 | 0 | 12 | 1641 |
| ZC-DEEP-b31 | 12 | 1707 | 1 | 11 | 1568 |
| ZC-DEEP-b32 | 12 | 1577 | 1 | 11 | 1450 |
| ZC-DEEP-b33 | 12 | 1485 | 0 | 12 | 1485 |
| ZC-DEEP-b34 | 12 | 1504 | 2 | 10 | 1255 |
| ZC-DEEP-b35 | 12 | 1423 | 0 | 12 | 1423 |
| ZC-DEEP-b36 | 12 | 1383 | 4 | 8 | 918 |
| ZC-DEEP-b37 | 12 | 1358 | 1 | 11 | 1328 |
| ZC-DEEP-b38 | 12 | 1312 | 2 | 10 | 1092 |
| ZC-DEEP-b39 | 12 | 1287 | 0 | 12 | 1272 |
| ZC-DEEP-b40 | 12 | 1277 | 0 | 12 | 1356 |
| ZC-DEEP-b41 | 12 | 1248 | 2 | 10 | 1040 |
| ZC-DEEP-b42 | 12 | 1230 | 1 | 11 | 1128 |
| ZC-DEEP-b43 | 12 | 1190 | 0 | 12 | 1190 |
| ZC-DEEP-b44 | 12 | 1184 | 1 | 11 | 1085 |
| ZC-DEEP-b45 | 12 | 1159 | 1 | 11 | 1064 |
| ZC-DEEP-b46 | 12 | 1127 | 0 | 12 | 1099 |
| ZC-DEEP-b47 | 12 | 1102 | 4 | 8 | 717 |
| ZC-DEEP-b48 | 12 | 1090 | 0 | 12 | 1241 |
| ZC-DEEP-b49 | 12 | 1060 | 0 | 12 | 1033 |
| ZC-DEEP-b50 | 12 | 1033 | 0 | 12 | 1027 |
| ZC-DEEP-b51 | 12 | 1000 | 2 | 10 | 812 |
| ZC-DEEP-b52 | 12 | 987 | 7 | 5 | 403 |
| ZC-DEEP-b53 | 12 | 969 | 1 | 11 | 885 |
| ZC-DEEP-b54 | 12 | 1039 | 0 | 12 | 1032 |
| ZC-DEEP-b55 | 12 | 972 | 3 | 9 | 727 |
| ZC-DEEP-b56 | 12 | 926 | 3 | 9 | 695 |
| ZC-DEEP-b57 | 12 | 927 | 1 | 11 | 809 |
| ZC-DEEP-b58 | 12 | 901 | 0 | 12 | 882 |
| ZC-DEEP-b59 | 12 | 862 | 1 | 11 | 780 |
| ZC-DEEP-b60 | 12 | 859 | 1 | 11 | 768 |
| ZC-DEEP-b61 | 12 | 840 | 2 | 10 | 701 |
| ZC-DEEP-b62 | 12 | 821 | 3 | 9 | 589 |
| ZC-DEEP-b63 | 12 | 815 | 2 | 10 | 677 |
| ZC-DEEP-b64 | 12 | 807 | 1 | 11 | 722 |
| ZC-DEEP-b65 | 12 | 792 | 1 | 11 | 703 |
| ZC-DEEP-b66 | 12 | 787 | 0 | 12 | 752 |
| ZC-DEEP-b67 | 12 | 787 | 0 | 12 | 758 |
| ZC-DEEP-b68 | 12 | 769 | 0 | 12 | 740 |
| ZC-DEEP-b69 | 12 | 762 | 1 | 11 | 685 |
| ZC-DEEP-b70 | 12 | 753 | 0 | 12 | 722 |
| ZC-DEEP-b71 | 12 | 751 | 1 | 11 | 744 |
| ZC-DEEP-b72 | 12 | 739 | 1 | 11 | 651 |
| ZC-DEEP-b73 | 12 | 729 | 2 | 10 | 591 |
| ZC-DEEP-b74 | 12 | 729 | 0 | 12 | 717 |
| ZC-DEEP-b75 | 12 | 712 | 0 | 12 | 708 |
| ZC-DEEP-b76 | 6 | 358 | 0 | 6 | 345 |
| ZC-DEEP-b77 | 6 | 351 | 0 | 6 | 347 |
| ZC-DEEP-b78 | 6 | 351 | 0 | 6 | 335 |
| ZC-DEEP-b79 | 6 | 349 | 0 | 6 | 341 |
| ZC-DEEP-b80 | 6 | 344 | 0 | 6 | 320 |
| ZC-DEEP-b81 | 6 | 343 | 0 | 6 | 386 |
| ZC-DEEP-b82 | 6 | 339 | 0 | 6 | 333 |
| ZC-DEEP-b83 | 6 | 328 | 3 | 3 | 88 |
| ZC-DEEP-b84 | 6 | 331 | 0 | 6 | 331 |
| ZC-DEEP-b85 | 6 | 327 | 0 | 6 | 242 |
| ZC-DEEP-b86 | 6 | 337 | 0 | 6 | 330 |
| ZC-DEEP-b87 | 6 | 325 | 0 | 6 | 301 |
| ZC-DEEP-b88 | 6 | 319 | 0 | 6 | 315 |
| ZC-DEEP-b89 | 6 | 320 | 0 | 6 | 320 |
| ZC-DEEP-b90 | 6 | 319 | 0 | 6 | 312 |
| ZC-DEEP-b91 | 6 | 322 | 0 | 6 | 264 |
| ZC-DEEP-b92 | 6 | 314 | 0 | 6 | 305 |
| ZC-DEEP-b93 | 6 | 318 | 3 | 3 | 159 |
| ZC-DEEP-b94 | 6 | 314 | 0 | 6 | 308 |
| ZC-DEEP-b95 | 6 | 317 | 1 | 5 | 362 |
| ZC-DEEP-b96 | 6 | 302 | 0 | 6 | 293 |
| ZC-DEEP-b97 | 6 | 325 | 0 | 6 | 317 |
| ZC-DEEP-b98 | 6 | 306 | 0 | 6 | 306 |
| ZC-DEEP-b99 | 6 | 303 | 0 | 6 | 298 |
| ZC-DEEP-b100 | 6 | 295 | 0 | 6 | 295 |
| ZC-DEEP-b101 | 6 | 297 | 0 | 6 | 280 |
| ZC-DEEP-b102 | 6 | 303 | 1 | 5 | 253 |
| ZC-DEEP-b103 | 6 | 296 | 0 | 6 | 296 |
| ZC-DEEP-b104 | 6 | 292 | 0 | 6 | 292 |
| ZC-DEEP-b105 | 6 | 283 | 0 | 6 | 184 |
| ZC-DEEP-b106 | 6 | 284 | 2 | 4 | 189 |
| ZC-DEEP-b107 | 6 | 285 | 0 | 6 | 269 |
| ZC-DEEP-b108 | 6 | 285 | 0 | 6 | 182 |
| ZC-DEEP-b109 | 6 | 276 | 3 | 3 | 138 |
| ZC-DEEP-b110 | 6 | 276 | 0 | 6 | 226 |
| ZC-DEEP-b111 | 6 | 273 | 0 | 6 | 162 |
| ZC-DEEP-b112 | 6 | 281 | 0 | 6 | 187 |
| ZC-DEEP-b113 | 6 | 294 | 0 | 6 | 254 |
| ZC-DEEP-b114 | 6 | 270 | 2 | 4 | 178 |
| ZC-DEEP-b115 | 6 | 274 | 0 | 6 | 249 |
| ZC-DEEP-b116 | 6 | 271 | 0 | 6 | 271 |
| ZC-DEEP-b117 | 6 | 297 | 0 | 6 | 260 |
| ZC-DEEP-b118 | 6 | 263 | 0 | 6 | 263 |
| ZC-DEEP-b119 | 6 | 263 | 0 | 6 | 263 |
| ZC-DEEP-b120a | 4 | 192 | 0 | 4 | 141 |
| ZC-DEEP-b120b | 2 | 85 | 0 | 2 | 72 |
| ZC-DEEP-b121 | 4 | 176 | 0 | 4 | 159 |
| ZC-DEEP-b122 | 4 | 171 | 0 | 4 | 171 |
| ZC-DEEP-b123 | 4 | 173 | 0 | 4 | 173 |
| ZC-DEEP-b124 | 4 | 169 | 0 | 4 | 182 |
| ZC-DEEP-b125 | 4 | 177 | 0 | 4 | 177 |
| ZC-DEEP-b126 | 4 | 171 | 1 | 3 | 130 |
| ZC-DEEP-b127 | 4 | 184 | 1 | 3 | 143 |
| ZC-DEEP-b128 | 4 | 173 | 0 | 4 | 305 |
| ZC-DEEP-b129 | 4 | 170 | 0 | 4 | 178 |
| ZC-DEEP-b130 | 4 | 176 | 0 | 4 | 202 |
| ZC-DEEP-b131 | 4 | 174 | 0 | 4 | 174 |
| ZC-DEEP-b132 | 4 | 168 | 0 | 4 | 168 |
| ZC-DEEP-b133 | 3 | 130 | 0 | 3 | 106 |
| ZC-DEEP-b134 | 3 | 121 | 0 | 3 | 121 |
| ZC-DEEP-b135 | 3 | 120 | 3 | 0 | 0 |
| ZC-DEEP-b136 | 4 | 165 | 0 | 4 | 165 |
| ZC-DEEP-b137 | 4 | 170 | 0 | 4 | 249 |
| ZC-DEEP-b138 | 4 | 177 | 1 | 3 | 136 |
| ZC-DEEP-b139 | 4 | 191 | 1 | 3 | 154 |
| ZC-DEEP-b140 | 4 | 161 | 0 | 4 | 161 |
| ZC-DEEP-b141 | 4 | 163 | 0 | 4 | 163 |
| ZC-DEEP-b142 | 4 | 167 | 0 | 4 | 167 |
| ZC-DEEP-b143 | 4 | 162 | 0 | 4 | 162 |
| ZC-DEEP-b144 | 4 | 165 | 1 | 3 | 125 |
| ZC-DEEP-b145 | 4 | 156 | 0 | 4 | 156 |
| ZC-DEEP-b146 | 4 | 163 | 0 | 4 | 163 |
| ZC-DEEP-b147 | 4 | 158 | 0 | 4 | 158 |
| ZC-DEEP-b148 | 4 | 158 | 0 | 4 | 158 |
| ZC-DEEP-b149 | 4 | 157 | 0 | 4 | 157 |
| ZC-DEEP-b150 | 4 | 160 | 0 | 4 | 160 |
| ZC-DEEP-b151 | 1 | 55 | 0 | 1 | 55 |
| ZC-DEEP-b152 | 4 | 162 | 0 | 4 | 162 |
| ZC-DEEP-b153 | 4 | 157 | 0 | 4 | 157 |
| ZC-DEEP-b154 | 4 | 155 | 0 | 4 | 155 |
| ZC-DEEP-b155 | 4 | 152 | 0 | 4 | 152 |
| ZC-DEEP-b156 | 4 | 155 | 0 | 4 | 155 |
| ZC-DEEP-b157 | 4 | 163 | 0 | 4 | 365 |
| ZC-DEEP-b158 | 4 | 154 | 1 | 3 | 117 |
| ZC-DEEP-b159 | 4 | 151 | 0 | 4 | 151 |
| ZC-DEEP-b160 | 4 | 150 | 0 | 4 | 150 |
| ZC-DEEP-b161 | 4 | 154 | 0 | 4 | 150 |
| ZC-DEEP-b162 | 4 | 147 | 0 | 4 | 147 |
| ZC-DEEP-b163 | 4 | 153 | 0 | 4 | 153 |
| ZC-DEEP-b164 | 4 | 149 | 0 | 4 | 149 |
| ZC-DEEP-b165 | 4 | 146 | 0 | 4 | 146 |
| ZC-DEEP-b166 | 4 | 147 | 0 | 4 | 147 |
| ZC-DEEP-b167 | 4 | 152 | 1 | 3 | 111 |
| ZC-DEEP-b168 | 4 | 155 | 0 | 4 | 155 |
| ZC-DEEP-b169 | 4 | 154 | 0 | 4 | 134 |
| ZC-DEEP-b170 | 4 | 142 | 0 | 4 | 142 |
| ZC-DEEP-b171 | 4 | 142 | 0 | 4 | 142 |
| ZC-DEEP-b172 | 4 | 147 | 0 | 4 | 147 |
| ZC-DEEP-b173 | 4 | 143 | 0 | 4 | 143 |
| ZC-DEEP-b174 | 4 | 145 | 0 | 4 | 145 |
| ZC-DEEP-b175 | 4 | 138 | 0 | 4 | 138 |
| ZC-DEEP-b176 | 4 | 139 | 0 | 4 | 139 |
| ZC-DEEP-b177 | 4 | 139 | 0 | 4 | 139 |
| ZC-DEEP-b178 | 4 | 140 | 0 | 4 | 140 |
| ZC-DEEP-b179 | 4 | 137 | 0 | 4 | 137 |
| ZC-DEEP-b180 | 4 | 137 | 0 | 4 | 137 |
| ZC-DEEP-b181 | 4 | 138 | 0 | 4 | 138 |
| ZC-DEEP-b182 | 4 | 138 | 4 | 0 | 0 |
| ZC-DEEP-b183 | 4 | 131 | 0 | 4 | 131 |
| ZC-DEEP-b184 | 4 | 139 | 0 | 4 | 139 |
| ZC-DEEP-b185 | 4 | 132 | 0 | 4 | 132 |
| ZC-DEEP-b186 | 4 | 136 | 0 | 4 | 136 |
| ZC-DEEP-b187 | 4 | 138 | 1 | 3 | 104 |
| ZC-DEEP-b188 | 4 | 134 | 0 | 4 | 134 |
| ZC-DEEP-b189 | 4 | 133 | 0 | 4 | 133 |
| ZC-DEEP-b190 | 4 | 133 | 0 | 4 | 133 |
| ZC-DEEP-b191 | 4 | 129 | 4 | 0 | 0 |
| ZC-DEEP-b192 | 4 | 129 | 1 | 3 | 97 |
| ZC-DEEP-b193 | 4 | 132 | 0 | 4 | 132 |
| ZC-DEEP-b194 | 4 | 128 | 0 | 4 | 128 |
| ZC-DEEP-b195 | 4 | 130 | 0 | 4 | 130 |
| ZC-DEEP-b196 | 4 | 130 | 0 | 4 | 130 |
| ZC-DEEP-b197 | 4 | 130 | 0 | 4 | 130 |
| ZC-DEEP-b198 | 4 | 132 | 0 | 4 | 132 |
| ZC-DEEP-b199 | 4 | 128 | 2 | 2 | 66 |
| ZC-DEEP-b200 | 4 | 125 | 0 | 4 | 125 |
| ZC-DEEP-b201 | 4 | 125 | 0 | 4 | 125 |
| ZC-DEEP-b202 | 4 | 126 | 0 | 4 | 121 |
| ZC-DEEP-b203 | 4 | 127 | 0 | 4 | 127 |
| ZC-DEEP-b204 | 4 | 129 | 0 | 4 | 129 |
| ZC-DEEP-b205 | 4 | 124 | 0 | 4 | 124 |
| ZC-DEEP-b206 | 4 | 123 | 3 | 1 | 33 |
| ZC-DEEP-b207 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b208 | 4 | 121 | 0 | 4 | 114 |
| ZC-DEEP-b209 | 4 | 120 | 0 | 4 | 118 |
| ZC-DEEP-b210 | 4 | 120 | 0 | 4 | 113 |
| ZC-DEEP-b211 | 4 | 122 | 0 | 4 | 121 |
| ZC-DEEP-b212 | 4 | 120 | 0 | 4 | 116 |
| ZC-DEEP-b213 | 4 | 120 | 0 | 4 | 113 |
| ZC-DEEP-b214 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b215 | 4 | 120 | 0 | 4 | 119 |
| ZC-DEEP-b216 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b217 | 4 | 120 | 0 | 4 | 114 |
| ZC-DEEP-b218 | 4 | 120 | 0 | 4 | 114 |
| ZC-DEEP-b219 | 4 | 120 | 0 | 4 | 116 |
| ZC-DEEP-b220 | 4 | 120 | 0 | 4 | 117 |
| ZC-DEEP-b221 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b222 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b223 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b224 | 4 | 120 | 4 | 0 | 0 |
| ZC-DEEP-b225 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b226 | 4 | 120 | 0 | 4 | 120 |
| ZC-DEEP-b228 | 1 | 0 | 0 | 1 | 0 |

## 3. 逐文件明细

| 批次 | 台账登记 | 文件 | `git log -1 --format=%H` | 工作区 numstat | 判定 | 备注 |
| --- | ---: | --- | --- | ---: | --- | --- |
| ZC-DEEP-b1 | 1175 | `packages/ui/src/v4/SessionPane.tsx` | `7aeaf5ba` | +1175/-0 | 未提交 | — |
| ZC-DEEP-b2 | 900 | `packages/desktop/src/host/index.ts` | `e6ff6fab` | +900/-0 | 未提交 | — |
| ZC-DEEP-b2 | 895 | `packages/ui/src/lib/zcodeSessionProjection.ts` | `7aeaf5ba` | +895/-0 | 未提交 | — |
| ZC-DEEP-b3 | 853 | `packages/shared/src/zcode-protocol/index.ts` | `0a1fc56d` | +853/-0 | 未提交 | — |
| ZC-DEEP-b3 | 847 | `packages/desktop/src/main/browserView/browserGuestManager.ts` | `cce264eb` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b4 | 791 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | `0f2ef80d` | +791/-0 | 未提交 | — |
| ZC-DEEP-b4 | 742 | `packages/ui/src/settings/AutomationEditView.tsx` | `0a1fc56d` | +742/-0 | 未提交 | — |
| ZC-DEEP-b5 | 656 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | `3c5b2276` | +656/-0 | 未提交 | — |
| ZC-DEEP-b5 | 586 | `packages/ui/src/SettingsPage.tsx` | `3c5b2276` | +584/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b5 | 561 | `apps/zcode-cli/packages/core/src/subagent/runner.ts` | `0a1fc56d` | +561/-0 | 未提交 | — |
| ZC-DEEP-b6 | 567 | `packages/ui/src/settings/RemotePluginSyncDialog.tsx` | `0a1fc56d` | +567/-0 | 未提交 | — |
| ZC-DEEP-b6 | 543 | `packages/ui/src/remote-connection-flow/index.ts` | `0a1fc56d` | +543/-0 | 未提交 | — |
| ZC-DEEP-b6 | 536 | `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | `3c5b2276` | +536/-0 | 未提交 | — |
| ZC-DEEP-b7 | 521 | `packages/ui/src/v4/ConversationRowView.tsx` | `0a1fc56d` | +521/-0 | 未提交 | — |
| ZC-DEEP-b7 | 513 | `packages/desktop/src/main/index.ts` | `65d659a1` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b7 | 524 | `packages/ui/src/settings/SubagentsSection.tsx` | `0a1fc56d` | +524/-0 | 未提交 | — |
| ZC-DEEP-b8 | 493 | `packages/desktop/src/main/webRemoteControlManager.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b8 | 494 | `packages/ui/src/v4/ConversationComposer.tsx` | `3c5b2276` | +494/-0 | 未提交 | — |
| ZC-DEEP-b8 | 491 | `packages/web/src/main.tsx` | `0a1fc56d` | +491/-0 | 未提交 | — |
| ZC-DEEP-b8 | 490 | `packages/ui/src/settings/SourceServerManagementPanel.tsx` | `0a1fc56d` | +490/-0 | 未提交 | — |
| ZC-DEEP-b9 | 485 | `packages/ui/src/v4/ConversationStatusPanel.tsx` | `0a1fc56d` | +485/-0 | 未提交 | — |
| ZC-DEEP-b9 | 479 | `packages/ui/src/PreviewPane.tsx` | `0a1fc56d` | +479/-0 | 未提交 | — |
| ZC-DEEP-b9 | 475 | `packages/ui/src/settings/AutomationsSection.tsx` | `0a1fc56d` | +475/-0 | 未提交 | — |
| ZC-DEEP-b9 | 516 | `packages/server/src/remote/remoteAssetCache.ts` | `0a1fc56d` | +516/-0 | 未提交 | — |
| ZC-DEEP-b10 | 471 | `packages/desktop/src/main/autoUpdater.ts` | `27e46c34` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b10 | 425 | `packages/desktop/src/main/desktopRemoteSessions.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b10 | 427 | `packages/ui/src/settings/ExternalAgentImportDialog.tsx` | `aac47556` | +427/-0 | 未提交 | — |
| ZC-DEEP-b10 | 506 | `packages/shared/src/validation.ts` | `0a1fc56d` | +506/-0 | 未提交 | — |
| ZC-DEEP-b11 | 418 | `packages/ui/src/settings/PluginsSection.tsx` | `0a1fc56d` | +418/-0 | 未提交 | — |
| ZC-DEEP-b11 | 403 | `packages/ui/src/settings/McpSettingsSection.tsx` | `0a1fc56d` | +403/-0 | 未提交 | — |
| ZC-DEEP-b11 | 392 | `packages/ui/src/GitActionMenu.tsx` | `872ad960` | +392/-0 | 未提交 | — |
| ZC-DEEP-b11 | 463 | `apps/zcode-cli/packages/debug/src/App.tsx` | `3ead6c6a` | +463/-0 | 未提交 | — |
| ZC-DEEP-b11 | 443 | `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` | `0a1fc56d` | +443/-0 | 未提交 | — |
| ZC-DEEP-b12 | 371 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` | `0f2ef80d` | +371/-0 | 未提交 | — |
| ZC-DEEP-b12 | 396 | `packages/ui/src/lib/conversationTelemetryParityScenarioDefinitions.ts` | `aac47556` | +396/-0 | 未提交 | — |
| ZC-DEEP-b12 | 364 | `packages/ui/src/Root.tsx` | `3c5b2276` | +364/-0 | 未提交 | — |
| ZC-DEEP-b12 | 394 | `packages/ui/src/lib/messageTelemetry.ts` | `0a1fc56d` | +394/-0 | 未提交 | — |
| ZC-DEEP-b12 | 371 | `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` | `522e851e` | +371/-0 | 未提交 | — |
| ZC-DEEP-b13 | 383 | `apps/dev-docs/src/data/protocolDocs.ts` | `55f48e6d` | +383/-0 | 未提交 | — |
| ZC-DEEP-b13 | 352 | `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` | `3c5b2276` | +352/-0 | 未提交 | — |
| ZC-DEEP-b13 | 366 | `packages/ui/src/components/ai-elements/message.tsx` | `872ad960` | +366/-0 | 未提交 | — |
| ZC-DEEP-b13 | 349 | `packages/ui/src/v4/ConversationTurnGroup.tsx` | `0a1fc56d` | +349/-0 | 未提交 | — |
| ZC-DEEP-b13 | 348 | `packages/ui/src/v4/ConversationTimeline.tsx` | `3c5b2276` | +348/-0 | 未提交 | — |
| ZC-DEEP-b14 | 328 | `packages/ui/src/App.tsx` | `3c5b2276` | +328/-0 | 未提交 | — |
| ZC-DEEP-b14 | 337 | `packages/ui/src/hooks/useAppPanels.ts` | `0a1fc56d` | +337/-0 | 未提交 | — |
| ZC-DEEP-b14 | 335 | `packages/ui/src/lib/workspaceSidePane.ts` | `0a1fc56d` | +335/-0 | 未提交 | — |
| ZC-DEEP-b14 | 332 | `packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b14 | 320 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts` | `0f2ef80d` | +320/-0 | 未提交 | — |
| ZC-DEEP-b14 | 347 | `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | `522e851e` | +347/-0 | 未提交 | — |
| ZC-DEEP-b15 | 314 | `packages/ui/src/components/ai-elements/markdown-table.tsx` | `872ad960` | +314/-0 | 未提交 | — |
| ZC-DEEP-b15 | 311 | `packages/ui/src/settings/model-provider-section/Detail.tsx` | `aac47556` | +311/-0 | 未提交 | — |
| ZC-DEEP-b15 | 310 | `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | `0a1fc56d` | +297/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b15 | 304 | `packages/ui/src/RemoteConnectionFields.tsx` | `0a1fc56d` | +268/-0 | 部分未提交 | 差 36 行 |
| ZC-DEEP-b15 | 297 | `packages/ui/src/BotsDialog.tsx` | `0a1fc56d` | +269/-0 | 部分未提交 | 差 28 行 |
| ZC-DEEP-b15 | 324 | `apps/zcode-cli/packages/debug/server/analyzer.ts` | `3ead6c6a` | +324/-0 | 未提交 | — |
| ZC-DEEP-b16 | 276 | `packages/desktop/src/main/taskRealtimeBus.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b16 | 280 | `packages/ui/src/ElicitationDialog.tsx` | `aac47556` | +275/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b16 | 334 | `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx` | `aac47556` | +301/-0 | 部分未提交 | 差 33 行 |
| ZC-DEEP-b16 | 307 | `packages/ui/src/settings/SkillsSection.tsx` | `0a1fc56d` | +275/-0 | 部分未提交 | 差 32 行 |
| ZC-DEEP-b16 | 335 | `packages/ui/src/LexicalChatInput.tsx` | `aac47556` | +324/-0 | 部分未提交 | 差 11 行 |
| ZC-DEEP-b16 | 348 | `packages/ui/src/settings/ModelProviderSection.tsx` | `0a1fc56d` | +345/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b16 | 314 | `apps/dev-docs/src/App.tsx` | `55f48e6d` | +314/-0 | 未提交 | — |
| ZC-DEEP-b17 | 290 | `apps/zcode-cli/packages/core/src/browser-client/facade.ts` | `aac47556` | +290/-0 | 未提交 | — |
| ZC-DEEP-b17 | 278 | `packages/ui/src/remote-connection/RemoteConnectionConnectingStep.tsx` | `0a1fc56d` | +278/-0 | 未提交 | — |
| ZC-DEEP-b17 | 275 | `packages/ui/src/settings/model-provider-section/StatusCards.tsx` | `aac47556` | +275/-0 | 未提交 | — |
| ZC-DEEP-b17 | 319 | `packages/ui/src/command-center/CommandCenterDialog.tsx` | `0a1fc56d` | +319/-0 | 未提交 | — |
| ZC-DEEP-b17 | 418 | `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | `0a1fc56d` | +418/-0 | 未提交 | — |
| ZC-DEEP-b17 | 276 | `packages/ui/src/v4/ConversationShareConfirmationDock.tsx` | `0a1fc56d` | +276/-0 | 未提交 | — |
| ZC-DEEP-b17 | 290 | `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | `0a1fc56d` | +290/-0 | 未提交 | — |
| ZC-DEEP-b18 | 296 | `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` | `e6ff6fab` | +296/-0 | 未提交 | — |
| ZC-DEEP-b18 | 267 | `packages/ui/src/v4/composer/useComposerAttachments.ts` | `0a1fc56d` | +267/-0 | 未提交 | — |
| ZC-DEEP-b18 | 260 | `packages/ui/src/components/ui/pptx-preview-viewer.tsx` | `872ad960` | +260/-0 | 未提交 | — |
| ZC-DEEP-b18 | 262 | `packages/desktop/src/main/desktopStabilityTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b18 | 262 | `packages/formal-proof/src/main.ts` | `872ad960` | +262/-0 | 未提交 | — |
| ZC-DEEP-b18 | 255 | `packages/formal-proof/src/model.ts` | `872ad960` | +255/-0 | 未提交 | — |
| ZC-DEEP-b18 | 300 | `packages/server/src/remote/remoteAssetInstaller.ts` | `0a1fc56d` | +300/-0 | 未提交 | — |
| ZC-DEEP-b18 | 259 | `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts` | `26a74c66` | +351/-0 | 台账与实测不符 | 超出 92 行 |
| ZC-DEEP-b19 | 250 | `apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts` | `ccc8ef74` | +250/-0 | 未提交 | — |
| ZC-DEEP-b19 | 254 | `packages/desktop/src/host/sourceServerDirectory.ts` | `e6ff6fab` | +254/-0 | 未提交 | — |
| ZC-DEEP-b19 | 243 | `packages/ui/src/store/taskQueryCacheStore.ts` | `aac47556` | +243/-0 | 未提交 | — |
| ZC-DEEP-b19 | 250 | `packages/desktop/src/main/exportLogs.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b19 | 240 | `packages/ui/src/lib/conversationTelemetryLegacyParityE2E.ts` | `aac47556` | +240/-0 | 未提交 | — |
| ZC-DEEP-b19 | 244 | `packages/ui/src/TaskListItem.tsx` | `3c5b2276` | +244/-0 | 未提交 | — |
| ZC-DEEP-b19 | 236 | `packages/shared/src/web-remote-control.ts` | `0a1fc56d` | +236/-0 | 未提交 | — |
| ZC-DEEP-b19 | 235 | `packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx` | `0a1fc56d` | +235/-0 | 未提交 | — |
| ZC-DEEP-b20 | 243 | `apps/zcode-cli/packages/adapters/src/fs/index.ts` | `522e851e` | +243/-0 | 未提交 | — |
| ZC-DEEP-b20 | 431 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | `ee933d52` | +431/-0 | 未提交 | — |
| ZC-DEEP-b20 | 227 | `packages/shared/src/bots.ts` | `0a1fc56d` | +227/-0 | 未提交 | — |
| ZC-DEEP-b20 | 225 | `packages/ui/src/settings/PluginStorePage.tsx` | `0a1fc56d` | +225/-0 | 未提交 | — |
| ZC-DEEP-b20 | 225 | `packages/web/src/share/ConversationShareLandingPage.tsx` | `0a1fc56d` | +225/-0 | 未提交 | — |
| ZC-DEEP-b20 | 222 | `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts` | `0a1fc56d` | +222/-0 | 未提交 | — |
| ZC-DEEP-b20 | 221 | `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx` | `aac47556` | +221/-0 | 未提交 | — |
| ZC-DEEP-b20 | 222 | `packages/ui/src/RemoteConnectionDialogContent.tsx` | `0a1fc56d` | +222/-0 | 未提交 | — |
| ZC-DEEP-b20 | 235 | `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts` | `0a1fc56d` | +235/-0 | 未提交 | — |
| ZC-DEEP-b21 | 221 | `packages/ui/src/v4/workbenchGroupStore.ts` | `aac47556` | +221/-0 | 未提交 | — |
| ZC-DEEP-b21 | 227 | `packages/desktop/src/host/sourceServerConnectionManager.ts` | `e6ff6fab` | +227/-0 | 未提交 | — |
| ZC-DEEP-b21 | 230 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` | `0f2ef80d` | +230/-0 | 未提交 | — |
| ZC-DEEP-b21 | 215 | `packages/ui/src/project-sidebar/grouped/group-item.tsx` | `0a1fc56d` | +215/-0 | 未提交 | — |
| ZC-DEEP-b21 | 242 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` | `ee933d52` | +242/-0 | 未提交 | — |
| ZC-DEEP-b21 | 217 | `packages/shared/src/web-remote-control-rpc-transport.ts` | `aac47556` | +217/-0 | 未提交 | — |
| ZC-DEEP-b21 | 216 | `packages/ui/src/lib/remoteWorkspaceHistory.ts` | `0a1fc56d` | +216/-0 | 未提交 | — |
| ZC-DEEP-b21 | 217 | `packages/ui/src/project-sidebar/ProjectEditor.tsx` | `0a1fc56d` | +217/-0 | 未提交 | — |
| ZC-DEEP-b21 | 214 | `packages/ui/src/ModelConfigSelect.tsx` | `3c5b2276` | +214/-0 | 未提交 | — |
| ZC-DEEP-b22 | 206 | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` | `522e851e` | +206/-0 | 未提交 | — |
| ZC-DEEP-b22 | 207 | `packages/ui/src/PermissionDialog.tsx` | `0a1fc56d` | +207/-0 | 未提交 | — |
| ZC-DEEP-b22 | 209 | `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts` | `0a1fc56d` | +297/-6 | 台账与实测不符 | 超出 88 行 |
| ZC-DEEP-b22 | 202 | `packages/ui/src/WorkspaceHeaderSections.tsx` | `0a1fc56d` | +202/-0 | 未提交 | — |
| ZC-DEEP-b22 | 203 | `apps/dev-docs/src/data/productCapabilityMap.ts` | `55f48e6d` | +203/-0 | 未提交 | — |
| ZC-DEEP-b22 | 191 | `packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx` | `872ad960` | +191/-0 | 未提交 | — |
| ZC-DEEP-b22 | 190 | `packages/ui/src/settings/OffPeakEditView.tsx` | `0a1fc56d` | +190/-0 | 未提交 | — |
| ZC-DEEP-b22 | 198 | `packages/desktop/src/main/desktopMainIpcRemote.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b22 | 191 | `packages/provider/src/config-service.ts` | `872ad960` | +191/-0 | 未提交 | — |
| ZC-DEEP-b23 | 192 | `packages/desktop/src/main/chromeLocalStorageManager.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b23 | 190 | `packages/ui/src/v4/ConversationDraftSuggestedPromptsContainer.tsx` | `0a1fc56d` | +190/-0 | 未提交 | — |
| ZC-DEEP-b23 | 198 | `packages/desktop/src/host/windowHostControllerService.ts` | `e6ff6fab` | +198/-0 | 未提交 | — |
| ZC-DEEP-b23 | 188 | `packages/provider/src/facades.ts` | `872ad960` | +188/-0 | 未提交 | — |
| ZC-DEEP-b23 | 188 | `packages/ui/src/components/ui/code-viewer.tsx` | `872ad960` | +188/-0 | 未提交 | — |
| ZC-DEEP-b23 | 188 | `packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts` | `0a1fc56d` | +188/-0 | 未提交 | — |
| ZC-DEEP-b23 | 185 | `packages/desktop/src/main/desktopCommandHandlers.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b23 | 184 | `packages/desktop/src/main/forceUpdatePrompt.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b24 | 189 | `packages/ui/src/terminal/TerminalSession.tsx` | `872ad960` | +189/-0 | 未提交 | — |
| ZC-DEEP-b24 | 183 | `packages/ui/src/lib/webElementPickerScript.ts` | `872ad960` | +183/-0 | 未提交 | — |
| ZC-DEEP-b24 | 184 | `packages/ui/src/TreemappingPane.tsx` | `872ad960` | +184/-0 | 未提交 | — |
| ZC-DEEP-b24 | 181 | `packages/ui/src/settings/RemoteMcpSyncDialog.tsx` | `aac47556` | +181/-0 | 未提交 | — |
| ZC-DEEP-b24 | 181 | `packages/desktop/src/main/desktopHostProcess.ts` | `cea5a675` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b24 | 180 | `packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts` | `0a1fc56d` | +180/-0 | 未提交 | — |
| ZC-DEEP-b24 | 176 | `apps/zcode-cli/packages/cli/src/run.ts` | `e0060254` | +176/-0 | 未提交 | — |
| ZC-DEEP-b24 | 174 | `packages/ui/src/v4/featureSuggestedPrompts.ts` | `872ad960` | +124/-0 | 部分未提交 | 差 50 行 |
| ZC-DEEP-b25 | 173 | `apps/zcode-cli/packages/core/src/browser-client/manifest.ts` | `872ad960` | +173/-0 | 未提交 | — |
| ZC-DEEP-b25 | 178 | `packages/ui/src/browser-use/UnifiedBrowserView.tsx` | `aac47556` | +178/-0 | 未提交 | — |
| ZC-DEEP-b25 | 176 | `packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts` | `aac47556` | +176/-0 | 未提交 | — |
| ZC-DEEP-b25 | 173 | `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx` | `0a1fc56d` | +173/-0 | 未提交 | — |
| ZC-DEEP-b25 | 174 | `packages/ui/src/mentions/MentionPlugin.tsx` | `0a1fc56d` | +174/-0 | 未提交 | — |
| ZC-DEEP-b25 | 180 | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | `0f2ef80d` | +180/-0 | 未提交 | — |
| ZC-DEEP-b25 | 168 | `packages/ui/src/lib/treemappingActivity.ts` | `0a1fc56d` | +168/-0 | 未提交 | — |
| ZC-DEEP-b25 | 166 | `packages/ui/src/web-remote-control/WebRemoteControlDialog.tsx` | `0a1fc56d` | +166/-0 | 未提交 | — |
| ZC-DEEP-b26 | 165 | `packages/ui/src/components/ai-elements/image-preview-dialog.tsx` | `0a1fc56d` | +165/-0 | 未提交 | — |
| ZC-DEEP-b26 | 164 | `packages/ui/src/project-sidebar/ProjectComposerMenu.tsx` | `0a1fc56d` | +164/-0 | 未提交 | — |
| ZC-DEEP-b26 | 165 | `packages/ui/src/root/useRootWorkspaceActions.ts` | `0a1fc56d` | +165/-0 | 未提交 | — |
| ZC-DEEP-b26 | 162 | `packages/ui/src/project-sidebar/grouped/view.ts` | `0a1fc56d` | +162/-0 | 未提交 | — |
| ZC-DEEP-b26 | 162 | `packages/server/src/remote/wsl-backend.ts` | `0a1fc56d` | +162/-0 | 未提交 | — |
| ZC-DEEP-b26 | 158 | `packages/ui/src/lib/codeViewer.ts` | `aac47556` | +158/-0 | 未提交 | — |
| ZC-DEEP-b26 | 160 | `packages/zcode-server-cli/src/cli.ts` | `0a1fc56d` | +160/-0 | 未提交 | — |
| ZC-DEEP-b27 | 160 | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts` | `522e851e` | +160/-0 | 未提交 | — |
| ZC-DEEP-b27 | 159 | `packages/ui/src/v4/agentConversationTransport.ts` | `0a1fc56d` | +159/-0 | 未提交 | — |
| ZC-DEEP-b27 | 158 | `packages/ui/src/settings/ComputerUseSection.tsx` | `872ad960` | +158/-0 | 未提交 | — |
| ZC-DEEP-b27 | 156 | `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts` | `aac47556` | +156/-0 | 未提交 | — |
| ZC-DEEP-b27 | 159 | `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` | `0f2ef80d` | +159/-0 | 未提交 | — |
| ZC-DEEP-b27 | 156 | `packages/server/src/remote/deploy.ts` | `872ad960` | +156/-0 | 未提交 | — |
| ZC-DEEP-b27 | 155 | `packages/shared/src/validationAppSettings.ts` | `3c5b2276` | +155/-0 | 未提交 | — |
| ZC-DEEP-b27 | 153 | `packages/ui/src/project-sidebar/TaskGroupedView.tsx` | `3c5b2276` | +153/-0 | 未提交 | — |
| ZC-DEEP-b28 | 153 | `packages/ui/src/settings/PluginStoreDetailView.tsx` | `3c5b2276` | +153/-0 | 未提交 | — |
| ZC-DEEP-b28 | 155 | `packages/ui/src/store/mcpStore.ts` | `0a1fc56d` | +155/-0 | 未提交 | — |
| ZC-DEEP-b28 | 154 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts` | `0f2ef80d` | +154/-0 | 未提交 | — |
| ZC-DEEP-b28 | 152 | `packages/shared/src/zcode-protocol-v4/wire-assembler.ts` | `aac47556` | +152/-0 | 未提交 | — |
| ZC-DEEP-b28 | 149 | `packages/ui/src/components/ai-elements/voice-selector.tsx` | `aac47556` | +149/-0 | 未提交 | — |
| ZC-DEEP-b28 | 149 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts` | `0f2ef80d` | +149/-0 | 未提交 | — |
| ZC-DEEP-b28 | 148 | `packages/desktop/scripts/mcp-apps-host-fixture/background-main.ts` | `0a1fc56d` | +148/-0 | 未提交 | — |
| ZC-DEEP-b28 | 148 | `packages/ui/src/BotsDialog/ProviderSettingsCard.tsx` | `aac47556` | +148/-0 | 未提交 | — |
| ZC-DEEP-b29 | 148 | `packages/ui/src/settings/PluginStoreListView.tsx` | `0a1fc56d` | +148/-0 | 未提交 | — |
| ZC-DEEP-b29 | 145 | `packages/ui/src/settings/CommandsSection.tsx` | `0a1fc56d` | +145/-0 | 未提交 | — |
| ZC-DEEP-b29 | 143 | `packages/ui/src/settings/RemoteSkillSyncDialog.tsx` | `aac47556` | +143/-0 | 未提交 | — |
| ZC-DEEP-b29 | 138 | `packages/ui/src/settings/HooksSection.tsx` | `0a1fc56d` | +138/-0 | 未提交 | — |
| ZC-DEEP-b29 | 138 | `packages/ui/src/settings/model-provider-section/useCodingPlanProducts.ts` | `0a1fc56d` | +138/-0 | 未提交 | — |
| ZC-DEEP-b29 | 145 | `packages/ui/src/ToolCallBlocks/renderers/explore.tsx` | `0a1fc56d` | +145/-0 | 未提交 | — |
| ZC-DEEP-b29 | 139 | `packages/ui/src/GitPane.tsx` | `0a1fc56d` | +116/-0 | 部分未提交 | 差 23 行 |
| ZC-DEEP-b29 | 138 | `packages/ui/src/WorkspaceSidebarFooter.tsx` | `0a1fc56d` | +106/-0 | 部分未提交 | 差 32 行 |
| ZC-DEEP-b29 | 135 | `packages/ui/src/OpenSplitButton.tsx` | `0a1fc56d` | +92/-0 | 部分未提交 | 差 43 行 |
| ZC-DEEP-b29 | 135 | `packages/ui/src/previewPaneContent.tsx` | `0a1fc56d` | +103/-0 | 部分未提交 | 差 32 行 |
| ZC-DEEP-b29 | 135 | `packages/ui/src/TaskList.tsx` | `0a1fc56d` | +101/-0 | 部分未提交 | 差 34 行 |
| ZC-DEEP-b30 | 139 | `packages/ui/src/components/ai-elements/stack-trace.tsx` | `aac47556` | +139/-0 | 未提交 | — |
| ZC-DEEP-b30 | 134 | `packages/ui/src/components/ai-elements/reasoning.tsx` | `0a1fc56d` | +134/-0 | 未提交 | — |
| ZC-DEEP-b30 | 132 | `packages/ui/src/components/ai-elements/schema-display.tsx` | `aac47556` | +132/-0 | 未提交 | — |
| ZC-DEEP-b30 | 138 | `packages/ui/src/project-sidebar/grouped/task-row.tsx` | `0a1fc56d` | +138/-0 | 未提交 | — |
| ZC-DEEP-b30 | 130 | `packages/ui/src/project-sidebar/grouped/drag.ts` | `0a1fc56d` | +130/-0 | 未提交 | — |
| ZC-DEEP-b30 | 138 | `packages/ui/src/hooks/useGitRepository.ts` | `aac47556` | +138/-0 | 未提交 | — |
| ZC-DEEP-b30 | 135 | `packages/ui/src/hooks/useSettingsSync.ts` | `0a1fc56d` | +135/-0 | 未提交 | — |
| ZC-DEEP-b30 | 131 | `packages/ui/src/hooks/useBuiltinAgentCli.ts` | `aac47556` | +131/-0 | 未提交 | — |
| ZC-DEEP-b30 | 138 | `packages/ui/src/store/automationManagementStore.ts` | `0a1fc56d` | +138/-0 | 未提交 | — |
| ZC-DEEP-b30 | 133 | `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx` | `0a1fc56d` | +133/-0 | 未提交 | — |
| ZC-DEEP-b30 | 148 | `packages/ui/src/side-pane-full-view/ConversationHost.tsx` | `3c5b2276` | +148/-0 | 未提交 | — |
| ZC-DEEP-b30 | 145 | `packages/ui/src/v4/composer/useDraftConfigControl.ts` | `0a1fc56d` | +145/-0 | 未提交 | — |
| ZC-DEEP-b31 | 146 | `packages/shared/src/task-realtime-core.ts` | `aac47556` | +146/-0 | 未提交 | — |
| ZC-DEEP-b31 | 143 | `packages/shared/src/coding-plan-subscription.ts` | `aac47556` | +143/-0 | 未提交 | — |
| ZC-DEEP-b31 | 140 | `packages/shared/src/zcode-protocol-legacy-types.ts` | `3c5b2276` | +140/-0 | 未提交 | — |
| ZC-DEEP-b31 | 148 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` | `deb218da` | +148/-0 | 未提交 | — |
| ZC-DEEP-b31 | 145 | `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts` | `522e851e` | +145/-0 | 未提交 | — |
| ZC-DEEP-b31 | 142 | `apps/zcode-cli/packages/core/src/runtime/methods/events.ts` | `c788b9f1` | +142/-0 | 未提交 | — |
| ZC-DEEP-b31 | 146 | `packages/ui/src/feedback/feedbackSubmissionJob.ts` | `aac47556` | +146/-0 | 未提交 | — |
| ZC-DEEP-b31 | 142 | `packages/ui/src/root/useRootPlatformEffects.ts` | `0a1fc56d` | +142/-0 | 未提交 | — |
| ZC-DEEP-b31 | 135 | `packages/ui/src/ToolCallBlocks/renderers/cua.tsx` | `aac47556` | +135/-0 | 未提交 | — |
| ZC-DEEP-b31 | 139 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-renderer.tsx` | `0a1fc56d` | +139/-0 | 未提交 | — |
| ZC-DEEP-b31 | 139 | `packages/desktop/src/main/editors.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b31 | 142 | `packages/desktop/src/preload/index.ts` | `0a1fc56d` | +142/-0 | 未提交 | — |
| ZC-DEEP-b32 | 147 | `packages/provider/src/config/model-config.ts` | `872ad960` | +147/-0 | 未提交 | — |
| ZC-DEEP-b32 | 128 | `packages/provider/src/config/provider-config.ts` | `872ad960` | +128/-0 | 未提交 | — |
| ZC-DEEP-b32 | 135 | `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts` | `0a1fc56d` | +135/-0 | 未提交 | — |
| ZC-DEEP-b32 | 131 | `apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts` | `55fedda3` | +131/-0 | 未提交 | — |
| ZC-DEEP-b32 | 131 | `apps/zcode-cli/packages/core/src/browser-client/playwright.ts` | `c788b9f1` | +131/-0 | 未提交 | — |
| ZC-DEEP-b32 | 135 | `packages/shared/src/browser-use/commands.ts` | `aac47556` | +135/-0 | 未提交 | — |
| ZC-DEEP-b32 | 127 | `packages/desktop/src/main/windowsChromeAppBoundKey.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b32 | 133 | `packages/ui/src/v4/pendingCommandRegistry.ts` | `0a1fc56d` | +133/-0 | 未提交 | — |
| ZC-DEEP-b32 | 129 | `packages/ui/src/store/pluginStore.ts` | `872ad960` | +129/-0 | 未提交 | — |
| ZC-DEEP-b32 | 128 | `packages/ui/src/ToolCallBlocks/renderers/edit.tsx` | `872ad960` | +128/-0 | 未提交 | — |
| ZC-DEEP-b32 | 127 | `packages/ui/src/components/ai-elements/code-block.tsx` | `872ad960` | +127/-0 | 未提交 | — |
| ZC-DEEP-b32 | 126 | `packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx` | `aac47556` | +126/-0 | 未提交 | — |
| ZC-DEEP-b33 | 126 | `packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts` | `872ad960` | +126/-0 | 未提交 | — |
| ZC-DEEP-b33 | 125 | `packages/ui/src/settings/model-provider-section/Navigation.tsx` | `0a1fc56d` | +125/-0 | 未提交 | — |
| ZC-DEEP-b33 | 128 | `packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts` | `aac47556` | +128/-0 | 未提交 | — |
| ZC-DEEP-b33 | 122 | `packages/ui/src/settings/HookForm.tsx` | `0a1fc56d` | +122/-0 | 未提交 | — |
| ZC-DEEP-b33 | 121 | `packages/ui/src/settings/BrowserSettingsSection.tsx` | `0a1fc56d` | +121/-0 | 未提交 | — |
| ZC-DEEP-b33 | 126 | `packages/ui/src/v4/officeSuggestedPrompts.ts` | `aac47556` | +126/-0 | 未提交 | — |
| ZC-DEEP-b33 | 124 | `packages/ui/src/components/ui/toast.tsx` | `0a1fc56d` | +124/-0 | 未提交 | — |
| ZC-DEEP-b33 | 123 | `packages/ui/src/ModelTrajectoryPaneParts.tsx` | `872ad960` | +123/-0 | 未提交 | — |
| ZC-DEEP-b33 | 122 | `packages/ui/src/GitBranchSwitcher.tsx` | `aac47556` | +122/-0 | 未提交 | — |
| ZC-DEEP-b33 | 123 | `packages/ui/src/plugin-ui/adapters/pluginUiManagedPage.ts` | `0a1fc56d` | +123/-0 | 未提交 | — |
| ZC-DEEP-b33 | 120 | `packages/ui/src/mentions/components/MentionPanel.tsx` | `0a1fc56d` | +120/-0 | 未提交 | — |
| ZC-DEEP-b33 | 125 | `packages/ui/src/CodingPlanUsageRemainingPanel.tsx` | `aac47556` | +125/-0 | 未提交 | — |
| ZC-DEEP-b34 | 131 | `apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx` | `55f48e6d` | +131/-0 | 未提交 | — |
| ZC-DEEP-b34 | 128 | `packages/desktop/scripts/gen-ui-fixture/main.ts` | `0a1fc56d` | +128/-0 | 未提交 | — |
| ZC-DEEP-b34 | 126 | `packages/server/src/remote/zcodeAgentDevDeploy.ts` | `3c5b2276` | +126/-0 | 未提交 | — |
| ZC-DEEP-b34 | 125 | `packages/desktop/src/main/chromeCookieManager.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b34 | 126 | `apps/zcode-cli/packages/core/src/permission/service.ts` | `0a1fc56d` | +126/-0 | 未提交 | — |
| ZC-DEEP-b34 | 124 | `packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b34 | 126 | `packages/zcode-server-cli/src/supervisor/supervisor.ts` | `0a1fc56d` | +126/-0 | 未提交 | — |
| ZC-DEEP-b34 | 130 | `packages/shared/src/zcode-protocol-v4/transport.ts` | `0a1fc56d` | +130/-0 | 未提交 | — |
| ZC-DEEP-b34 | 120 | `packages/ui/src/settings/InstalledPluginManagement.tsx` | `0a1fc56d` | +120/-0 | 未提交 | — |
| ZC-DEEP-b34 | 123 | `packages/ui/src/store/tabStore.ts` | `0a1fc56d` | +123/-0 | 未提交 | — |
| ZC-DEEP-b34 | 122 | `packages/ui/src/components/ai-elements/prompt-input.tsx` | `872ad960` | +122/-0 | 未提交 | — |
| ZC-DEEP-b34 | 123 | `packages/ui/src/v4/sessionsIndexStore.ts` | `aac47556` | +123/-0 | 未提交 | — |
| ZC-DEEP-b35 | 119 | `packages/desktop/scripts/mcp-apps-host-fixture/chain-main.ts` | `aac47556` | +119/-0 | 未提交 | — |
| ZC-DEEP-b35 | 118 | `packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts` | `0a1fc56d` | +118/-0 | 未提交 | — |
| ZC-DEEP-b35 | 119 | `packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts` | `aac47556` | +119/-0 | 未提交 | — |
| ZC-DEEP-b35 | 118 | `packages/shared/src/source-server/contracts.ts` | `0a1fc56d` | +118/-0 | 未提交 | — |
| ZC-DEEP-b35 | 121 | `apps/zcode-cli/packages/office-runtime/ui/main.tsx` | `a7af675d` | +121/-0 | 未提交 | — |
| ZC-DEEP-b35 | 116 | `packages/server/src/http.ts` | `0a1fc56d` | +116/-0 | 未提交 | — |
| ZC-DEEP-b35 | 120 | `packages/ui/src/v4/telemetry/conversationTelemetryParityE2E.ts` | `aac47556` | +120/-0 | 未提交 | — |
| ZC-DEEP-b35 | 119 | `packages/ui/src/git-branch-switcher/GitBranchDialogs.tsx` | `872ad960` | +119/-0 | 未提交 | — |
| ZC-DEEP-b35 | 120 | `packages/ui/src/project-sidebar/ProjectNodeContent.tsx` | `0a1fc56d` | +120/-0 | 未提交 | — |
| ZC-DEEP-b35 | 118 | `packages/ui/src/project-sidebar/index.tsx` | `3c5b2276` | +118/-0 | 未提交 | — |
| ZC-DEEP-b35 | 118 | `packages/ui/src/store/subagentsStore.ts` | `0a1fc56d` | +118/-0 | 未提交 | — |
| ZC-DEEP-b35 | 117 | `packages/ui/src/onboarding/OnboardingFlowParts.tsx` | `872ad960` | +117/-0 | 未提交 | — |
| ZC-DEEP-b36 | 116 | `packages/ui/src/lib/conversationShareError.ts` | `0a1fc56d` | +116/-0 | 未提交 | — |
| ZC-DEEP-b36 | 116 | `packages/ui/src/v4/ConversationFileSummaryPanel.tsx` | `aac47556` | +116/-0 | 未提交 | — |
| ZC-DEEP-b36 | 119 | `packages/desktop/src/main/desktopWindowChrome.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b36 | 115 | `packages/desktop/src/main/desktopZCodeDataSizeTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b36 | 117 | `packages/server/src/remote/ssh-backend.ts` | `cd758978` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b36 | 114 | `packages/desktop/src/main/browserView/browserPlaywrightDomSnapshot.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b36 | 115 | `packages/ui/src/settings/McpServerForm.tsx` | `0a1fc56d` | +115/-0 | 未提交 | — |
| ZC-DEEP-b36 | 115 | `packages/ui/src/TaskSearchDialog.tsx` | `aac47556` | +115/-0 | 未提交 | — |
| ZC-DEEP-b36 | 115 | `packages/ui/src/workspace-file-tree/model.ts` | `872ad960` | +115/-0 | 未提交 | — |
| ZC-DEEP-b36 | 114 | `packages/ui/src/components/marketing-touch/MarketingTouchProvider.tsx` | `aac47556` | +114/-0 | 未提交 | — |
| ZC-DEEP-b36 | 114 | `packages/ui/src/feedback/FeedbackSubmitForm.tsx` | `aac47556` | +114/-0 | 未提交 | — |
| ZC-DEEP-b36 | 113 | `packages/ui/src/settings/usage-stats/CodingPlanUsageBarChart.tsx` | `872ad960` | +113/-0 | 未提交 | — |
| ZC-DEEP-b37 | 117 | `apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts` | `872ad960` | +199/-8 | 台账与实测不符 | 超出 82 行 |
| ZC-DEEP-b37 | 116 | `apps/zcode-cli/packages/office-runtime/src/adapters/server.ts` | `a7af675d` | +116/-0 | 未提交 | — |
| ZC-DEEP-b37 | 114 | `apps/zcode-cli/packages/office-runtime/ui/shell/parts.tsx` | `a7af675d` | +114/-0 | 未提交 | — |
| ZC-DEEP-b37 | 112 | `packages/shared/src/index.ts` | `0a1fc56d` | +112/-0 | 未提交 | — |
| ZC-DEEP-b37 | 111 | `packages/shared/src/background-task-controls.ts` | `872ad960` | +111/-0 | 未提交 | — |
| ZC-DEEP-b37 | 111 | `packages/shared/src/conversation-preview-artifacts.ts` | `872ad960` | +111/-0 | 未提交 | — |
| ZC-DEEP-b37 | 114 | `packages/ui/src/hooks/useUsageEntitlement.ts` | `0a1fc56d` | +114/-0 | 未提交 | — |
| ZC-DEEP-b37 | 113 | `packages/ui/src/lib/chatAttachments.ts` | `aac47556` | +113/-0 | 未提交 | — |
| ZC-DEEP-b37 | 115 | `packages/ui/src/WelcomeScreen.tsx` | `0a1fc56d` | +115/-0 | 未提交 | — |
| ZC-DEEP-b37 | 112 | `packages/ui/src/v4/ConversationQueuePanel.tsx` | `0a1fc56d` | +112/-0 | 未提交 | — |
| ZC-DEEP-b37 | 111 | `packages/ui/src/v4/useConversationTimelineFind.ts` | `aac47556` | +111/-0 | 未提交 | — |
| ZC-DEEP-b37 | 112 | `packages/desktop/src/main/desktopMainIpcPlatform.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b38 | 110 | `packages/server/src/remote/localTarGz.ts` | `872ad960` | +110/-0 | 未提交 | — |
| ZC-DEEP-b38 | 110 | `packages/ui/src/settings/saved-workflows/SavedWorkflowDetailView.tsx` | `0a1fc56d` | +110/-0 | 未提交 | — |
| ZC-DEEP-b38 | 106 | `packages/ui/src/ToolCallBlocks/renderers/agent.tsx` | `0a1fc56d` | +106/-0 | 未提交 | — |
| ZC-DEEP-b38 | 112 | `packages/ui/src/chat-input-toolbar/display.tsx` | `0a1fc56d` | +112/-0 | 未提交 | — |
| ZC-DEEP-b38 | 111 | `packages/desktop/src/main/desktopOAuthDeepLink.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b38 | 111 | `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx` | `aac47556` | +111/-0 | 未提交 | — |
| ZC-DEEP-b38 | 107 | `packages/ui/src/components/ai-elements/open-in-chat.tsx` | `aac47556` | +107/-0 | 未提交 | — |
| ZC-DEEP-b38 | 110 | `packages/ui/src/ToolCallBlocks/renderers/node-repl.tsx` | `872ad960` | +110/-0 | 未提交 | — |
| ZC-DEEP-b38 | 109 | `packages/ui/src/feedback/FeatureRequestDialog.tsx` | `0a1fc56d` | +109/-0 | 未提交 | — |
| ZC-DEEP-b38 | 110 | `packages/ui/src/prompt-editor/ChatPromptEditor.tsx` | `3c5b2276` | +110/-0 | 未提交 | — |
| ZC-DEEP-b38 | 107 | `packages/ui/src/ToolCallBlocks/renderers/execute.tsx` | `aac47556` | +107/-0 | 未提交 | — |
| ZC-DEEP-b38 | 109 | `packages/desktop/src/main/networkTelemetryAggregator.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b39 | 106 | `packages/ui/src/WhiteboardPane.tsx` | `872ad960` | +106/-0 | 未提交 | — |
| ZC-DEEP-b39 | 106 | `packages/ui/src/git-graph/GitGraphPane.tsx` | `aac47556` | +106/-0 | 未提交 | — |
| ZC-DEEP-b39 | 107 | `packages/ui/src/lib/assistantPreviewCards.ts` | `aac47556` | +107/-0 | 未提交 | — |
| ZC-DEEP-b39 | 105 | `packages/ui/src/lib/askUserQuestion.ts` | `aac47556` | +105/-0 | 未提交 | — |
| ZC-DEEP-b39 | 106 | `packages/ui/src/lib/taskChangeSummary.ts` | `aac47556` | +91/-0 | 部分未提交 | 差 15 行 |
| ZC-DEEP-b39 | 107 | `packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx` | `0a1fc56d` | +107/-0 | 未提交 | — |
| ZC-DEEP-b39 | 106 | `packages/ui/src/components/ui/pdf-viewer.tsx` | `872ad960` | +106/-0 | 未提交 | — |
| ZC-DEEP-b39 | 109 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts` | `0f2ef80d` | +109/-0 | 未提交 | — |
| ZC-DEEP-b39 | 108 | `packages/ui/src/store/pluginManagementStore.ts` | `0a1fc56d` | +108/-0 | 未提交 | — |
| ZC-DEEP-b39 | 108 | `packages/ui/src/v4/V4WorkspaceChatArea.tsx` | `3c5b2276` | +108/-0 | 未提交 | — |
| ZC-DEEP-b39 | 109 | `apps/zcode-cli/packages/cli/src/prompt-command.ts` | `e0060254` | +109/-0 | 未提交 | — |
| ZC-DEEP-b39 | 110 | `apps/zcode-cli/packages/office-runtime/ui/viewers/PdfView.tsx` | `a7af675d` | +110/-0 | 未提交 | — |
| ZC-DEEP-b40 | 105 | `packages/shared/src/zcodeEndpoint.ts` | `0a1fc56d` | +105/-0 | 未提交 | — |
| ZC-DEEP-b40 | 105 | `apps/zcode-cli/packages/telemetry/src/bootstrap.ts` | `872ad960` | +105/-0 | 未提交 | — |
| ZC-DEEP-b40 | 107 | `packages/server/src/source-server/transportAdapter.ts` | `0a1fc56d` | +107/-0 | 未提交 | — |
| ZC-DEEP-b40 | 106 | `packages/ui/src/hooks/useRemoteConnectionForm.ts` | `0a1fc56d` | +106/-0 | 未提交 | — |
| ZC-DEEP-b40 | 107 | `packages/desktop/src/host/windowHostControllerProjection.ts` | `e6ff6fab` | +107/-0 | 未提交 | — |
| ZC-DEEP-b40 | 106 | `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` | `bce5596a` | +185/-0 | 台账与实测不符 | 超出 79 行 |
| ZC-DEEP-b40 | 111 | `apps/zcode-cli/packages/adapters/src/plugins/index.ts` | `522e851e` | +111/-0 | 未提交 | — |
| ZC-DEEP-b40 | 105 | `packages/provider/src/resolver.ts` | `872ad960` | +105/-0 | 未提交 | — |
| ZC-DEEP-b40 | 107 | `packages/ui/src/app-shell/SidePaneTabTrigger.tsx` | `0a1fc56d` | +107/-0 | 未提交 | — |
| ZC-DEEP-b40 | 106 | `packages/ui/src/SlashCommandPlugin.tsx` | `0a1fc56d` | +106/-0 | 未提交 | — |
| ZC-DEEP-b40 | 106 | `packages/ui/src/gen-ui/adapters/page.ts` | `0a1fc56d` | +106/-0 | 未提交 | — |
| ZC-DEEP-b40 | 106 | `packages/ui/src/ModelTrajectoryPane.tsx` | `aac47556` | +106/-0 | 未提交 | — |
| ZC-DEEP-b41 | 103 | `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx` | `872ad960` | +103/-0 | 未提交 | — |
| ZC-DEEP-b41 | 106 | `packages/ui/src/settings/model-provider-section/enterpriseCodingPlanProducts.ts` | `aac47556` | +106/-0 | 未提交 | — |
| ZC-DEEP-b41 | 103 | `apps/zcode-cli/packages/core/src/runtime/methods/index.ts` | `55fedda3` | +103/-0 | 未提交 | — |
| ZC-DEEP-b41 | 104 | `packages/ui/src/onboarding/OnboardingDialog.tsx` | `0a1fc56d` | +104/-0 | 未提交 | — |
| ZC-DEEP-b41 | 105 | `packages/ui/src/lib/planModeTool.ts` | `aac47556` | +105/-0 | 未提交 | — |
| ZC-DEEP-b41 | 105 | `packages/ui/src/lib/settingsNavigation.ts` | `0a1fc56d` | +105/-0 | 未提交 | — |
| ZC-DEEP-b41 | 103 | `packages/e2e-report/src/viewer/trendData.ts` | `aac47556` | +103/-0 | 未提交 | — |
| ZC-DEEP-b41 | 104 | `packages/desktop/src/main/desktopCrashCapture.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b41 | 104 | `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b41 | 103 | `packages/ui/src/settings/saved-workflows/SavedWorkflowProjectGroup.tsx` | `0a1fc56d` | +103/-0 | 未提交 | — |
| ZC-DEEP-b41 | 104 | `apps/zcode-cli/packages/core/src/mcp/index.ts` | `0a1fc56d` | +104/-0 | 未提交 | — |
| ZC-DEEP-b41 | 104 | `packages/ui/src/v4/ConversationShareSelectionPanel.tsx` | `0a1fc56d` | +104/-0 | 未提交 | — |
| ZC-DEEP-b42 | 102 | `packages/desktop/scripts/mcp-apps-host-fixture/sampling-main.ts` | `aac47556` | +102/-0 | 未提交 | — |
| ZC-DEEP-b42 | 103 | `packages/desktop/scripts/mcp-apps-host-fixture/showcase-main.ts` | `aac47556` | +103/-0 | 未提交 | — |
| ZC-DEEP-b42 | 102 | `packages/desktop/src/main/openInEditor.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b42 | 103 | `packages/ui/src/highspeed/highspeedTurnStore.ts` | `aac47556` | +103/-0 | 未提交 | — |
| ZC-DEEP-b42 | 102 | `packages/ui/src/hooks/useUsageStats.ts` | `aac47556` | +102/-0 | 未提交 | — |
| ZC-DEEP-b42 | 102 | `packages/ui/src/ModelTrajectoryExpandableMessage.tsx` | `872ad960` | +102/-0 | 未提交 | — |
| ZC-DEEP-b42 | 109 | `packages/ui/src/settingsPageHelpers.tsx` | `3c5b2276` | +109/-0 | 未提交 | — |
| ZC-DEEP-b42 | 102 | `packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx` | `0a1fc56d` | +102/-0 | 未提交 | — |
| ZC-DEEP-b42 | 100 | `packages/ui/src/chat-input-toolbar/ComposerModelMenu.tsx` | `0a1fc56d` | +100/-0 | 未提交 | — |
| ZC-DEEP-b42 | 102 | `packages/ui/src/ToolCallBlocks/fileSummaryHeuristics.ts` | `872ad960` | +102/-0 | 未提交 | — |
| ZC-DEEP-b42 | 103 | `packages/ui/src/v4/WorkbenchPane.tsx` | `3c5b2276` | +103/-0 | 未提交 | — |
| ZC-DEEP-b42 | 100 | `packages/ui/src/EmbeddedBrowserPaneParts.tsx` | `0a1fc56d` | +100/-0 | 未提交 | — |
| ZC-DEEP-b43 | 101 | `packages/ui/src/lib/remoteConnectionWizard.ts` | `0a1fc56d` | +101/-0 | 未提交 | — |
| ZC-DEEP-b43 | 99 | `packages/ui/src/lib/remoteConnectionPresentation.ts` | `0a1fc56d` | +99/-0 | 未提交 | — |
| ZC-DEEP-b43 | 99 | `packages/ui/src/lib/webElementContext.ts` | `aac47556` | +99/-0 | 未提交 | — |
| ZC-DEEP-b43 | 100 | `packages/ui/src/settings/RemoteSyncActions.tsx` | `0a1fc56d` | +100/-0 | 未提交 | — |
| ZC-DEEP-b43 | 100 | `packages/ui/src/settings/OffPeakTaskList.tsx` | `0a1fc56d` | +100/-0 | 未提交 | — |
| ZC-DEEP-b43 | 98 | `packages/ui/src/settings/HooksList.tsx` | `aac47556` | +98/-0 | 未提交 | — |
| ZC-DEEP-b43 | 100 | `packages/ui/src/settings/usage-stats/UsageHeatmap.tsx` | `872ad960` | +100/-0 | 未提交 | — |
| ZC-DEEP-b43 | 99 | `packages/ui/src/components/ai-elements/context.tsx` | `872ad960` | +99/-0 | 未提交 | — |
| ZC-DEEP-b43 | 100 | `packages/ui/src/components/ai-elements/attachments.tsx` | `872ad960` | +100/-0 | 未提交 | — |
| ZC-DEEP-b43 | 98 | `packages/ui/src/components/ai-elements/mic-selector.tsx` | `aac47556` | +98/-0 | 未提交 | — |
| ZC-DEEP-b43 | 98 | `packages/ui/src/Terminal.tsx` | `0a1fc56d` | +98/-0 | 未提交 | — |
| ZC-DEEP-b43 | 98 | `packages/ui/src/DeveloperToolsPane.tsx` | `872ad960` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 101 | `packages/ui/src/hooks/useGitBranchSwitcher.ts` | `872ad960` | +101/-0 | 未提交 | — |
| ZC-DEEP-b44 | 101 | `packages/ui/src/presentation/presentationPdfPrintExport.ts` | `aac47556` | +101/-0 | 未提交 | — |
| ZC-DEEP-b44 | 99 | `packages/desktop/src/main/browserView/browserPlaywrightExecutor.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b44 | 100 | `packages/web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx` | `0a1fc56d` | +100/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/plugin-ui/app/pluginUiHostController.ts` | `aac47556` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/project-sidebar/useProjectTree.ts` | `0a1fc56d` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/remote-connection/RemoteConnectionSelection.tsx` | `0a1fc56d` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/v4/telemetry/localTtftObserver.ts` | `872ad960` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/v4/V4InteractionDialogs.tsx` | `aac47556` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 97 | `packages/ui/src/lib/toolIdentity.ts` | `0a1fc56d` | +97/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/root/useRootOAuthEffects.ts` | `0a1fc56d` | +98/-0 | 未提交 | — |
| ZC-DEEP-b44 | 98 | `packages/ui/src/onboarding/OccupationOnboarding.tsx` | `0a1fc56d` | +98/-0 | 未提交 | — |
| ZC-DEEP-b45 | 101 | `apps/zcode-cli/packages/core/src/agent/message-history.ts` | `c788b9f1` | +101/-0 | 未提交 | — |
| ZC-DEEP-b45 | 99 | `apps/zcode-cli/packages/tui/src/app.tsx` | `a7af675d` | +99/-0 | 未提交 | — |
| ZC-DEEP-b45 | 97 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts` | `54f51bad` | +97/-0 | 未提交 | — |
| ZC-DEEP-b45 | 97 | `packages/zcode-server-cli/src/runtime/componentCache.ts` | `872ad960` | +97/-0 | 未提交 | — |
| ZC-DEEP-b45 | 96 | `packages/web/src/web-remote-control/domain/webRemoteControlScreenCopy.ts` | `0a1fc56d` | +96/-0 | 未提交 | — |
| ZC-DEEP-b45 | 96 | `apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts` | `e0060254` | +96/-0 | 未提交 | — |
| ZC-DEEP-b45 | 96 | `packages/ui/src/ChatErrorBanner.tsx` | `0a1fc56d` | +96/-0 | 未提交 | — |
| ZC-DEEP-b45 | 95 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-permission-policy.ts` | `54f51bad` | +95/-0 | 未提交 | — |
| ZC-DEEP-b45 | 95 | `packages/desktop/src/main/chromeInstallationCandidates.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b45 | 95 | `packages/ui/src/components/ai-elements/test-results.tsx` | `872ad960` | +95/-0 | 未提交 | — |
| ZC-DEEP-b45 | 96 | `packages/ui/src/lib/userActionTelemetry.ts` | `aac47556` | +96/-0 | 未提交 | — |
| ZC-DEEP-b45 | 96 | `packages/ui/src/root/sourceServerUpdateNotifications.ts` | `0a1fc56d` | +96/-0 | 未提交 | — |
| ZC-DEEP-b46 | 97 | `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts` | `522e851e` | +97/-0 | 未提交 | — |
| ZC-DEEP-b46 | 96 | `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts` | `522e851e` | +96/-0 | 未提交 | — |
| ZC-DEEP-b46 | 95 | `packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx` | `872ad960` | +83/-0 | 部分未提交 | 差 12 行 |
| ZC-DEEP-b46 | 95 | `packages/ui/src/app-shell/WorkflowWorkspaceCard.tsx` | `872ad960` | +95/-0 | 未提交 | — |
| ZC-DEEP-b46 | 94 | `packages/ui/src/DirectoryBrowser.tsx` | `0a1fc56d` | +88/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b46 | 94 | `packages/ui/src/v4/composer/composerDraftStore.ts` | `0a1fc56d` | +94/-0 | 未提交 | — |
| ZC-DEEP-b46 | 94 | `packages/shared/src/project-access-token-client.ts` | `0a1fc56d` | +94/-0 | 未提交 | — |
| ZC-DEEP-b46 | 93 | `packages/ui/src/lib/chatErrorAttributionEvidence.ts` | `aac47556` | +93/-0 | 未提交 | — |
| ZC-DEEP-b46 | 93 | `packages/ui/src/project-sidebar/ChatRemoteFolderSelection.tsx` | `0a1fc56d` | +90/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b46 | 92 | `packages/ui/src/lib/nodeReplToolDisplay.ts` | `0a1fc56d` | +92/-0 | 未提交 | — |
| ZC-DEEP-b46 | 92 | `packages/shared/src/permission-request-preview.ts` | `872ad960` | +92/-0 | 未提交 | — |
| ZC-DEEP-b46 | 92 | `packages/ui/src/components/ui/chart.tsx` | `872ad960` | +85/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b47 | 94 | `packages/desktop/src/main/fileApplications.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b47 | 93 | `packages/desktop/src/main/browserView/browserVirtualClipboard.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b47 | 91 | `packages/desktop/src/main/desktopApplicationMenu.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b47 | 91 | `packages/desktop/src/main/windowsCuaOperationIndicator.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b47 | 92 | `packages/ui/src/components/ai-elements/markdown-image.tsx` | `872ad960` | +92/-0 | 未提交 | — |
| ZC-DEEP-b47 | 92 | `packages/ui/src/components/marketing-touch/marketingTouchController.ts` | `0a1fc56d` | +92/-0 | 未提交 | — |
| ZC-DEEP-b47 | 92 | `packages/ui/src/highspeed/HighspeedShareNoticeCard.tsx` | `aac47556` | +83/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b47 | 92 | `packages/ui/src/previewPaneImageContent.tsx` | `0a1fc56d` | +89/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b47 | 92 | `packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx` | `872ad960` | +90/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b47 | 90 | `packages/ui/src/CodingPlanBillingDiscount.tsx` | `aac47556` | +88/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b47 | 91 | `packages/ui/src/settings/model-provider-section/CodingPlanStatusMeta.tsx` | `aac47556` | +91/-0 | 未提交 | — |
| ZC-DEEP-b47 | 92 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-text.ts` | `54f51bad` | +92/-0 | 未提交 | — |
| ZC-DEEP-b48 | 95 | `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts` | `bce5596a` | +246/-0 | 台账与实测不符 | 超出 151 行 |
| ZC-DEEP-b48 | 94 | `apps/zcode-cli/packages/core/src/workflow/lifecycle.ts` | `73782160` | +94/-0 | 未提交 | — |
| ZC-DEEP-b48 | 89 | `apps/zcode-cli/packages/core/src/mcp/image-normalization.ts` | `872ad960` | +89/-0 | 未提交 | — |
| ZC-DEEP-b48 | 90 | `apps/zcode-cli/packages/core/src/runtime/internal-turn-methods.ts` | `ad6dc0eb` | +90/-0 | 未提交 | — |
| ZC-DEEP-b48 | 90 | `packages/ui/src/lib/assistantDirectiveParser.ts` | `aac47556` | +90/-0 | 未提交 | — |
| ZC-DEEP-b48 | 89 | `packages/ui/src/lib/chatErrorAttribution.ts` | `aac47556` | +89/-0 | 未提交 | — |
| ZC-DEEP-b48 | 90 | `packages/ui/src/lib/toolDiffPreview.ts` | `872ad960` | +90/-0 | 未提交 | — |
| ZC-DEEP-b48 | 90 | `packages/ui/src/UpdateStatusDialog.tsx` | `872ad960` | +90/-0 | 未提交 | — |
| ZC-DEEP-b48 | 90 | `packages/ui/src/v4/conversationAssistantWorkItems.ts` | `aac47556` | +90/-0 | 未提交 | — |
| ZC-DEEP-b48 | 89 | `packages/ui/src/quickpick/quickPickCommands.ts` | `872ad960` | +89/-0 | 未提交 | — |
| ZC-DEEP-b48 | 94 | `apps/zcode-cli/packages/cli/src/command-center/create.ts` | `3ead6c6a` | +94/-0 | 未提交 | — |
| ZC-DEEP-b48 | 90 | `apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts` | `aac47556` | +90/-0 | 未提交 | — |
| ZC-DEEP-b49 | 89 | `packages/ui/src/browser-use/EmbeddedBrowserPermissionPrompts.tsx` | `0a1fc56d` | +89/-0 | 未提交 | — |
| ZC-DEEP-b49 | 87 | `packages/ui/src/feedback/FeedbackSupplementComposer.tsx` | `aac47556` | +87/-0 | 未提交 | — |
| ZC-DEEP-b49 | 90 | `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx` | `aac47556` | +83/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b49 | 87 | `packages/ui/src/settings/MigrationCandidatesCard.tsx` | `872ad960` | +80/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b49 | 88 | `packages/ui/src/ToolCallBlocks/renderers/changes-group.tsx` | `0a1fc56d` | +88/-0 | 未提交 | — |
| ZC-DEEP-b49 | 89 | `packages/ui/src/ToolCallBlocks/renderers/mcp.tsx` | `aac47556` | +89/-0 | 未提交 | — |
| ZC-DEEP-b49 | 87 | `packages/ui/src/app-shell/WorkflowWorkspaceCardBody.tsx` | `872ad960` | +87/-0 | 未提交 | — |
| ZC-DEEP-b49 | 87 | `packages/ui/src/AssistantPreviewCards.tsx` | `0a1fc56d` | +80/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b49 | 88 | `packages/ui/src/quickpick/TaskFindDialog.tsx` | `872ad960` | +82/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b49 | 87 | `packages/ui/src/store/offPeakTaskStore.ts` | `aac47556` | +87/-0 | 未提交 | — |
| ZC-DEEP-b49 | 91 | `packages/shared/src/zcode-protocol-v4/controller.ts` | `0a1fc56d` | +91/-0 | 未提交 | — |
| ZC-DEEP-b49 | 90 | `packages/server/src/remote/remoteAssetDeployDecision.ts` | `0a1fc56d` | +90/-0 | 未提交 | — |
| ZC-DEEP-b50 | 86 | `packages/ui/src/settingsCodePreview.tsx` | `872ad960` | +86/-0 | 未提交 | — |
| ZC-DEEP-b50 | 86 | `packages/ui/src/components/ai-elements/environment-variables.tsx` | `aac47556` | +86/-0 | 未提交 | — |
| ZC-DEEP-b50 | 85 | `packages/ui/src/lib/pptxElementReference.ts` | `aac47556` | +85/-0 | 未提交 | — |
| ZC-DEEP-b50 | 86 | `packages/ui/src/remote-connection/EditConnectionProfileDialog.tsx` | `0a1fc56d` | +80/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b50 | 84 | `packages/ui/src/components/ai-elements/commit.tsx` | `872ad960` | +84/-0 | 未提交 | — |
| ZC-DEEP-b50 | 84 | `packages/ui/src/feedback/feedbackTimeline.tsx` | `aac47556` | +84/-0 | 未提交 | — |
| ZC-DEEP-b50 | 84 | `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` | `aac47556` | +84/-0 | 未提交 | — |
| ZC-DEEP-b50 | 86 | `packages/ui/src/settings/saved-workflows/useSavedWorkflowGlobalGroup.ts` | `872ad960` | +86/-0 | 未提交 | — |
| ZC-DEEP-b50 | 86 | `apps/zcode-cli/packages/tui/src/app-view.tsx` | `a7af675d` | +86/-0 | 未提交 | — |
| ZC-DEEP-b50 | 85 | `packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.tsx` | `aac47556` | +85/-0 | 未提交 | — |
| ZC-DEEP-b50 | 87 | `packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx` | `0a1fc56d` | +87/-0 | 未提交 | — |
| ZC-DEEP-b50 | 94 | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` | `26a74c66` | +94/-0 | 未提交 | — |
| ZC-DEEP-b51 | 83 | `packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts` | `872ad960` | +83/-0 | 未提交 | — |
| ZC-DEEP-b51 | 85 | `packages/ui/src/settings/PluginStoreCard.tsx` | `3c5b2276` | +80/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b51 | 83 | `packages/ui/src/v4/ConversationShareContent.tsx` | `0a1fc56d` | +83/-0 | 未提交 | — |
| ZC-DEEP-b51 | 83 | `packages/ui/src/gen-ui/components/GenUiCard.tsx` | `0a1fc56d` | +75/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b51 | 82 | `packages/ui/src/login/LoginApiKeyForm.tsx` | `0a1fc56d` | +76/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b51 | 84 | `packages/ui/src/ToolCallBlocks.tsx` | `0a1fc56d` | +84/-0 | 未提交 | — |
| ZC-DEEP-b51 | 82 | `packages/ui/src/ToolCallBlocks/renderers/cua-group.tsx` | `0a1fc56d` | +82/-0 | 未提交 | — |
| ZC-DEEP-b51 | 83 | `packages/ui/src/ToolCallBlocks/toolResultDisplay.ts` | `aac47556` | +83/-0 | 未提交 | — |
| ZC-DEEP-b51 | 84 | `packages/desktop/scripts/mcp-apps-host-fixture/main.ts` | `aac47556` | +84/-0 | 未提交 | — |
| ZC-DEEP-b51 | 82 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-environment.ts` | `0a1fc56d` | +82/-0 | 未提交 | — |
| ZC-DEEP-b51 | 85 | `packages/desktop/src/main/mcpUserDirectory/index.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b51 | 84 | `packages/desktop/src/main/desktopWindowLifecycle.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 89 | `packages/desktop/src/main/localTtftExporter.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 82 | `packages/desktop/src/main/browserView/browserCommandPageHandlers.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 85 | `packages/desktop/src/main/cuaAccessibilitySettings.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 82 | `packages/desktop/src/main/pluginSandbox/host.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 82 | `packages/desktop/src/main/browserView/browserScreenshotActivityController.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 80 | `packages/desktop/src/main/desktopBrowserViewIpc.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 81 | `packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b52 | 81 | `packages/ui/src/components/ai-elements/file-tree.tsx` | `aac47556` | +81/-0 | 未提交 | — |
| ZC-DEEP-b52 | 81 | `packages/ui/src/ToolCallBlocks/renderers/read-session-context.tsx` | `872ad960` | +78/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b52 | 81 | `packages/shared/src/git.ts` | `872ad960` | +81/-0 | 未提交 | — |
| ZC-DEEP-b52 | 81 | `packages/rpc/src/channelServer.ts` | `0a1fc56d` | +81/-0 | 未提交 | — |
| ZC-DEEP-b52 | 82 | `packages/server/src/remote/docker-backend.ts` | `0a1fc56d` | +82/-0 | 未提交 | — |
| ZC-DEEP-b53 | 81 | `packages/ui/src/project-sidebar/ProjectCreation.tsx` | `0a1fc56d` | +81/-0 | 未提交 | — |
| ZC-DEEP-b53 | 79 | `packages/ui/src/app-shell/SidePaneTabOverview.tsx` | `872ad960` | +79/-0 | 未提交 | — |
| ZC-DEEP-b53 | 80 | `packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts` | `872ad960` | +80/-0 | 未提交 | — |
| ZC-DEEP-b53 | 79 | `packages/ui/src/feedback/FeedbackBackgroundUploadIndicator.tsx` | `aac47556` | +79/-0 | 未提交 | — |
| ZC-DEEP-b53 | 81 | `packages/ui/src/lib/uiPerfArmsTelemetry.ts` | `aac47556` | +81/-0 | 未提交 | — |
| ZC-DEEP-b53 | 79 | `packages/ui/src/lib/usageEntitlementRefreshPolicy.ts` | `aac47556` | +79/-0 | 未提交 | — |
| ZC-DEEP-b53 | 79 | `packages/ui/src/rewards/RewardsWebview.tsx` | `aac47556` | +74/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b53 | 80 | `packages/shared/src/workspace-hook-digest.ts` | `872ad960` | +80/-0 | 未提交 | — |
| ZC-DEEP-b53 | 80 | `packages/client/src/remoteServiceAccess.ts` | `0a1fc56d` | +80/-0 | 未提交 | — |
| ZC-DEEP-b53 | 79 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-lifecycle-checks.ts` | `0a1fc56d` | +79/-0 | 未提交 | — |
| ZC-DEEP-b53 | 79 | `packages/desktop/src/main/rendererActionTraceBroker.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b53 | 93 | `apps/zcode-cli/packages/i18n/src/types.ts` | `872ad960` | +93/-0 | 未提交 | — |
| ZC-DEEP-b54 | 91 | `packages/stream-animate/src/server/deepseekRunner.ts` | `aac47556` | +91/-0 | 未提交 | — |
| ZC-DEEP-b54 | 78 | `packages/stream-animate/src/server/http.ts` | `aac47556` | +78/-0 | 未提交 | — |
| ZC-DEEP-b54 | 104 | `apps/zcode-cli/packages/bootstrap/src/plugins.ts` | `0f2ef80d` | +104/-0 | 未提交 | — |
| ZC-DEEP-b54 | 82 | `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts` | `0f2ef80d` | +82/-0 | 未提交 | — |
| ZC-DEEP-b54 | 87 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.ts` | `deb218da` | +87/-0 | 未提交 | — |
| ZC-DEEP-b54 | 113 | `apps/zcode-cli/packages/adapters/src/mcp/index.ts` | `522e851e` | +113/-0 | 未提交 | — |
| ZC-DEEP-b54 | 87 | `packages/zcode-server-cli/src/server-core/http.ts` | `0a1fc56d` | +87/-0 | 未提交 | — |
| ZC-DEEP-b54 | 79 | `apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts` | `54f51bad` | +79/-0 | 未提交 | — |
| ZC-DEEP-b54 | 79 | `packages/shared/src/workspace-hook-config.ts` | `872ad960` | +79/-0 | 未提交 | — |
| ZC-DEEP-b54 | 80 | `packages/ui/src/ErrorBoundary.tsx` | `872ad960` | +80/-0 | 未提交 | — |
| ZC-DEEP-b54 | 78 | `packages/ui/src/v4/ConversationTurnNavigator.tsx` | `0a1fc56d` | +75/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b54 | 81 | `packages/ui/src/ToolCallBlocks/renderers/create-workflow.tsx` | `aac47556` | +77/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b55 | 89 | `packages/e2e-report/src/viewer/App.tsx` | `aac47556` | +80/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b55 | 89 | `apps/zcode-cli/packages/node-repl-host/src/server.ts` | `aac47556` | +89/-0 | 未提交 | — |
| ZC-DEEP-b55 | 79 | `packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx` | `872ad960` | +75/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b55 | 80 | `apps/zcode-cli/packages/office-runtime/ui/viewers/PptxView.tsx` | `a7af675d` | +80/-0 | 未提交 | — |
| ZC-DEEP-b55 | 78 | `packages/desktop/src/main/chromeExecutableDiscovery.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b55 | 79 | `packages/ui/src/components/ai-elements/inline-citation.tsx` | `aac47556` | +79/-0 | 未提交 | — |
| ZC-DEEP-b55 | 79 | `packages/ui/src/settings/pluginManagedResourceGroups.ts` | `aac47556` | +79/-0 | 未提交 | — |
| ZC-DEEP-b55 | 80 | `packages/ui/src/store/codingPlanQuotaResetState.ts` | `aac47556` | +80/-0 | 未提交 | — |
| ZC-DEEP-b55 | 87 | `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` | `522e851e` | +87/-0 | 未提交 | — |
| ZC-DEEP-b55 | 77 | `packages/desktop/src/main/chromeProfileDiscovery.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b55 | 77 | `packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b55 | 78 | `packages/shared/src/zcode-protocol-v4/telemetry.ts` | `0a1fc56d` | +78/-0 | 未提交 | — |
| ZC-DEEP-b56 | 78 | `packages/ui/src/components/ai-elements/mermaid-block.tsx` | `872ad960` | +78/-0 | 未提交 | — |
| ZC-DEEP-b56 | 78 | `packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts` | `0a1fc56d` | +78/-0 | 未提交 | — |
| ZC-DEEP-b56 | 78 | `packages/ui/src/ToolCallBlocks/ToolLayout.tsx` | `872ad960` | +75/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b56 | 80 | `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts` | `0a1fc56d` | +80/-0 | 未提交 | — |
| ZC-DEEP-b56 | 77 | `apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts` | `55fedda3` | +77/-0 | 未提交 | — |
| ZC-DEEP-b56 | 76 | `packages/desktop/src/main/browserView/browserTabRecoveryStore.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b56 | 76 | `packages/desktop/src/main/mcpUserDirectory/claude.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b56 | 76 | `packages/desktop/src/main/windowsInstallResourceLocks.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b56 | 77 | `packages/ui/src/app-shell/types.ts` | `3c5b2276` | +77/-0 | 未提交 | — |
| ZC-DEEP-b56 | 76 | `packages/ui/src/git-graph/layout.ts` | `aac47556` | +76/-0 | 未提交 | — |
| ZC-DEEP-b56 | 76 | `packages/ui/src/lib/codeCommentContext.ts` | `872ad960` | +76/-0 | 未提交 | — |
| ZC-DEEP-b56 | 78 | `packages/ui/src/settings/automationFormat.ts` | `aac47556` | +78/-0 | 未提交 | — |
| ZC-DEEP-b57 | 76 | `packages/e2e-report/src/viewer/ChartPanels.tsx` | `aac47556` | +74/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b57 | 76 | `packages/ui/src/feedback/TicketsView.tsx` | `aac47556` | +64/-0 | 部分未提交 | 差 12 行 |
| ZC-DEEP-b57 | 76 | `packages/ui/src/lib/conversationSelectionReference.ts` | `0a1fc56d` | +76/-0 | 未提交 | — |
| ZC-DEEP-b57 | 76 | `packages/ui/src/ModelTrajectoryPaneDetails.tsx` | `aac47556` | +76/-0 | 未提交 | — |
| ZC-DEEP-b57 | 76 | `packages/ui/src/settings/model-provider-section/ProviderFamilyModeHeader.tsx` | `0a1fc56d` | +69/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b57 | 77 | `packages/ui/src/settings/saved-workflows/SavedWorkflowsSection.tsx` | `3c5b2276` | +71/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b57 | 88 | `packages/ui/src/v4/conversationProjectionStore.ts` | `7aeaf5ba` | +88/-0 | 未提交 | — |
| ZC-DEEP-b57 | 77 | `packages/ui/src/WindowsCaptionMenuButton.tsx` | `aac47556` | +64/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b57 | 75 | `apps/zcode-cli/packages/bootstrap/src/app/workflow-methods.ts` | `0f2ef80d` | +75/-0 | 未提交 | — |
| ZC-DEEP-b57 | 76 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-process.ts` | `54f51bad` | +76/-0 | 未提交 | — |
| ZC-DEEP-b57 | 78 | `packages/desktop/src/main/desktopRuntimeEnv.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b57 | 76 | `packages/ui/src/app-shell/WorkflowWorkspaceSidePane.tsx` | `aac47556` | +76/-0 | 未提交 | — |
| ZC-DEEP-b58 | 75 | `packages/ui/src/git-graph/layoutAlgorithm.ts` | `aac47556` | +75/-0 | 未提交 | — |
| ZC-DEEP-b58 | 76 | `packages/ui/src/root/useRemoteWorkspaceTabLifecycle.ts` | `0a1fc56d` | +76/-0 | 未提交 | — |
| ZC-DEEP-b58 | 75 | `packages/ui/src/settings/CommandForm.tsx` | `0a1fc56d` | +64/-0 | 部分未提交 | 差 11 行 |
| ZC-DEEP-b58 | 76 | `packages/zcode-server-cli/src/platform/serviceManager.ts` | `3c5b2276` | +76/-0 | 未提交 | — |
| ZC-DEEP-b58 | 79 | `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts` | `0f2ef80d` | +79/-0 | 未提交 | — |
| ZC-DEEP-b58 | 74 | `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts` | `aac47556` | +74/-0 | 未提交 | — |
| ZC-DEEP-b58 | 74 | `packages/desktop/scripts/gen-ui-fixture/react.tsx` | `0a1fc56d` | +71/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b58 | 76 | `packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx` | `aac47556` | +76/-0 | 未提交 | — |
| ZC-DEEP-b58 | 74 | `packages/ui/src/BotsDialog/BotSummaryCard.tsx` | `29628c9a` | +69/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b58 | 74 | `packages/ui/src/components/cloud-content-dialog/CloudDialogHero.tsx` | `aac47556` | +74/-0 | 未提交 | — |
| ZC-DEEP-b58 | 75 | `packages/ui/src/i18n/IntlProvider.tsx` | `aac47556` | +75/-0 | 未提交 | — |
| ZC-DEEP-b58 | 73 | `packages/shared/src/conversation-share-content.ts` | `0a1fc56d` | +73/-0 | 未提交 | — |
| ZC-DEEP-b59 | 74 | `packages/ui/src/ToolCallBlocks/renderers/read.tsx` | `872ad960` | +71/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b59 | 73 | `packages/ui/src/ToolCallBlocks/renderers/eval-workflow-snippet.tsx` | `872ad960` | +64/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b59 | 71 | `packages/ui/src/v4/agentSessionsIndexTransport.ts` | `aac47556` | +71/-0 | 未提交 | — |
| ZC-DEEP-b59 | 71 | `packages/ui/src/v4/conversationCuaGroups.ts` | `aac47556` | +71/-0 | 未提交 | — |
| ZC-DEEP-b59 | 72 | `packages/ui/src/v4/conversationTurnRenderUnits.ts` | `aac47556` | +72/-0 | 未提交 | — |
| ZC-DEEP-b59 | 74 | `packages/ui/src/store/index.ts` | `3c5b2276` | +74/-0 | 未提交 | — |
| ZC-DEEP-b59 | 72 | `packages/ui/src/store/hooksStore.ts` | `0a1fc56d` | +72/-0 | 未提交 | — |
| ZC-DEEP-b59 | 73 | `packages/desktop/scripts/mcp-apps-host-fixture/rows-main.ts` | `aac47556` | +73/-0 | 未提交 | — |
| ZC-DEEP-b59 | 69 | `packages/desktop/scripts/mcp-apps-host-fixture/chain-combinations.ts` | `aac47556` | +69/-0 | 未提交 | — |
| ZC-DEEP-b59 | 70 | `packages/desktop/src/main/about.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b59 | 72 | `packages/shared/src/conversation-message-projection-policy.ts` | `aac47556` | +72/-0 | 未提交 | — |
| ZC-DEEP-b59 | 71 | `packages/ui/src/hooks/useClaudeSessionMigration.ts` | `aac47556` | +71/-0 | 未提交 | — |
| ZC-DEEP-b60 | 74 | `packages/ui/src/settings/model-provider-section/useCodingPlanEntitlements.ts` | `aac47556` | +74/-0 | 未提交 | — |
| ZC-DEEP-b60 | 72 | `packages/ui/src/workspace-plugin-preview/WorkspacePluginPreview.tsx` | `0a1fc56d` | +66/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b60 | 74 | `packages/desktop/src/main/resourceManagerWindow.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b60 | 73 | `packages/desktop/src/renderer/src/main.tsx` | `0a1fc56d` | +73/-0 | 未提交 | — |
| ZC-DEEP-b60 | 72 | `packages/ui/src/plugin-ui/adapters/pluginUiPagePlane.ts` | `0a1fc56d` | +72/-0 | 未提交 | — |
| ZC-DEEP-b60 | 72 | `packages/desktop/src/host/windowHostSessionsIndexObserver.ts` | `e6ff6fab` | +72/-0 | 未提交 | — |
| ZC-DEEP-b60 | 71 | `packages/desktop/src/renderer/src/plugin-sandbox/aliasRuntime.ts` | `aac47556` | +71/-0 | 未提交 | — |
| ZC-DEEP-b60 | 70 | `packages/ui/src/components/ui/dropdown-menu.tsx` | `0a1fc56d` | +70/-0 | 未提交 | — |
| ZC-DEEP-b60 | 70 | `packages/ui/src/lib/assistantFileReferences.ts` | `aac47556` | +70/-0 | 未提交 | — |
| ZC-DEEP-b60 | 70 | `packages/ui/src/lib/fileDisplay.tsx` | `aac47556` | +70/-0 | 未提交 | — |
| ZC-DEEP-b60 | 70 | `packages/ui/src/plugin-ui/components/PluginUiLauncherItems.tsx` | `3c5b2276` | +59/-0 | 部分未提交 | 差 11 行 |
| ZC-DEEP-b60 | 71 | `packages/ui/src/v4/ConversationDraftEmptyState.tsx` | `aac47556` | +71/-0 | 未提交 | — |
| ZC-DEEP-b61 | 71 | `apps/zcode-cli/packages/core/src/hooks/runner.ts` | `c788b9f1` | +71/-0 | 未提交 | — |
| ZC-DEEP-b61 | 70 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-callbacks.ts` | `54f51bad` | +70/-0 | 未提交 | — |
| ZC-DEEP-b61 | 71 | `apps/zcode-cli/packages/core/src/session-context/read-session-context.ts` | `c788b9f1` | +71/-0 | 未提交 | — |
| ZC-DEEP-b61 | 71 | `apps/zcode-cli/packages/dynamic-workflow/src/index.ts` | `aac47556` | +71/-0 | 未提交 | — |
| ZC-DEEP-b61 | 71 | `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-tool-port.ts` | `0f2ef80d` | +71/-0 | 未提交 | — |
| ZC-DEEP-b61 | 70 | `packages/shared/src/gen-ui/contract.ts` | `0a1fc56d` | +70/-0 | 未提交 | — |
| ZC-DEEP-b61 | 69 | `packages/shared/src/subagent-profile-frontmatter.ts` | `aac47556` | +69/-0 | 未提交 | — |
| ZC-DEEP-b61 | 71 | `packages/ui/src/store/pluginManagementStoreLoading.ts` | `0a1fc56d` | +71/-0 | 未提交 | — |
| ZC-DEEP-b61 | 69 | `packages/ui/src/lib/sidebarPurposeSectionPreferences.ts` | `0a1fc56d` | +69/-0 | 未提交 | — |
| ZC-DEEP-b61 | 70 | `packages/ui/src/components/ai-elements/speech-input.tsx` | `aac47556` | +68/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b61 | 68 | `packages/desktop/src/main/desktopDeepLinkUrl.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b61 | 69 | `packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b62 | 68 | `packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx` | `0a1fc56d` | +62/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b62 | 68 | `packages/ui/src/project-sidebar/grouped/useGroupedDrag.ts` | `3c5b2276` | +68/-0 | 未提交 | — |
| ZC-DEEP-b62 | 69 | `packages/ui/src/project-sidebar/useProjectUnreadSignals.ts` | `0a1fc56d` | +69/-0 | 未提交 | — |
| ZC-DEEP-b62 | 69 | `packages/ui/src/root/useBotBroadcastEffects.ts` | `29628c9a` | +69/-0 | 未提交 | — |
| ZC-DEEP-b62 | 68 | `packages/ui/src/store/commandsStore.ts` | `872ad960` | +68/-0 | 未提交 | — |
| ZC-DEEP-b62 | 68 | `packages/ui/src/lib/codingPlanFunnelTelemetry.ts` | `aac47556` | +68/-0 | 未提交 | — |
| ZC-DEEP-b62 | 68 | `packages/ui/src/components/ai-elements/jsx-preview.tsx` | `aac47556` | +63/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b62 | 68 | `packages/ui/src/settings/MigrationSection.tsx` | `872ad960` | +54/-0 | 部分未提交 | 差 14 行 |
| ZC-DEEP-b62 | 69 | `packages/desktop/src/main/browserView/browserCommandInput.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b62 | 67 | `packages/desktop/src/main/browserDataManager.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b62 | 71 | `packages/desktop/src/main/desktopResourceTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b62 | 68 | `packages/rpc/src/channelClient.ts` | `0a1fc56d` | +68/-0 | 未提交 | — |
| ZC-DEEP-b63 | 69 | `apps/dev-docs/src/capability-map/CapabilityMapView.tsx` | `10e9df51` | +69/-0 | 未提交 | — |
| ZC-DEEP-b63 | 71 | `apps/zcode-cli/packages/adapters/src/browser/index.ts` | `522e851e` | +71/-0 | 未提交 | — |
| ZC-DEEP-b63 | 70 | `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` | `a7af675d` | +70/-0 | 未提交 | — |
| ZC-DEEP-b63 | 67 | `packages/desktop/scripts/mcp-apps-host-fixture/renderer.ts` | `aac47556` | +67/-0 | 未提交 | — |
| ZC-DEEP-b63 | 67 | `packages/model-option-map/src/parser.ts` | `872ad960` | +67/-0 | 未提交 | — |
| ZC-DEEP-b63 | 69 | `apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts` | `522e851e` | +69/-0 | 未提交 | — |
| ZC-DEEP-b63 | 68 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts` | `0f2ef80d` | +68/-0 | 未提交 | — |
| ZC-DEEP-b63 | 67 | `packages/desktop/src/main/browserView/browserCommandInteractionHandlers.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b63 | 66 | `packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b63 | 67 | `packages/ui/src/components/ai-elements/web-preview.tsx` | `aac47556` | +62/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b63 | 67 | `packages/ui/src/lib/zcodeSessionRestore.ts` | `aac47556` | +67/-0 | 未提交 | — |
| ZC-DEEP-b63 | 67 | `packages/ui/src/store/skillStore.ts` | `0a1fc56d` | +67/-0 | 未提交 | — |
| ZC-DEEP-b64 | 67 | `apps/zcode-cli/packages/cli/src/command-center/types.ts` | `aac47556` | +67/-0 | 未提交 | — |
| ZC-DEEP-b64 | 69 | `packages/desktop/src/scheduler/index.ts` | `0a1fc56d` | +69/-0 | 未提交 | — |
| ZC-DEEP-b64 | 66 | `packages/ui/src/browser-use/BrowserViewportToolbar.tsx` | `0a1fc56d` | +60/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b64 | 66 | `packages/ui/src/project-sidebar/RemoteProjectList.tsx` | `0a1fc56d` | +66/-0 | 未提交 | — |
| ZC-DEEP-b64 | 67 | `packages/ui/src/ToolCallBlocks/renderers/cuaListDetails.tsx` | `0a1fc56d` | +67/-0 | 未提交 | — |
| ZC-DEEP-b64 | 67 | `packages/ui/src/v4/composer/V4ComposerModeControls.tsx` | `0a1fc56d` | +58/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b64 | 67 | `packages/zcode-server-cli/src/contracts.ts` | `0a1fc56d` | +67/-0 | 未提交 | — |
| ZC-DEEP-b64 | 67 | `packages/zcode-server-cli/src/runtime/updatePreparation.ts` | `aac47556` | +67/-0 | 未提交 | — |
| ZC-DEEP-b64 | 74 | `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` | `bce5596a` | +74/-0 | 未提交 | — |
| ZC-DEEP-b64 | 65 | `packages/desktop/src/main/desktopSaveFile.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b64 | 66 | `packages/ui/src/components/cloud-content-dialog/CloudContentDialog.tsx` | `aac47556` | +61/-0 | 部分未提交 | 差 5 行 |
| ZC-DEEP-b64 | 66 | `packages/ui/src/settings/McpServerList.tsx` | `0a1fc56d` | +66/-0 | 未提交 | — |
| ZC-DEEP-b65 | 67 | `packages/ui/src/v4/windowControllerTaskListRegistry.ts` | `0a1fc56d` | +67/-0 | 未提交 | — |
| ZC-DEEP-b65 | 65 | `packages/desktop/src/main/forceUpdateGuard.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b65 | 66 | `packages/ui/src/components/ai-elements/package-info.tsx` | `aac47556` | +66/-0 | 未提交 | — |
| ZC-DEEP-b65 | 66 | `packages/ui/src/feedback/FeedbackScreenshotPicker.tsx` | `872ad960` | +50/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b65 | 66 | `packages/ui/src/resource-manager/ResourceManagerApp.tsx` | `0a1fc56d` | +66/-0 | 未提交 | — |
| ZC-DEEP-b65 | 65 | `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx` | `aac47556` | +57/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b65 | 66 | `packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts` | `aac47556` | +66/-0 | 未提交 | — |
| ZC-DEEP-b65 | 68 | `packages/zcode-server-cli/src/packaging/stage.ts` | `3c5b2276` | +68/-0 | 未提交 | — |
| ZC-DEEP-b65 | 66 | `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts` | `522e851e` | +66/-0 | 未提交 | — |
| ZC-DEEP-b65 | 65 | `apps/zcode-cli/packages/cli/src/arguments.ts` | `e0060254` | +65/-0 | 未提交 | — |
| ZC-DEEP-b65 | 67 | `apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts` | `783d49a6` | +67/-0 | 未提交 | — |
| ZC-DEEP-b65 | 65 | `packages/server/src/remote/remoteAssetLiveIdentity.ts` | `872ad960` | +65/-0 | 未提交 | — |
| ZC-DEEP-b66 | 66 | `packages/ui/src/components/ui/carousel.tsx` | `aac47556` | +66/-0 | 未提交 | — |
| ZC-DEEP-b66 | 67 | `packages/ui/src/ToolCallBlocks/renderers/list-models.tsx` | `0a1fc56d` | +67/-0 | 未提交 | — |
| ZC-DEEP-b66 | 67 | `packages/ui/src/WebRemoteControlMobileShell.tsx` | `0a1fc56d` | +61/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b66 | 66 | `packages/ui/src/WorkspaceHeader.tsx` | `3c5b2276` | +49/-0 | 部分未提交 | 差 17 行 |
| ZC-DEEP-b66 | 65 | `apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-reads.ts` | `aac47556` | +65/-0 | 未提交 | — |
| ZC-DEEP-b66 | 67 | `apps/zcode-cli/packages/tui/src/app-events.ts` | `a7af675d` | +67/-0 | 未提交 | — |
| ZC-DEEP-b66 | 66 | `packages/shared/src/usage-stats.ts` | `aac47556` | +66/-0 | 未提交 | — |
| ZC-DEEP-b66 | 65 | `packages/ui/src/app-shell/SubagentDirectorySidePane.tsx` | `aac47556` | +53/-0 | 部分未提交 | 差 12 行 |
| ZC-DEEP-b66 | 65 | `packages/ui/src/hooks/useZCodeTaskService.ts` | `aac47556` | +65/-0 | 未提交 | — |
| ZC-DEEP-b66 | 65 | `packages/ui/src/root/remoteWorkspaceSessionPersistence.ts` | `0a1fc56d` | +65/-0 | 未提交 | — |
| ZC-DEEP-b66 | 64 | `packages/ui/src/store/whiteboardStore.ts` | `872ad960` | +64/-0 | 未提交 | — |
| ZC-DEEP-b66 | 64 | `packages/ui/src/components/ui/smooth-metric-value.tsx` | `aac47556` | +64/-0 | 未提交 | — |
| ZC-DEEP-b67 | 66 | `packages/ui/src/app-shell/WorkflowRunPhaseList.tsx` | `aac47556` | +66/-0 | 未提交 | — |
| ZC-DEEP-b67 | 64 | `packages/ui/src/components/ai-elements/audio-player.tsx` | `aac47556` | +64/-0 | 未提交 | — |
| ZC-DEEP-b67 | 66 | `packages/ui/src/lib/markdownFileLink.ts` | `872ad960` | +66/-0 | 未提交 | — |
| ZC-DEEP-b67 | 65 | `packages/ui/src/MessageChangeSummaryPanel.tsx` | `0a1fc56d` | +46/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b67 | 66 | `packages/ui/src/settings/saved-workflows/SavedWorkflowCard.tsx` | `0a1fc56d` | +60/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b67 | 66 | `packages/ui/src/ToolCallBlocks/renderers/get-workflow-run.tsx` | `872ad960` | +62/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b67 | 65 | `packages/ui/src/v4/useV4SessionQuotaBanner.ts` | `872ad960` | +65/-0 | 未提交 | — |
| ZC-DEEP-b67 | 67 | `apps/zcode-cli/packages/adapters/src/config/index.ts` | `522e851e` | +67/-0 | 未提交 | — |
| ZC-DEEP-b67 | 65 | `apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts` | `26a74c66` | +65/-0 | 未提交 | — |
| ZC-DEEP-b67 | 65 | `apps/zcode-cli/packages/core/src/workflow/scheduler/collection-planner.ts` | `73782160` | +65/-0 | 未提交 | — |
| ZC-DEEP-b67 | 66 | `packages/desktop/src/host/remoteMediaPreviewProxy.ts` | `e6ff6fab` | +66/-0 | 未提交 | — |
| ZC-DEEP-b67 | 66 | `packages/desktop/src/host/serverRemoteConnection.ts` | `e6ff6fab` | +66/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx` | `872ad960` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx` | `0a1fc56d` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `apps/zcode-cli/packages/debug/src/shared.ts` | `3ead6c6a` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts` | `0a1fc56d` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/ui/src/components/ui/select.tsx` | `aac47556` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/ui/src/feedback/TicketDetail.tsx` | `aac47556` | +58/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b68 | 64 | `packages/ui/src/lib/promptInputTriggers.ts` | `aac47556` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/ui/src/lib/toolDisplay.ts` | `0a1fc56d` | +64/-0 | 未提交 | — |
| ZC-DEEP-b68 | 63 | `packages/ui/src/lib/whiteboard.ts` | `aac47556` | +63/-0 | 未提交 | — |
| ZC-DEEP-b68 | 64 | `packages/ui/src/resource-manager/storage/StorageSection.tsx` | `0a1fc56d` | +54/-0 | 部分未提交 | 差 10 行 |
| ZC-DEEP-b68 | 63 | `packages/ui/src/v4/ConversationFileRewindDialog.tsx` | `0a1fc56d` | +50/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b68 | 67 | `apps/zcode-cli/packages/adapters/src/model/transform.ts` | `522e851e` | +67/-0 | 未提交 | — |
| ZC-DEEP-b69 | 63 | `packages/ui/src/components/cloud-content-dialog/CloudDialogMediaHero.tsx` | `aac47556` | +63/-0 | 未提交 | — |
| ZC-DEEP-b69 | 64 | `packages/ui/src/lib/zcodeUiError.ts` | `aac47556` | +64/-0 | 未提交 | — |
| ZC-DEEP-b69 | 63 | `packages/ui/src/ToolCallBlocks/renderers/send-message.tsx` | `872ad960` | +63/-0 | 未提交 | — |
| ZC-DEEP-b69 | 64 | `packages/ui/src/ToolCallBlocks/renderers/skill.tsx` | `872ad960` | +61/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b69 | 63 | `packages/ui/src/v4/conversationFindIndex.ts` | `aac47556` | +63/-0 | 未提交 | — |
| ZC-DEEP-b69 | 64 | `packages/ui/src/v4/highspeed/HighSpeedDiffusionCanvas.tsx` | `aac47556` | +64/-0 | 未提交 | — |
| ZC-DEEP-b69 | 64 | `packages/web/src/share/conversationSharePreviewClient.ts` | `0a1fc56d` | +64/-0 | 未提交 | — |
| ZC-DEEP-b69 | 64 | `apps/zcode-cli/packages/adapters/src/browser/page-command.ts` | `522e851e` | +64/-0 | 未提交 | — |
| ZC-DEEP-b69 | 63 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-sources.ts` | `54f51bad` | +63/-0 | 未提交 | — |
| ZC-DEEP-b69 | 63 | `packages/desktop/src/main/aboutWindow.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b69 | 62 | `packages/shared/src/subagent-profile-parser.ts` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b69 | 65 | `packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx` | `0a1fc56d` | +54/-0 | 部分未提交 | 差 11 行 |
| ZC-DEEP-b70 | 62 | `packages/desktop/scripts/mcp-apps-host-fixture/widget.tsx` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b70 | 63 | `packages/model-option-map/src/evaluator.ts` | `872ad960` | +63/-0 | 未提交 | — |
| ZC-DEEP-b70 | 62 | `packages/shared/src/zcode-slash-command-help.ts` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b70 | 62 | `packages/ui/src/components/ai-elements/chain-of-thought.tsx` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b70 | 62 | `packages/ui/src/settings/MemorySettingsViewer.tsx` | `0a1fc56d` | +54/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b70 | 63 | `packages/ui/src/store/subagentsContextStore.ts` | `0a1fc56d` | +63/-0 | 未提交 | — |
| ZC-DEEP-b70 | 62 | `packages/ui/src/project-sidebar/grouped/sticky-group-header.tsx` | `0a1fc56d` | +52/-0 | 部分未提交 | 差 10 行 |
| ZC-DEEP-b70 | 63 | `packages/ui/src/feedback/FeedbackSubmitSections.tsx` | `0a1fc56d` | +50/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b70 | 63 | `packages/ui/src/lib/planUsageArmsTelemetry.ts` | `aac47556` | +63/-0 | 未提交 | — |
| ZC-DEEP-b70 | 63 | `packages/ui/src/hooks/useModelSelectionView.ts` | `0a1fc56d` | +63/-0 | 未提交 | — |
| ZC-DEEP-b70 | 63 | `packages/ui/src/v4/paneLayoutPersistence.ts` | `aac47556` | +63/-0 | 未提交 | — |
| ZC-DEEP-b70 | 65 | `apps/zcode-cli/packages/cli/src/plugins-command.ts` | `3ead6c6a` | +65/-0 | 未提交 | — |
| ZC-DEEP-b71 | 61 | `packages/ui/src/git-graph/GitGraphDialog.tsx` | `872ad960` | +61/-0 | 未提交 | — |
| ZC-DEEP-b71 | 61 | `packages/ui/src/presentation/pptxRendererPreviewEngine.ts` | `872ad960` | +61/-0 | 未提交 | — |
| ZC-DEEP-b71 | 62 | `packages/ui/src/presentation/presentationElementModel.ts` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b71 | 61 | `apps/zcode-cli/packages/core/src/browser-client/documentation.ts` | `872ad960` | +61/-0 | 未提交 | — |
| ZC-DEEP-b71 | 62 | `packages/desktop/src/main/browserView/browserTabResidencyCoordinator.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b71 | 62 | `packages/server/src/remote/zcodeAgentDeploy.ts` | `872ad960` | +62/-0 | 未提交 | — |
| ZC-DEEP-b71 | 63 | `packages/ui/src/UpdateStatusDialogController.tsx` | `872ad960` | +63/-0 | 未提交 | — |
| ZC-DEEP-b71 | 63 | `packages/ui/src/v4/sessionQuotaBannerState.ts` | `aac47556` | +63/-0 | 未提交 | — |
| ZC-DEEP-b71 | 65 | `packages/ui/src/v4/V4ConversationContext.tsx` | `0a1fc56d` | +65/-0 | 未提交 | — |
| ZC-DEEP-b71 | 64 | `apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts` | `522e851e` | +64/-0 | 未提交 | — |
| ZC-DEEP-b71 | 64 | `apps/zcode-cli/packages/core/src/runtime/methods/target.ts` | `aac47556` | +119/-2 | 台账与实测不符 | 超出 55 行 |
| ZC-DEEP-b71 | 63 | `packages/ui/src/project-workflow/WorkflowRunSaveControls.tsx` | `0a1fc56d` | +63/-0 | 未提交 | — |
| ZC-DEEP-b72 | 62 | `packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b72 | 62 | `packages/ui/src/settings/saved-workflows/SavedWorkflowGlobalGroup.tsx` | `0a1fc56d` | +56/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b72 | 61 | `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx` | `0a1fc56d` | +40/-0 | 部分未提交 | 差 21 行 |
| ZC-DEEP-b72 | 62 | `packages/ui/src/useTaskListItemContextActions.ts` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b72 | 61 | `apps/dev-docs/src/capability-map/CapabilityMapDetail.tsx` | `10e9df51` | +61/-0 | 未提交 | — |
| ZC-DEEP-b72 | 63 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` | `0f2ef80d` | +63/-0 | 未提交 | — |
| ZC-DEEP-b72 | 63 | `apps/zcode-cli/packages/core/src/tool/edit-matchers.ts` | `c3590b12` | +63/-0 | 未提交 | — |
| ZC-DEEP-b72 | 60 | `packages/client/src/webRemoteControlRelayProtocol.ts` | `aac47556` | +60/-0 | 未提交 | — |
| ZC-DEEP-b72 | 61 | `packages/desktop/src/main/applicationIcons.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b72 | 62 | `packages/server/src/remote/connect.ts` | `aac47556` | +62/-0 | 未提交 | — |
| ZC-DEEP-b72 | 61 | `packages/shared/src/tool-call-summary.ts` | `872ad960` | +61/-0 | 未提交 | — |
| ZC-DEEP-b72 | 61 | `packages/ui/src/onboarding/useOnboardingMigration.ts` | `872ad960` | +61/-0 | 未提交 | — |
| ZC-DEEP-b73 | 61 | `packages/desktop/scripts/mcp-apps-host-fixture/retention-renderer.ts` | `aac47556` | +61/-0 | 未提交 | — |
| ZC-DEEP-b73 | 60 | `packages/desktop/src/main/manifestUpdateProvider.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b73 | 61 | `packages/desktop/src/main/pluginSandbox/protocol.ts` | `abe7f439` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b73 | 60 | `packages/stream-animate/src/client/FrameChart.tsx` | `aac47556` | +54/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b73 | 61 | `packages/ui/src/project-sidebar/grouped/virtualized-group-task-list.tsx` | `0a1fc56d` | +61/-0 | 未提交 | — |
| ZC-DEEP-b73 | 61 | `packages/ui/src/settings/automationTemplateCatalog.ts` | `aac47556` | +61/-0 | 未提交 | — |
| ZC-DEEP-b73 | 61 | `packages/ui/src/settings/MemorySettingsSection.tsx` | `0a1fc56d` | +57/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b73 | 61 | `packages/ui/src/TaskActionMenuContent.tsx` | `3c5b2276` | +54/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b73 | 60 | `packages/web/src/auth/zaiWebOAuthProvider.ts` | `872ad960` | +60/-0 | 未提交 | — |
| ZC-DEEP-b73 | 60 | `packages/zcode-server-cli/src/runtime/lock.ts` | `872ad960` | +60/-0 | 未提交 | — |
| ZC-DEEP-b73 | 61 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts` | `54f51bad` | +61/-0 | 未提交 | — |
| ZC-DEEP-b73 | 62 | `apps/zcode-cli/packages/tui/src/app-keyboard.ts` | `a7af675d` | +62/-0 | 未提交 | — |
| ZC-DEEP-b74 | 60 | `packages/ui/src/settings/model-provider-section/StartPlanCard.tsx` | `aac47556` | +56/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b74 | 61 | `packages/ui/src/settings/PluginConfigControls.tsx` | `0a1fc56d` | +53/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b74 | 62 | `packages/ui/src/settings/pluginStoreListing.ts` | `3c5b2276` | +62/-0 | 未提交 | — |
| ZC-DEEP-b74 | 60 | `packages/ui/src/settings/model-provider-section/codingPlanProductPresentation.ts` | `aac47556` | +60/-0 | 未提交 | — |
| ZC-DEEP-b74 | 64 | `packages/ui/src/store/zcodeSessionStoreTypes.ts` | `0a1fc56d` | +64/-0 | 未提交 | — |
| ZC-DEEP-b74 | 59 | `packages/ui/src/store/conversationShareSelectionStore.ts` | `0a1fc56d` | +59/-0 | 未提交 | — |
| ZC-DEEP-b74 | 62 | `packages/ui/src/ToolCallBlocks/renderers/list-saved-workflows-presentation.tsx` | `0a1fc56d` | +62/-0 | 未提交 | — |
| ZC-DEEP-b74 | 61 | `packages/ui/src/v4/conversationFindHighlightDom.ts` | `aac47556` | +61/-0 | 未提交 | — |
| ZC-DEEP-b74 | 61 | `packages/zcode-server-cli/src/packaging/stageCli.ts` | `3c5b2276` | +61/-0 | 未提交 | — |
| ZC-DEEP-b74 | 61 | `apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts` | `0f2ef80d` | +61/-0 | 未提交 | — |
| ZC-DEEP-b74 | 59 | `packages/desktop/scripts/mcp-apps-host-fixture/agent.ts` | `0a1fc56d` | +59/-0 | 未提交 | — |
| ZC-DEEP-b74 | 59 | `packages/shared/src/zcode-protocol-v4/workspace-hook-review.ts` | `872ad960` | +59/-0 | 未提交 | — |
| ZC-DEEP-b75 | 59 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-history.ts` | `54f51bad` | +59/-0 | 未提交 | — |
| ZC-DEEP-b75 | 59 | `packages/shared/src/localTtft.ts` | `872ad960` | +59/-0 | 未提交 | — |
| ZC-DEEP-b75 | 58 | `packages/server/src/remote/remoteDeployLock.ts` | `0a1fc56d` | +58/-0 | 未提交 | — |
| ZC-DEEP-b75 | 58 | `packages/desktop/src/renderer/src/plugin-sandbox/genUi.ts` | `0a1fc56d` | +58/-0 | 未提交 | — |
| ZC-DEEP-b75 | 60 | `packages/web/src/web-remote-control/app/webRemoteControlEntry.ts` | `0a1fc56d` | +60/-0 | 未提交 | — |
| ZC-DEEP-b75 | 59 | `packages/ui/src/v4/conversationTurnWorkSegments.ts` | `0a1fc56d` | +59/-0 | 未提交 | — |
| ZC-DEEP-b75 | 61 | `packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChartView.tsx` | `872ad960` | +61/-0 | 未提交 | — |
| ZC-DEEP-b75 | 59 | `packages/ui/src/chat-input-toolbar/ComposerProviderMenu.tsx` | `0a1fc56d` | +59/-0 | 未提交 | — |
| ZC-DEEP-b75 | 60 | `packages/ui/src/components/ai-elements/terminal.tsx` | `872ad960` | +60/-0 | 未提交 | — |
| ZC-DEEP-b75 | 60 | `packages/ui/src/lib/taskModelRecovery.ts` | `aac47556` | +60/-0 | 未提交 | — |
| ZC-DEEP-b75 | 60 | `packages/ui/src/plugin-ui/adapters/usePluginUiToolCallModel.ts` | `0a1fc56d` | +60/-0 | 未提交 | — |
| ZC-DEEP-b75 | 59 | `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx` | `872ad960` | +55/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b76 | 60 | `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts` | `0f2ef80d` | +60/-0 | 未提交 | — |
| ZC-DEEP-b76 | 59 | `apps/zcode-cli/packages/core/src/hooks/workspace-hook-review-flow.ts` | `c788b9f1` | +59/-0 | 未提交 | — |
| ZC-DEEP-b76 | 59 | `apps/zcode-cli/packages/core/src/runtime/methods/context.ts` | `55fedda3` | +59/-0 | 未提交 | — |
| ZC-DEEP-b76 | 60 | `apps/zcode-cli/packages/tui/src/app-tool-transcript.ts` | `a7af675d` | +60/-0 | 未提交 | — |
| ZC-DEEP-b76 | 60 | `packages/ui/src/components/ai-elements/queue.tsx` | `872ad960` | +60/-0 | 未提交 | — |
| ZC-DEEP-b76 | 60 | `packages/ui/src/DesktopTopOverlay.tsx` | `0a1fc56d` | +47/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b77 | 59 | `packages/ui/src/hooks/useComposerConnectionSwitch.ts` | `0a1fc56d` | +59/-0 | 未提交 | — |
| ZC-DEEP-b77 | 59 | `packages/ui/src/hooks/useSessionSubagents.ts` | `aac47556` | +59/-0 | 未提交 | — |
| ZC-DEEP-b77 | 58 | `packages/ui/src/lib/builtinSkillI18n.ts` | `0a1fc56d` | +58/-0 | 未提交 | — |
| ZC-DEEP-b77 | 59 | `packages/ui/src/mentions/providers/sessionsMentionProvider.ts` | `0a1fc56d` | +59/-0 | 未提交 | — |
| ZC-DEEP-b77 | 58 | `packages/ui/src/remote-connection/RemoteConnectionHistoryInput.tsx` | `0a1fc56d` | +54/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b77 | 58 | `packages/ui/src/ToolCallBlocks/fileSummaries.ts` | `872ad960` | +58/-0 | 未提交 | — |
| ZC-DEEP-b78 | 59 | `packages/ui/src/GitPaneChangeCard.tsx` | `872ad960` | +43/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b78 | 60 | `packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx` | `aac47556` | +60/-0 | 未提交 | — |
| ZC-DEEP-b78 | 58 | `packages/ui/src/browser-use/ResponsiveBrowserResizeHandles.tsx` | `0a1fc56d` | +58/-0 | 未提交 | — |
| ZC-DEEP-b78 | 58 | `packages/ui/src/cua-permission/CuaPermissionObservationAttachment.tsx` | `aac47556` | +58/-0 | 未提交 | — |
| ZC-DEEP-b78 | 58 | `packages/ui/src/gen-ui/adapters/retainedPage.ts` | `aac47556` | +58/-0 | 未提交 | — |
| ZC-DEEP-b78 | 58 | `packages/ui/src/git-branch-switcher/display.ts` | `872ad960` | +58/-0 | 未提交 | — |
| ZC-DEEP-b79 | 58 | `packages/ui/src/ToolCallBlocks/renderers/cron-create.tsx` | `0a1fc56d` | +58/-0 | 未提交 | — |
| ZC-DEEP-b79 | 58 | `packages/ui/src/ToolCallBlocks/renderers/goal.tsx` | `872ad960` | +58/-0 | 未提交 | — |
| ZC-DEEP-b79 | 57 | `packages/desktop/src/renderer/src/desktopPlatform.ts` | `0a1fc56d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b79 | 61 | `packages/shared/src/zcode-protocol-v4/snapshot.ts` | `0a1fc56d` | +61/-0 | 未提交 | — |
| ZC-DEEP-b79 | 57 | `packages/ui/src/components/ai-elements/model-selector.tsx` | `aac47556` | +49/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b79 | 58 | `packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.tsx` | `872ad960` | +58/-0 | 未提交 | — |
| ZC-DEEP-b80 | 57 | `packages/ui/src/hooks/useModelProviders.ts` | `872ad960` | +57/-0 | 未提交 | — |
| ZC-DEEP-b80 | 57 | `packages/ui/src/hooks/usePlugins.ts` | `872ad960` | +57/-0 | 未提交 | — |
| ZC-DEEP-b80 | 57 | `packages/zcode-server-cli/src/runtime/updateCommand.ts` | `0a1fc56d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b80 | 57 | `packages/zcode-server-cli/src/runtime/updateHandoff.ts` | `0a1fc56d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b80 | 58 | `packages/ui/src/conversation-share-interaction/conversationSharePopoverActions.ts` | `0a1fc56d` | +58/-0 | 未提交 | — |
| ZC-DEEP-b80 | 58 | `packages/ui/src/components/workflow-timeline/WorkflowSaveFields.tsx` | `aac47556` | +34/-0 | 部分未提交 | 差 24 行 |
| ZC-DEEP-b81 | 57 | `packages/shared/src/desktopMenu.ts` | `872ad960` | +57/-0 | 未提交 | — |
| ZC-DEEP-b81 | 57 | `packages/shared/src/node/atomicFileLock.ts` | `872ad960` | +57/-0 | 未提交 | — |
| ZC-DEEP-b81 | 57 | `packages/shared/src/telemetry.ts` | `0a1fc56d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b81 | 59 | `apps/zcode-cli/packages/core/src/errors/error-payload.ts` | `aac47556` | +108/-8 | 台账与实测不符 | 超出 49 行 |
| ZC-DEEP-b81 | 56 | `packages/e2e-report/src/viewer/CoveragePanel.tsx` | `aac47556` | +50/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b81 | 57 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-reference-catalog.ts` | `0f2ef80d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b82 | 56 | `packages/ui/src/project-sidebar/useProjectRemoteSync.tsx` | `0a1fc56d` | +56/-0 | 未提交 | — |
| ZC-DEEP-b82 | 57 | `packages/ui/src/project-sidebar/view.ts` | `3c5b2276` | +57/-0 | 未提交 | — |
| ZC-DEEP-b82 | 55 | `packages/ui/src/project-sidebar/ArchiveManagement.tsx` | `0a1fc56d` | +49/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b82 | 57 | `packages/ui/src/store/remoteWorkspaceSessionStore.ts` | `0a1fc56d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b82 | 57 | `packages/ui/src/v4/attachmentUploadTransaction.ts` | `aac47556` | +57/-0 | 未提交 | — |
| ZC-DEEP-b82 | 57 | `packages/ui/src/v4/telemetry/ConversationTelemetryAttachment.tsx` | `872ad960` | +57/-0 | 未提交 | — |
| ZC-DEEP-b83 | 55 | `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b83 | 54 | `packages/desktop/src/main/desktopNetworkTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b83 | 55 | `packages/desktop/src/main/mcpUserDirectory/legacy.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b83 | 54 | `packages/shared/src/settings-sync.ts` | `872ad960` | +28/-0 | 部分未提交 | 差 26 行 |
| ZC-DEEP-b83 | 55 | `packages/desktop/scripts/gen-ui-fixture/external-links-checks.ts` | `aac47556` | +32/-0 | 部分未提交 | 差 23 行 |
| ZC-DEEP-b83 | 55 | `packages/desktop/scripts/mcp-apps-host-fixture/interaction-main.ts` | `0a1fc56d` | +28/-0 | 部分未提交 | 差 27 行 |
| ZC-DEEP-b84 | 55 | `packages/ui/src/lib/codingPlanUsageSources.ts` | `aac47556` | +55/-0 | 未提交 | — |
| ZC-DEEP-b84 | 54 | `packages/ui/src/lib/assistantCodeComment.ts` | `aac47556` | +54/-0 | 未提交 | — |
| ZC-DEEP-b84 | 56 | `packages/ui/src/lib/taskListMembershipSets.ts` | `aac47556` | +56/-0 | 未提交 | — |
| ZC-DEEP-b84 | 55 | `packages/ui/src/components/workflow-timeline/WorkflowAskSettingsLines.tsx` | `aac47556` | +55/-0 | 未提交 | — |
| ZC-DEEP-b84 | 55 | `packages/ui/src/components/workflow-timeline/WorkflowRunSettingsPopover.tsx` | `aac47556` | +55/-0 | 未提交 | — |
| ZC-DEEP-b84 | 56 | `packages/ui/src/settings/model-provider-section/constants.ts` | `aac47556` | +56/-0 | 未提交 | — |
| ZC-DEEP-b85 | 55 | `packages/ui/src/ConfirmDialog.tsx` | `0a1fc56d` | +40/-0 | 部分未提交 | 差 15 行 |
| ZC-DEEP-b85 | 54 | `packages/ui/src/ModelTrajectoryTimeline.tsx` | `872ad960` | +45/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b85 | 54 | `packages/ui/src/WorkspaceEditorButtonGroup.tsx` | `aac47556` | +41/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b85 | 55 | `packages/ui/src/previewPaneOfficeDocxContent.tsx` | `872ad960` | +41/-0 | 部分未提交 | 差 14 行 |
| ZC-DEEP-b85 | 54 | `packages/ui/src/v4/ConversationHookDetailsAction.tsx` | `0a1fc56d` | +42/-0 | 部分未提交 | 差 12 行 |
| ZC-DEEP-b85 | 55 | `packages/ui/src/v4/ConversationShareSuccessDock.tsx` | `0a1fc56d` | +33/-0 | 部分未提交 | 差 22 行 |
| ZC-DEEP-b86 | 56 | `packages/ui/src/chat-input-toolbar/contextQuotaResetOpportunityReminder.tsx` | `aac47556` | +56/-0 | 未提交 | — |
| ZC-DEEP-b86 | 56 | `packages/ui/src/components/ui/floating-particles.tsx` | `aac47556` | +56/-0 | 未提交 | — |
| ZC-DEEP-b86 | 57 | `packages/ui/src/plugin-ui/adapters/usePluginUiSidePaneModel.tsx` | `0a1fc56d` | +57/-0 | 未提交 | — |
| ZC-DEEP-b86 | 56 | `apps/zcode-cli/packages/office-runtime/ui/i18n.ts` | `a7af675d` | +56/-0 | 未提交 | — |
| ZC-DEEP-b86 | 55 | `packages/ui/src/components/cloud-content-dialog/CloudDialogDescription.tsx` | `aac47556` | +55/-0 | 未提交 | — |
| ZC-DEEP-b86 | 57 | `packages/ui/src/settings/saved-workflows/SavedWorkflowLaunchDialog.tsx` | `0a1fc56d` | +50/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b87 | 55 | `packages/ui/src/workspace-file-tree/WorkspaceFileTreeList.tsx` | `aac47556` | +52/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b87 | 54 | `packages/provider/src/config/rule-data-schema.ts` | `aac47556` | +54/-0 | 未提交 | — |
| ZC-DEEP-b87 | 54 | `packages/ui/src/project-sidebar/ArchiveGroupCard.tsx` | `0a1fc56d` | +43/-0 | 部分未提交 | 差 11 行 |
| ZC-DEEP-b87 | 54 | `packages/ui/src/settings/model-provider-section/StartPlanBalanceCard.tsx` | `aac47556` | +50/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b87 | 54 | `packages/ui/src/terminal/terminalComposedInputFallback.ts` | `872ad960` | +54/-0 | 未提交 | — |
| ZC-DEEP-b87 | 54 | `packages/ui/src/WorkspaceSidebar/RemoteProjectDetailsPopover.tsx` | `0a1fc56d` | +48/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b88 | 53 | `packages/ui/src/lib/composerPlanGroups.ts` | `0a1fc56d` | +53/-0 | 未提交 | — |
| ZC-DEEP-b88 | 53 | `packages/ui/src/lib/keyboardShortcuts.ts` | `aac47556` | +53/-0 | 未提交 | — |
| ZC-DEEP-b88 | 53 | `packages/ui/src/lib/remoteConnectionPresentationErrors.ts` | `0a1fc56d` | +53/-0 | 未提交 | — |
| ZC-DEEP-b88 | 53 | `packages/ui/src/ModelTrajectorySearch.ts` | `aac47556` | +53/-0 | 未提交 | — |
| ZC-DEEP-b88 | 54 | `packages/ui/src/resource-manager/resourceUsageParts.tsx` | `aac47556` | +50/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b88 | 53 | `packages/ui/src/components/ai-elements/persona.tsx` | `872ad960` | +53/-0 | 未提交 | — |
| ZC-DEEP-b89 | 53 | `packages/ui/src/settings/settingsPageConfig.ts` | `0a1fc56d` | +53/-0 | 未提交 | — |
| ZC-DEEP-b89 | 54 | `packages/ui/src/settings/WorkspaceFileSearchSection.tsx` | `872ad960` | +54/-0 | 未提交 | — |
| ZC-DEEP-b89 | 53 | `packages/ui/src/settings/model-provider-section/ProviderModelReasoningLevelEditor.tsx` | `872ad960` | +53/-0 | 未提交 | — |
| ZC-DEEP-b89 | 53 | `packages/shared/src/marketingTouch.ts` | `aac47556` | +53/-0 | 未提交 | — |
| ZC-DEEP-b89 | 53 | `packages/shared/src/streaming-tool-input-preview.ts` | `872ad960` | +53/-0 | 未提交 | — |
| ZC-DEEP-b89 | 54 | `packages/shared/src/zcode-protocol-v4/wire-reassembly.ts` | `aac47556` | +54/-0 | 未提交 | — |
| ZC-DEEP-b90 | 53 | `packages/ui/src/components/ui/command.tsx` | `872ad960` | +53/-0 | 未提交 | — |
| ZC-DEEP-b90 | 53 | `packages/ui/src/previewPaneOfficeXlsxContent.tsx` | `872ad960` | +53/-0 | 未提交 | — |
| ZC-DEEP-b90 | 53 | `packages/ui/src/project-sidebar/ProjectSidebarNode.tsx` | `0a1fc56d` | +53/-0 | 未提交 | — |
| ZC-DEEP-b90 | 54 | `packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx` | `872ad960` | +54/-0 | 未提交 | — |
| ZC-DEEP-b90 | 53 | `packages/ui/src/v4/BotGroupDeliveryAction.tsx` | `aac47556` | +49/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b90 | 53 | `packages/ui/src/WorkspaceFileTree.tsx` | `3c5b2276` | +50/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b91 | 54 | `apps/zcode-cli/packages/tui/src/app-components.tsx` | `a7af675d` | +54/-0 | 未提交 | — |
| ZC-DEEP-b91 | 54 | `apps/zcode-cli/packages/tui/src/app-transcript-components.tsx` | `a7af675d` | +54/-0 | 未提交 | — |
| ZC-DEEP-b91 | 56 | `apps/zcode-cli/packages/office-runtime/ui/viewers/XlsxView.tsx` | `a7af675d` | +56/-0 | 未提交 | — |
| ZC-DEEP-b91 | 54 | `apps/zcode-cli/packages/office-runtime/ui/shell/panes.tsx` | `a7af675d` | +54/-0 | 未提交 | — |
| ZC-DEEP-b91 | 52 | `desktop/scripts/.../model.ts` | `—` | +0/-0 | 台账与实测不符 | file-missing |
| ZC-DEEP-b91 | 52 | `packages/desktop/scripts/mcp-apps-host-fixture/rows-renderer.tsx` | `aac47556` | +46/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b92 | 52 | `packages/ui/src/components/marketing-touch/marketingResources.ts` | `aac47556` | +52/-0 | 未提交 | — |
| ZC-DEEP-b92 | 52 | `packages/ui/src/DeleteAllArchivedTasksButton.tsx` | `872ad960` | +49/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b92 | 52 | `packages/ui/src/hooks/useSubagents.ts` | `0a1fc56d` | +52/-0 | 未提交 | — |
| ZC-DEEP-b92 | 52 | `packages/ui/src/mentions/nodes/PromptMentionNode.ts` | `872ad960` | +52/-0 | 未提交 | — |
| ZC-DEEP-b92 | 54 | `packages/ui/src/previewPaneOfficeLegacyDocContent.tsx` | `872ad960` | +54/-0 | 未提交 | — |
| ZC-DEEP-b92 | 52 | `packages/ui/src/resource-manager/NetworkSection.tsx` | `aac47556` | +46/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b93 | 55 | `apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts` | `54f51bad` | +55/-0 | 未提交 | — |
| ZC-DEEP-b93 | 52 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-git.ts` | `54f51bad` | +52/-0 | 未提交 | — |
| ZC-DEEP-b93 | 52 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts` | `54f51bad` | +52/-0 | 未提交 | — |
| ZC-DEEP-b93 | 54 | `packages/desktop/src/main/crashDumpAnnotations.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b93 | 53 | `packages/desktop/src/main/desktopTray.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b93 | 52 | `packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b94 | 54 | `packages/ui/src/v4/replaceableConversationTransport.ts` | `0a1fc56d` | +54/-0 | 未提交 | — |
| ZC-DEEP-b94 | 53 | `packages/ui/src/v4/telemetry/useSessionOpenArmsTelemetry.ts` | `aac47556` | +53/-0 | 未提交 | — |
| ZC-DEEP-b94 | 51 | `packages/ui/src/v4/ConversationUserInputContent.tsx` | `aac47556` | +51/-0 | 未提交 | — |
| ZC-DEEP-b94 | 51 | `packages/ui/src/v4/V4ChatPane.tsx` | `0a1fc56d` | +48/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b94 | 53 | `packages/ui/src/settings/SettingsPageParts.tsx` | `aac47556` | +50/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b94 | 52 | `packages/ui/src/root/oauthProviderFamilySelectionRefresh.ts` | `0a1fc56d` | +52/-0 | 未提交 | — |
| ZC-DEEP-b95 | 53 | `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-results.ts` | `522e851e` | +53/-0 | 未提交 | — |
| ZC-DEEP-b95 | 52 | `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts` | `522e851e` | +52/-0 | 未提交 | — |
| ZC-DEEP-b95 | 56 | `apps/zcode-cli/packages/adapters/src/model/runner-diagnostics.ts` | `522e851e` | +152/-0 | 台账与实测不符 | 超出 96 行 |
| ZC-DEEP-b95 | 51 | `apps/zcode-cli/packages/adapters/src/browser/playwright-command.ts` | `522e851e` | +51/-0 | 未提交 | — |
| ZC-DEEP-b95 | 54 | `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts` | `522e851e` | +54/-0 | 未提交 | — |
| ZC-DEEP-b95 | 51 | `packages/desktop/src/main/mcpUserDirectory/toml.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b96 | 51 | `packages/ui/src/store/zcodeSessionStoreSelectors.ts` | `aac47556` | +51/-0 | 未提交 | — |
| ZC-DEEP-b96 | 50 | `packages/ui/src/terminal/terminalPanelState.ts` | `aac47556` | +50/-0 | 未提交 | — |
| ZC-DEEP-b96 | 51 | `packages/ui/src/lib/userActionTraceCatalog.ts` | `aac47556` | +51/-0 | 未提交 | — |
| ZC-DEEP-b96 | 51 | `packages/ui/src/remote/remoteWorkspaceProjection.ts` | `0a1fc56d` | +51/-0 | 未提交 | — |
| ZC-DEEP-b96 | 50 | `packages/ui/src/project-sidebar/useProjectSidebarPreferences.ts` | `3c5b2276` | +50/-0 | 未提交 | — |
| ZC-DEEP-b96 | 49 | `packages/ui/src/settings/PluginStoreSourcesDialog.tsx` | `0a1fc56d` | +40/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b97 | 53 | `apps/zcode-cli/packages/cli/src/plugins-command-format.ts` | `872ad960` | +53/-0 | 未提交 | — |
| ZC-DEEP-b97 | 59 | `packages/provider-node/src/zcode-builtin-remote-synchronizer.ts` | `872ad960` | +59/-0 | 未提交 | — |
| ZC-DEEP-b97 | 53 | `packages/web/src/auth/webAuthService.ts` | `3c5b2276` | +53/-0 | 未提交 | — |
| ZC-DEEP-b97 | 53 | `packages/web/src/web-remote-control/ui/webRemoteControlConnectionSheet.tsx` | `0a1fc56d` | +45/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b97 | 53 | `packages/zcode-server-cli/src/packaging/stageDependencies.ts` | `0a1fc56d` | +53/-0 | 未提交 | — |
| ZC-DEEP-b97 | 54 | `apps/zcode-cli/packages/core/src/tool/json-schema.ts` | `c3590b12` | +54/-0 | 未提交 | — |
| ZC-DEEP-b98 | 54 | `packages/ui/src/components/ui/lightweight-diff-preview.tsx` | `872ad960` | +54/-0 | 未提交 | — |
| ZC-DEEP-b98 | 50 | `packages/ui/src/components/workflow-timeline/workflow-face-motion.ts` | `872ad960` | +50/-0 | 未提交 | — |
| ZC-DEEP-b98 | 52 | `packages/ui/src/components/workflow-timeline/WorkflowTimeline.tsx` | `aac47556` | +52/-0 | 未提交 | — |
| ZC-DEEP-b98 | 51 | `packages/ui/src/components/workflow-timeline/WorkflowTimelineStation.tsx` | `aac47556` | +51/-0 | 未提交 | — |
| ZC-DEEP-b98 | 49 | `packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.tsx` | `aac47556` | +49/-0 | 未提交 | — |
| ZC-DEEP-b98 | 50 | `packages/ui/src/conversation-share-interaction/ConversationSharePreflightStatus.tsx` | `0a1fc56d` | +50/-0 | 未提交 | — |
| ZC-DEEP-b99 | 50 | `packages/ui/src/ModelTrajectoryExpandedContent.tsx` | `872ad960` | +61/-0 | 台账与实测不符 | 超出 11 行 |
| ZC-DEEP-b99 | 49 | `packages/ui/src/TaskInteractionBadge.tsx` | `aac47556` | +49/-0 | 未提交 | — |
| ZC-DEEP-b99 | 51 | `packages/ui/src/WorkspaceWebRemoteControlTrigger.tsx` | `0a1fc56d` | +51/-0 | 未提交 | — |
| ZC-DEEP-b99 | 51 | `packages/ui/src/ToolCallBlocks/renderers.tsx` | `872ad960` | +51/-0 | 未提交 | — |
| ZC-DEEP-b99 | 50 | `packages/ui/src/hooks/useGlobalTaskList.ts` | `872ad960` | +50/-0 | 未提交 | — |
| ZC-DEEP-b99 | 52 | `packages/ui/src/settings/OffPeakHistoryTab.tsx` | `aac47556` | +36/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b100 | 49 | `packages/shared/src/model-provider-family.ts` | `872ad960` | +49/-0 | 未提交 | — |
| ZC-DEEP-b100 | 50 | `packages/shared/src/zcode-protocol-v4/wire-codec.ts` | `872ad960` | +50/-0 | 未提交 | — |
| ZC-DEEP-b100 | 49 | `packages/shared/src/zcode-protocol-v4/workflow-observation-display.ts` | `872ad960` | +49/-0 | 未提交 | — |
| ZC-DEEP-b100 | 48 | `packages/shared/src/task-realtime.ts` | `872ad960` | +48/-0 | 未提交 | — |
| ZC-DEEP-b100 | 49 | `packages/provider/src/account-provider-resolution.ts` | `0a1fc56d` | +49/-0 | 未提交 | — |
| ZC-DEEP-b100 | 50 | `packages/ui/src/web-remote-control/domain/presentation.ts` | `0a1fc56d` | +50/-0 | 未提交 | — |
| ZC-DEEP-b101 | 51 | `apps/zcode-cli/packages/dynamic-workflow/src/schema/emit.ts` | `872ad960` | +51/-0 | 未提交 | — |
| ZC-DEEP-b101 | 48 | `apps/zcode-cli/packages/dynamic-workflow/src/schema/validate.ts` | `872ad960` | +48/-0 | 未提交 | — |
| ZC-DEEP-b101 | 49 | `packages/ui/src/settings/saved-workflows/SavedWorkflowArgsTable.tsx` | `872ad960` | +38/-0 | 部分未提交 | 差 11 行 |
| ZC-DEEP-b101 | 48 | `packages/ui/src/settings/PluginScopeMenu.tsx` | `0a1fc56d` | +45/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b101 | 48 | `packages/ui/src/settings/SourceServerMigrationReportPanel.tsx` | `0a1fc56d` | +45/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b101 | 53 | `packages/ui/src/app-shell/WorkflowRunSidePane.tsx` | `0a1fc56d` | +53/-0 | 未提交 | — |
| ZC-DEEP-b102 | 53 | `apps/zcode-cli/packages/core/src/workflow/scheduler/node-runner.ts` | `73782160` | +53/-0 | 未提交 | — |
| ZC-DEEP-b102 | 50 | `packages/desktop/src/main/browserView/browserScreenshotCapture.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b102 | 52 | `packages/desktop/tsup.config.ts` | `0a1fc56d` | +52/-0 | 未提交 | — |
| ZC-DEEP-b102 | 50 | `apps/dev-docs/src/capability-map/CapabilityMapFlowElements.tsx` | `10e9df51` | +50/-0 | 未提交 | — |
| ZC-DEEP-b102 | 49 | `packages/ui/src/browser-use/useResponsiveBrowserViewportControl.ts` | `0a1fc56d` | +49/-0 | 未提交 | — |
| ZC-DEEP-b102 | 49 | `packages/ui/src/lib/sessionOpenArmsTelemetry.ts` | `aac47556` | +49/-0 | 未提交 | — |
| ZC-DEEP-b103 | 50 | `packages/ui/src/mentions/providers/fileMentionProvider.ts` | `0a1fc56d` | +50/-0 | 未提交 | — |
| ZC-DEEP-b103 | 52 | `apps/zcode-cli/packages/adapters/src/storage/session-target.ts` | `522e851e` | +52/-0 | 未提交 | — |
| ZC-DEEP-b103 | 48 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-core.ts` | `54f51bad` | +48/-0 | 未提交 | — |
| ZC-DEEP-b103 | 50 | `apps/zcode-cli/packages/core/src/tool/handlers/cron.ts` | `bce5596a` | +50/-0 | 未提交 | — |
| ZC-DEEP-b103 | 48 | `packages/ui/src/AssistantCodeCommentCards.tsx` | `872ad960` | +48/-0 | 未提交 | — |
| ZC-DEEP-b103 | 48 | `packages/ui/src/components/workflow-run-line/TaskWorkflowRunLines.tsx` | `aac47556` | +48/-0 | 未提交 | — |
| ZC-DEEP-b104 | 49 | `packages/ui/src/plugin-ui/app/pluginUiAppTools.ts` | `aac47556` | +49/-0 | 未提交 | — |
| ZC-DEEP-b104 | 48 | `packages/ui/src/project-sidebar/ProjectTaskRows.tsx` | `0a1fc56d` | +48/-0 | 未提交 | — |
| ZC-DEEP-b104 | 47 | `packages/ui/src/v4/composer/useCodeCommentContexts.ts` | `aac47556` | +47/-0 | 未提交 | — |
| ZC-DEEP-b104 | 50 | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts` | `522e851e` | +50/-0 | 未提交 | — |
| ZC-DEEP-b104 | 48 | `apps/zcode-cli/packages/core/src/plugin-reference/reminder.ts` | `872ad960` | +48/-0 | 未提交 | — |
| ZC-DEEP-b104 | 50 | `apps/zcode-cli/packages/debug/server/network-capture.ts` | `3ead6c6a` | +50/-0 | 未提交 | — |
| ZC-DEEP-b105 | 47 | `packages/ui/src/app-shell/useAppChromeState.ts` | `872ad960` | +40/-0 | 部分未提交 | 差 7 行 |
| ZC-DEEP-b105 | 47 | `packages/ui/src/components/TaskTitleOverflowText.tsx` | `872ad960` | +31/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b105 | 47 | `packages/ui/src/global-notice/globalNoticeStore.ts` | `aac47556` | +28/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b105 | 48 | `packages/ui/src/highspeed/highspeedShare.ts` | `aac47556` | +29/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b105 | 46 | `packages/ui/src/lib/toolCallTree.ts` | `aac47556` | +28/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b105 | 48 | `packages/ui/src/mentions/mentionMarkdown.ts` | `aac47556` | +28/-0 | 部分未提交 | 差 20 行 |
| ZC-DEEP-b106 | 49 | `apps/zcode-cli/packages/tui/src/app-shiki-diff-view.tsx` | `a7af675d` | +49/-0 | 未提交 | — |
| ZC-DEEP-b106 | 47 | `docs/knip/docs/scripts/generate-plugin-docs.ts` | `aac47556` | +47/-0 | 未提交 | — |
| ZC-DEEP-b106 | 47 | `packages/desktop/scripts/gen-ui-fixture/runtime-checks.ts` | `aac47556` | +47/-0 | 未提交 | — |
| ZC-DEEP-b106 | 46 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-model-checks.ts` | `aac47556` | +46/-0 | 未提交 | — |
| ZC-DEEP-b106 | 48 | `packages/desktop/src/main/desktopCronScheduler.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b106 | 47 | `packages/desktop/src/main/pluginSandbox/registry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b107 | 47 | `packages/provider-node/src/zcode-builtin-provider-config-source.ts` | `872ad960` | +47/-0 | 未提交 | — |
| ZC-DEEP-b107 | 49 | `packages/shared/src/mcp.ts` | `0a1fc56d` | +49/-0 | 未提交 | — |
| ZC-DEEP-b107 | 47 | `packages/shared/src/web-remote-relay/contract.ts` | `0a1fc56d` | +47/-0 | 未提交 | — |
| ZC-DEEP-b107 | 47 | `packages/ui/src/components/workflow-timeline/WorkflowAskSettingsParts.tsx` | `aac47556` | +47/-0 | 未提交 | — |
| ZC-DEEP-b107 | 48 | `packages/ui/src/hooks/useWorkspaceProviderConfigFile.ts` | `aac47556` | +48/-0 | 未提交 | — |
| ZC-DEEP-b107 | 47 | `packages/ui/src/resource-manager/storage/StorageCategoryDetail.tsx` | `0a1fc56d` | +31/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b108 | 46 | `packages/ui/src/settings/model-provider-section/ProviderTemplatePicker.tsx` | `0a1fc56d` | +28/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b108 | 47 | `packages/ui/src/ToolCallBlocks/renderers/list-workflow-runs.tsx` | `872ad960` | +29/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b108 | 46 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-file.ts` | `54f51bad` | +28/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b108 | 47 | `apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts` | `54f51bad` | +28/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b108 | 50 | `apps/zcode-cli/packages/ios-simulator-plugin/src/mcp/server.ts` | `32fe1002` | +40/-0 | 部分未提交 | 差 10 行 |
| ZC-DEEP-b108 | 49 | `apps/zcode-cli/packages/office-runtime/ui/viewers/DocxView.tsx` | `a7af675d` | +29/-0 | 部分未提交 | 差 20 行 |
| ZC-DEEP-b109 | 47 | `apps/zcode-cli/packages/tui/src/app-selection-panel.tsx` | `a7af675d` | +47/-0 | 未提交 | — |
| ZC-DEEP-b109 | 45 | `packages/client/src/webRemoteControlAcknowledgedRelayProtocolTypes.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b109 | 46 | `packages/desktop/src/main/desktopContextPromptRollout.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b109 | 46 | `packages/desktop/src/main/embeddedBrowserJavaScriptDialog.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b109 | 46 | `packages/desktop/src/main/localTtftSpans.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b109 | 46 | `packages/shared/src/database-startup.ts` | `872ad960` | +46/-0 | 未提交 | — |
| ZC-DEEP-b110 | 45 | `packages/shared/src/tool-plan-adapter.ts` | `aac47556` | +39/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b110 | 47 | `packages/ui/src/chat-input-toolbar/StartPlanContextBalance.tsx` | `aac47556` | +37/-0 | 部分未提交 | 差 10 行 |
| ZC-DEEP-b110 | 46 | `packages/ui/src/components/ui/diff-viewer.tsx` | `872ad960` | +38/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b110 | 46 | `packages/ui/src/hooks/useBotGroupTask.ts` | `aac47556` | +38/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b110 | 47 | `packages/ui/src/hooks/useTaskNotifications.ts` | `872ad960` | +38/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b110 | 45 | `packages/ui/src/RemoteConnectionWizardChrome.tsx` | `0a1fc56d` | +36/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b111 | 45 | `packages/ui/src/root/GlobalDatabaseStartupLoading.tsx` | `872ad960` | +27/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b111 | 46 | `packages/ui/src/settings/mcpSettingsShared.ts` | `aac47556` | +27/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b111 | 46 | `packages/ui/src/settings/RemoteSkillSyncSelectionList.tsx` | `872ad960` | +27/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b111 | 46 | `packages/ui/src/TodoPanel.tsx` | `aac47556` | +27/-0 | 部分未提交 | 差 19 行 |
| ZC-DEEP-b111 | 45 | `packages/ui/src/ToolCallBlocks/renderers/search.tsx` | `0a1fc56d` | +27/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b111 | 45 | `packages/ui/src/v4/ConversationQuotaBanner.tsx` | `aac47556` | +27/-0 | 部分未提交 | 差 18 行 |
| ZC-DEEP-b112 | 46 | `packages/ui/src/WorkspaceHelpMenuButton.tsx` | `0a1fc56d` | +31/-0 | 部分未提交 | 差 15 行 |
| ZC-DEEP-b112 | 46 | `packages/web/src/auth/oauthStateCodec.ts` | `0a1fc56d` | +31/-0 | 部分未提交 | 差 15 行 |
| ZC-DEEP-b112 | 46 | `packages/zcode-server-cli/src/runtime/serviceInstallation.ts` | `aac47556` | +30/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b112 | 48 | `apps/zcode-cli/packages/adapters/src/commands/index.ts` | `522e851e` | +32/-0 | 部分未提交 | 差 16 行 |
| ZC-DEEP-b112 | 48 | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` | `522e851e` | +31/-0 | 部分未提交 | 差 17 行 |
| ZC-DEEP-b112 | 47 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts` | `0f2ef80d` | +32/-0 | 部分未提交 | 差 15 行 |
| ZC-DEEP-b113 | 46 | `apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts` | `3ead6c6a` | +42/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b113 | 47 | `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts` | `ad6dc0eb` | +39/-0 | 部分未提交 | 差 8 行 |
| ZC-DEEP-b113 | 45 | `apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts` | `872ad960` | +42/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b113 | 64 | `apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts` | `b3cc6d24` | +55/-0 | 部分未提交 | 差 9 行 |
| ZC-DEEP-b113 | 46 | `apps/zcode-cli/packages/tui/src/app-input-status.tsx` | `a7af675d` | +36/-0 | 部分未提交 | 差 10 行 |
| ZC-DEEP-b113 | 46 | `apps/zcode-cli/packages/tui/src/app-model-suggestion-panel.tsx` | `a7af675d` | +40/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b114 | 44 | `packages/desktop/scripts/mcp-apps-host-fixture/retention-main.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b114 | 47 | `packages/desktop/src/main/unreadBadge.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b114 | 45 | `packages/desktop/src/main/zcodeDataSizeScanner.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b114 | 44 | `packages/provider/src/config/schema.ts` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b114 | 45 | `packages/shared/src/feedbackPrivacy.ts` | `872ad960` | +45/-0 | 未提交 | — |
| ZC-DEEP-b114 | 45 | `packages/shared/src/gen-ui/tweakProtocol.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b115 | 45 | `packages/shared/src/project-access-token.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b115 | 45 | `packages/shared/src/remoteUsageTelemetry.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b115 | 44 | `packages/shared/src/zcode-network-debug-status.ts` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b115 | 46 | `packages/shared/src/zcode-session-visible-content.ts` | `872ad960` | +46/-0 | 未提交 | — |
| ZC-DEEP-b115 | 48 | `packages/ui/src/app-shell/WorkflowRunDirectorySidePane.tsx` | `872ad960` | +23/-0 | 部分未提交 | 差 25 行 |
| ZC-DEEP-b115 | 46 | `packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx` | `aac47556` | +46/-0 | 未提交 | — |
| ZC-DEEP-b116 | 45 | `packages/ui/src/components/ui/highlighted-lightweight-diff-preview.tsx` | `872ad960` | +45/-0 | 未提交 | — |
| ZC-DEEP-b116 | 46 | `packages/ui/src/components/workflow-timeline/WorkflowTimelineLedge.tsx` | `aac47556` | +46/-0 | 未提交 | — |
| ZC-DEEP-b116 | 45 | `packages/ui/src/feedback/feedbackMeta.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b116 | 46 | `packages/ui/src/hooks/useTabPersistence.ts` | `0a1fc56d` | +46/-0 | 未提交 | — |
| ZC-DEEP-b116 | 45 | `packages/ui/src/hooks/useWorkspaceActiveTaskState.ts` | `0a1fc56d` | +45/-0 | 未提交 | — |
| ZC-DEEP-b116 | 44 | `packages/ui/src/lib/automationTelemetry.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b117 | 46 | `packages/ui/src/lib/composerRecent.ts` | `0a1fc56d` | +46/-0 | 未提交 | — |
| ZC-DEEP-b117 | 45 | `packages/ui/src/lib/fileDisplayHelpers.ts` | `872ad960` | +45/-0 | 未提交 | — |
| ZC-DEEP-b117 | 45 | `packages/ui/src/lib/workspaceFileDrag.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b117 | 44 | `packages/ui/src/project-sidebar/contract.ts` | `3c5b2276` | +44/-0 | 未提交 | — |
| ZC-DEEP-b117 | 50 | `packages/ui/src/project-sidebar/grouped/virtualized-top-level-list.tsx` | `0a1fc56d` | +37/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b117 | 67 | `packages/ui/src/root/RootWorkspaceContent.tsx` | `0a1fc56d` | +43/-0 | 部分未提交 | 差 24 行 |
| ZC-DEEP-b118 | 45 | `packages/ui/src/settings/pluginCapabilityProjection.ts` | `aac47556` | +45/-0 | 未提交 | — |
| ZC-DEEP-b118 | 46 | `packages/ui/src/settings/ShortcutSettingsSection.tsx` | `3c5b2276` | +46/-0 | 未提交 | — |
| ZC-DEEP-b118 | 43 | `packages/ui/src/settings/AddMarketplaceSourceDialog.tsx` | `0a1fc56d` | +43/-0 | 未提交 | — |
| ZC-DEEP-b118 | 43 | `packages/ui/src/settings/SettingsResourceHeaderActions.tsx` | `872ad960` | +43/-0 | 未提交 | — |
| ZC-DEEP-b118 | 43 | `packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx` | `aac47556` | +43/-0 | 未提交 | — |
| ZC-DEEP-b118 | 43 | `packages/ui/src/project-sidebar/ProjectNode.tsx` | `0a1fc56d` | +43/-0 | 未提交 | — |
| ZC-DEEP-b119 | 44 | `packages/ui/src/terminal/terminalLinks.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b119 | 43 | `packages/ui/src/lib/exploreToolCall.ts` | `0a1fc56d` | +43/-0 | 未提交 | — |
| ZC-DEEP-b119 | 44 | `packages/ui/src/hooks/useSystemService.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b119 | 44 | `packages/ui/src/project-sidebar/RemoteIdentityHoverCard.tsx` | `0a1fc56d` | +44/-0 | 未提交 | — |
| ZC-DEEP-b119 | 44 | `packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b119 | 44 | `packages/ui/src/ToolCallBlocks/renderers/todo.tsx` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b120a | 45 | `packages/ui/src/components/workflow-timeline/WorkflowTimelineFills.tsx` | `aac47556` | +31/-0 | 部分未提交 | 差 14 行 |
| ZC-DEEP-b120a | 44 | `packages/ui/src/GitPane/helpers.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b120a | 44 | `packages/ui/src/UpdateStatusButton.tsx` | `872ad960` | +30/-0 | 部分未提交 | 差 14 行 |
| ZC-DEEP-b120a | 59 | `packages/ui/src/v4/OffPeakNewTaskEntry.tsx` | `aac47556` | +36/-0 | 部分未提交 | 差 23 行 |
| ZC-DEEP-b120b | 42 | `packages/ui/src/BotsDialog/shared.tsx` | `29628c9a` | +42/-0 | 未提交 | — |
| ZC-DEEP-b120b | 43 | `packages/ui/src/components/ui/input-group.tsx` | `872ad960` | +30/-0 | 部分未提交 | 差 13 行 |
| ZC-DEEP-b121 | 44 | `packages/shared/src/assistant-presentation.ts` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b121 | 44 | `packages/shared/src/workspaceFileSearch.ts` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b121 | 43 | `packages/ui/src/lib/chatPrepareError.ts` | `aac47556` | +26/-0 | 部分未提交 | 差 17 行 |
| ZC-DEEP-b121 | 45 | `packages/ui/src/lib/patchDiffPreview.ts` | `872ad960` | +45/-0 | 未提交 | — |
| ZC-DEEP-b122 | 43 | `packages/ui/src/components/ui/usePdfZoomOverlay.ts` | `872ad960` | +43/-0 | 未提交 | — |
| ZC-DEEP-b122 | 44 | `packages/ui/src/components/workflow-timeline/WorkflowSavePopover.tsx` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b122 | 42 | `packages/ui/src/feedback/feedbackUserView.ts` | `aac47556` | +42/-0 | 未提交 | — |
| ZC-DEEP-b122 | 42 | `packages/ui/src/hooks/useRemoteConnectionLogs.ts` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b123 | 44 | `packages/ui/src/project-sidebar/PurposeSections.tsx` | `0a1fc56d` | +44/-0 | 未提交 | — |
| ZC-DEEP-b123 | 43 | `packages/ui/src/project-sidebar/RemoteConnectionProgressSection.tsx` | `0a1fc56d` | +43/-0 | 未提交 | — |
| ZC-DEEP-b123 | 42 | `packages/ui/src/project-sidebar/RemoteConversationDisconnected.tsx` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b123 | 44 | `packages/ui/src/SaveWorkflowPermissionBlock.tsx` | `0a1fc56d` | +44/-0 | 未提交 | — |
| ZC-DEEP-b124 | 42 | `packages/ui/src/lib/taskNotificationOrchestrator.ts` | `872ad960` | +55/-0 | 台账与实测不符 | 超出 13 行 |
| ZC-DEEP-b124 | 42 | `packages/ui/src/store/mcpStoreHelpers.ts` | `aac47556` | +42/-0 | 未提交 | — |
| ZC-DEEP-b124 | 43 | `packages/ui/src/ToolCallBlocks/renderers/cuaResultState.ts` | `aac47556` | +43/-0 | 未提交 | — |
| ZC-DEEP-b124 | 42 | `packages/ui/src/resource-manager/storage/StorageDiskCard.tsx` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b125 | 44 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts` | `0f2ef80d` | +44/-0 | 未提交 | — |
| ZC-DEEP-b125 | 45 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-simple-commands.ts` | `54f51bad` | +45/-0 | 未提交 | — |
| ZC-DEEP-b125 | 45 | `apps/zcode-cli/packages/tui/src/app-submit.ts` | `a7af675d` | +45/-0 | 未提交 | — |
| ZC-DEEP-b125 | 43 | `apps/zcode-cli/packages/cli/src/clipboard-image.ts` | `10e9df51` | +43/-0 | 未提交 | — |
| ZC-DEEP-b126 | 44 | `packages/e2e-report/src/shared/types.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b126 | 44 | `packages/server/src/remote/docker-detect.ts` | `872ad960` | +44/-0 | 未提交 | — |
| ZC-DEEP-b126 | 42 | `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` | `872ad960` | +42/-0 | 未提交 | — |
| ZC-DEEP-b126 | 41 | `packages/desktop/src/main/desktopArmsCustomEvent.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b127 | 42 | `packages/shared/src/sqlite-migrations/backup.ts` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b127 | 42 | `packages/ui/src/app-shell/useWorkspaceSessionReload.ts` | `872ad960` | +42/-0 | 未提交 | — |
| ZC-DEEP-b127 | 42 | `packages/desktop/src/main/pluginSandbox/guestPolicy.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b127 | 58 | `packages/provider-node/src/personal-provider-config-repository.ts` | `872ad960` | +59/-0 | 台账与实测不符 | 超出 1 行 |
| ZC-DEEP-b128 | 42 | `packages/desktop/scripts/gen-ui-fixture/renderer.ts` | `aac47556` | +42/-0 | 未提交 | — |
| ZC-DEEP-b128 | 42 | `packages/ui/src/hooks/useSettingService.ts` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b128 | 44 | `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` | `0a1fc56d` | +176/-22 | 台账与实测不符 | 超出 132 行 |
| ZC-DEEP-b128 | 45 | `apps/zcode-cli/packages/tui/src/app-question-state.ts` | `a7af675d` | +45/-0 | 未提交 | — |
| ZC-DEEP-b129 | 44 | `apps/zcode-cli/packages/core/src/tool/handlers/grep.ts` | `54f51bad` | +44/-0 | 未提交 | — |
| ZC-DEEP-b129 | 43 | `apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts` | `55fedda3` | +43/-0 | 未提交 | — |
| ZC-DEEP-b129 | 41 | `packages/ui/src/lib/modelConfigSync.ts` | `aac47556` | +41/-0 | 未提交 | — |
| ZC-DEEP-b129 | 42 | `packages/ui/src/lib/chatErrorBannerTelemetry.ts` | `aac47556` | +50/-0 | 台账与实测不符 | 超出 8 行 |
| ZC-DEEP-b130 | 48 | `packages/provider-node/src/provider-config-runtime.ts` | `872ad960` | +74/-0 | 台账与实测不符 | 超出 26 行 |
| ZC-DEEP-b130 | 42 | `packages/ui/src/hooks/usePptxFileWatch.ts` | `aac47556` | +42/-0 | 未提交 | — |
| ZC-DEEP-b130 | 44 | `packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b130 | 42 | `packages/ui/src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b131 | 43 | `packages/ui/src/settings/model-provider-section/ProviderDetailFeedback.tsx` | `aac47556` | +43/-0 | 未提交 | — |
| ZC-DEEP-b131 | 43 | `packages/ui/src/settings/model-provider-section/SortableProviderModelList.tsx` | `aac47556` | +43/-0 | 未提交 | — |
| ZC-DEEP-b131 | 43 | `packages/ui/src/settings/SourceServerUpdateActivity.tsx` | `0a1fc56d` | +43/-0 | 未提交 | — |
| ZC-DEEP-b131 | 45 | `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts` | `0f2ef80d` | +45/-0 | 未提交 | — |
| ZC-DEEP-b132 | 44 | `packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx` | `aac47556` | +44/-0 | 未提交 | — |
| ZC-DEEP-b132 | 41 | `packages/ui/src/components/ui/alert-dialog.tsx` | `872ad960` | +41/-0 | 未提交 | — |
| ZC-DEEP-b132 | 42 | `packages/ui/src/hooks/useWorkspaceServices.tsx` | `0a1fc56d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b132 | 41 | `packages/ui/src/project-sidebar/HomeOnlyWorkspaceRows.tsx` | `0a1fc56d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b133 | 48 | `packages/ui/src/WorkflowPermissionBlock.tsx` | `aac47556` | +24/-0 | 部分未提交 | 差 24 行 |
| ZC-DEEP-b133 | 41 | `packages/ui/src/browser-use/BrowserSitePermissionsPage.tsx` | `aac47556` | +41/-0 | 未提交 | — |
| ZC-DEEP-b133 | 41 | `packages/ui/src/ToolCallBlocks/renderers/offpeak-create.tsx` | `0a1fc56d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b134 | 40 | `packages/ui/src/app-shell/sidePaneTabPresentation.ts` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b134 | 40 | `packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx` | `872ad960` | +40/-0 | 未提交 | — |
| ZC-DEEP-b134 | 41 | `packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx` | `0a1fc56d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b135 | 40 | `packages/server/src/remote/wsl-detect.ts` | `67be296b` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b135 | 40 | `packages/server/src/remote/wslProxy.ts` | `67be296b` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b135 | 40 | `packages/model-option-map/src/tokenizer.ts` | `67be296b` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b136 | 41 | `packages/ui/src/components/ui/dialog.tsx` | `0a1fc56d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b136 | 42 | `packages/ui/src/app-shell/WorkflowRunSpineParts.tsx` | `aac47556` | +42/-0 | 未提交 | — |
| ZC-DEEP-b136 | 42 | `packages/ui/src/components/workflow-timeline/WorkflowTimelineTracks.tsx` | `aac47556` | +42/-0 | 未提交 | — |
| ZC-DEEP-b136 | 40 | `packages/ui/src/hooks/useGitAutoRefresh.ts` | `872ad960` | +40/-0 | 未提交 | — |
| ZC-DEEP-b137 | 42 | `apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts` | `c788b9f1` | +42/-0 | 未提交 | — |
| ZC-DEEP-b137 | 44 | `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts` | `872ad960` | +123/-7 | 台账与实测不符 | 超出 79 行 |
| ZC-DEEP-b137 | 43 | `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts` | `bce5596a` | +43/-0 | 未提交 | — |
| ZC-DEEP-b137 | 41 | `apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx` | `a7af675d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b138 | 47 | `apps/zcode-cli/packages/adapters/src/config/schema.ts` | `522e851e` | +47/-0 | 未提交 | — |
| ZC-DEEP-b138 | 46 | `apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts` | `32fe1002` | +46/-0 | 未提交 | — |
| ZC-DEEP-b138 | 43 | `packages/ui/src/components/workflow-timeline/WorkflowRunSettingsFields.tsx` | `aac47556` | +43/-0 | 未提交 | — |
| ZC-DEEP-b138 | 41 | `packages/desktop/src/main/processResourceMcpTelemetrySource.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b139 | 40 | `packages/desktop/src/main/rendererActionTraceIpc.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b139 | 64 | `packages/provider/src/registry-service.ts` | `7aeaf5ba` | +67/-0 | 台账与实测不符 | 超出 3 行 |
| ZC-DEEP-b139 | 46 | `packages/provider/src/registry.ts` | `872ad960` | +46/-0 | 未提交 | — |
| ZC-DEEP-b139 | 41 | `packages/stream-animate/src/App.tsx` | `aac47556` | +41/-0 | 未提交 | — |
| ZC-DEEP-b140 | 41 | `packages/ui/src/hooks/useWebElementPicker.ts` | `872ad960` | +41/-0 | 未提交 | — |
| ZC-DEEP-b140 | 40 | `packages/ui/src/plugin-ui/adapters/useRecommendedUiPlugins.ts` | `3c5b2276` | +40/-0 | 未提交 | — |
| ZC-DEEP-b140 | 40 | `packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts` | `872ad960` | +40/-0 | 未提交 | — |
| ZC-DEEP-b140 | 40 | `packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx` | `872ad960` | +40/-0 | 未提交 | — |
| ZC-DEEP-b141 | 40 | `packages/ui/src/settings/AutomationDesignPrimitives.tsx` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b141 | 41 | `packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx` | `872ad960` | +41/-0 | 未提交 | — |
| ZC-DEEP-b141 | 41 | `packages/ui/src/v4/composer/useWebElementContexts.ts` | `aac47556` | +41/-0 | 未提交 | — |
| ZC-DEEP-b141 | 41 | `packages/ui/src/v4/conversationSharePreflightCache.ts` | `aac47556` | +41/-0 | 未提交 | — |
| ZC-DEEP-b142 | 41 | `apps/zcode-cli/packages/adapters/src/browser/snapshot.ts` | `522e851e` | +41/-0 | 未提交 | — |
| ZC-DEEP-b142 | 41 | `apps/zcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts` | `0f2ef80d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b142 | 42 | `apps/zcode-cli/packages/bootstrap/src/subagents.ts` | `0f2ef80d` | +42/-0 | 未提交 | — |
| ZC-DEEP-b142 | 43 | `apps/zcode-cli/packages/core/src/repl/node-repl-session.ts` | `aac47556` | +43/-0 | 未提交 | — |
| ZC-DEEP-b143 | 40 | `packages/ui/src/v4/useAssistantPreviewCardsForRow.ts` | `aac47556` | +40/-0 | 未提交 | — |
| ZC-DEEP-b143 | 41 | `apps/zcode-cli/packages/core/src/runtime/methods/workspace-fork.ts` | `55fedda3` | +41/-0 | 未提交 | — |
| ZC-DEEP-b143 | 40 | `apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts` | `c788b9f1` | +40/-0 | 未提交 | — |
| ZC-DEEP-b143 | 41 | `apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx` | `a7af675d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b144 | 40 | `packages/desktop/scripts/gen-ui-fixture/standalone-checks.ts` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b144 | 43 | `packages/desktop/src/host/browserControlMainBridge.ts` | `e6ff6fab` | +43/-0 | 未提交 | — |
| ZC-DEEP-b144 | 42 | `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` | `e6ff6fab` | +42/-0 | 未提交 | — |
| ZC-DEEP-b144 | 40 | `packages/desktop/src/main/desktopNetworkPolicy.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b145 | 39 | `packages/provider-node/src/legacy-reasoning-level-renames.ts` | `0a1fc56d` | +39/-0 | 未提交 | — |
| ZC-DEEP-b145 | 39 | `packages/provider-node/src/provider-config-file-codec.ts` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b145 | 39 | `packages/shared/src/channel-mention.ts` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b145 | 39 | `packages/shared/src/rendererActionTrace.ts` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b146 | 39 | `packages/ui/src/BotsDialog/WorkspaceAccessCard.tsx` | `0a1fc56d` | +39/-0 | 未提交 | — |
| ZC-DEEP-b146 | 46 | `packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx` | `0a1fc56d` | +46/-0 | 未提交 | — |
| ZC-DEEP-b146 | 39 | `packages/ui/src/feedback/feedbackTimelineSummary.ts` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b146 | 39 | `packages/ui/src/gen-ui/components/TweakPanel.tsx` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b147 | 39 | `packages/ui/src/lib/mermaidRenderBudget.ts` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b147 | 40 | `packages/ui/src/lib/officeFilePreview.ts` | `aac47556` | +40/-0 | 未提交 | — |
| ZC-DEEP-b147 | 40 | `packages/ui/src/plugin-ui/app/pluginUiPageManager.ts` | `aac47556` | +40/-0 | 未提交 | — |
| ZC-DEEP-b147 | 39 | `packages/ui/src/previewPaneOfficeContent.tsx` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b148 | 40 | `packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b148 | 39 | `packages/ui/src/settings/DataBaseDirControl.tsx` | `0a1fc56d` | +39/-0 | 未提交 | — |
| ZC-DEEP-b148 | 39 | `packages/ui/src/store/codeCommentPreviewStore.ts` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b148 | 40 | `packages/ui/src/store/pluginManagementStoreEnabled.ts` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b149 | 39 | `packages/ui/src/ToolCallBlocks/renderers/task-output.tsx` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b149 | 39 | `packages/ui/src/v4/ConversationSelectionTooltip.tsx` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b149 | 40 | `packages/ui/src/v4/ConversationUserInputBody.tsx` | `aac47556` | +40/-0 | 未提交 | — |
| ZC-DEEP-b149 | 39 | `packages/ui/src/v4/featureSuggestedPromptRotation.ts` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b150 | 40 | `packages/ui/src/v4/WorkbenchSplitDivider.tsx` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b150 | 39 | `packages/zcode-server-cli/src/runtime/releaseDownload.ts` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b150 | 40 | `packages/zcode-server-cli/src/server-core/core.ts` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b150 | 41 | `apps/dev-docs/src/capability-map/capabilityMapLayout.ts` | `10e9df51` | +41/-0 | 未提交 | — |
| ZC-DEEP-b151 | 55 | `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` | `32fe1002` | +55/-0 | 未提交 | — |
| ZC-DEEP-b152 | 40 | `apps/zcode-cli/packages/core/src/agent/turn-state.ts` | `0a1fc56d` | +40/-0 | 未提交 | — |
| ZC-DEEP-b152 | 41 | `apps/zcode-cli/packages/core/src/runtime-task/workflow-notification-copy.ts` | `0a1fc56d` | +41/-0 | 未提交 | — |
| ZC-DEEP-b152 | 42 | `apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts` | `55fedda3` | +42/-0 | 未提交 | — |
| ZC-DEEP-b152 | 39 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-git-runtime-safety.ts` | `54f51bad` | +39/-0 | 未提交 | — |
| ZC-DEEP-b153 | 40 | `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts` | `522e851e` | +40/-0 | 未提交 | — |
| ZC-DEEP-b153 | 39 | `apps/zcode-cli/packages/cli/src/commands-command.ts` | `10e9df51` | +39/-0 | 未提交 | — |
| ZC-DEEP-b153 | 39 | `packages/server/src/remote/remoteAssetPreflight.ts` | `0a1fc56d` | +39/-0 | 未提交 | — |
| ZC-DEEP-b153 | 39 | `packages/shared/src/cloudContent.ts` | `aac47556` | +39/-0 | 未提交 | — |
| ZC-DEEP-b154 | 39 | `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b154 | 38 | `packages/ui/src/ControlHintTooltip.tsx` | `0a1fc56d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b154 | 40 | `packages/ui/src/embeddedBrowserHelpers.ts` | `aac47556` | +40/-0 | 未提交 | — |
| ZC-DEEP-b154 | 38 | `packages/ui/src/lib/chatSessionScrollMemory.ts` | `aac47556` | +38/-0 | 未提交 | — |
| ZC-DEEP-b155 | 38 | `packages/ui/src/lib/modeConfigUpdateGuard.ts` | `aac47556` | +38/-0 | 未提交 | — |
| ZC-DEEP-b155 | 38 | `packages/ui/src/mentions/mentionSearch.ts` | `aac47556` | +38/-0 | 未提交 | — |
| ZC-DEEP-b155 | 38 | `packages/ui/src/project-sidebar/grouped/task-item.tsx` | `0a1fc56d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b155 | 38 | `packages/ui/src/settings/useWorkspaceHookInlineTrust.ts` | `0a1fc56d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b156 | 40 | `packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx` | `872ad960` | +40/-0 | 未提交 | — |
| ZC-DEEP-b156 | 38 | `packages/ui/src/v4/composer/useConversationSelectionReferences.ts` | `0a1fc56d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b156 | 39 | `packages/ui/src/v4/telemetry/localTtftRecord.ts` | `872ad960` | +39/-0 | 未提交 | — |
| ZC-DEEP-b156 | 38 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts` | `0f2ef80d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b157 | 40 | `apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts` | `55fedda3` | +40/-0 | 未提交 | — |
| ZC-DEEP-b157 | 49 | `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` | `aac47556` | +251/-32 | 台账与实测不符 | 超出 202 行 |
| ZC-DEEP-b157 | 37 | `docs/knip/docs/src/util/post.ts` | `aac47556` | +37/-0 | 未提交 | — |
| ZC-DEEP-b157 | 37 | `packages/desktop/scripts/mcp-apps-host-fixture/sampling-extra-checks.ts` | `aac47556` | +37/-0 | 未提交 | — |
| ZC-DEEP-b158 | 40 | `packages/desktop/src/host/sourceServerManagementService.ts` | `e6ff6fab` | +40/-0 | 未提交 | — |
| ZC-DEEP-b158 | 39 | `packages/desktop/src/host/taskRealtimeBridge.ts` | `e6ff6fab` | +39/-0 | 未提交 | — |
| ZC-DEEP-b158 | 37 | `packages/desktop/src/main/databaseStartupTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b158 | 38 | `packages/server/src/remote/remoteAssetCdn.ts` | `872ad960` | +38/-0 | 未提交 | — |
| ZC-DEEP-b159 | 37 | `packages/server/src/source-server/sourceServerTransportRuntime.ts` | `0a1fc56d` | +37/-0 | 未提交 | — |
| ZC-DEEP-b159 | 38 | `packages/shared/src/feedback.ts` | `872ad960` | +38/-0 | 未提交 | — |
| ZC-DEEP-b159 | 38 | `packages/ui/src/components/marketing-touch/MarketingBanner.tsx` | `aac47556` | +38/-0 | 未提交 | — |
| ZC-DEEP-b159 | 38 | `packages/ui/src/components/ui/flip-metric-value.tsx` | `872ad960` | +38/-0 | 未提交 | — |
| ZC-DEEP-b160 | 37 | `packages/ui/src/lib/shikiHighlighter.ts` | `aac47556` | +37/-0 | 未提交 | — |
| ZC-DEEP-b160 | 38 | `packages/ui/src/lib/zcodeFileCitation.ts` | `aac47556` | +38/-0 | 未提交 | — |
| ZC-DEEP-b160 | 37 | `packages/ui/src/lib/zcodeSessionEventOrder.ts` | `aac47556` | +37/-0 | 未提交 | — |
| ZC-DEEP-b160 | 38 | `packages/ui/src/project-workflow/useWorkflowRunSave.ts` | `0a1fc56d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b161 | 38 | `packages/ui/src/settings/saved-workflows/SavedWorkflowMetaForm.tsx` | `872ad960` | +34/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b161 | 38 | `packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx` | `0a1fc56d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b161 | 37 | `packages/web/src/web-remote-control/ui/webRemoteControlFailureScreen.tsx` | `0a1fc56d` | +37/-0 | 未提交 | — |
| ZC-DEEP-b161 | 41 | `apps/zcode-cli/packages/adapters/src/storage/index.ts` | `522e851e` | +41/-0 | 未提交 | — |
| ZC-DEEP-b162 | 37 | `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts` | `0f2ef80d` | +37/-0 | 未提交 | — |
| ZC-DEEP-b162 | 38 | `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` | `0f2ef80d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b162 | 36 | `apps/zcode-cli/packages/cli/src/command-center/login-flow.ts` | `3ead6c6a` | +36/-0 | 未提交 | — |
| ZC-DEEP-b162 | 36 | `apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts` | `3ead6c6a` | +36/-0 | 未提交 | — |
| ZC-DEEP-b163 | 39 | `apps/zcode-cli/packages/core/src/runtime/deps.ts` | `ad6dc0eb` | +39/-0 | 未提交 | — |
| ZC-DEEP-b163 | 41 | `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts` | `fb9e504b` | +41/-0 | 未提交 | — |
| ZC-DEEP-b163 | 37 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts` | `54f51bad` | +37/-0 | 未提交 | — |
| ZC-DEEP-b163 | 36 | `apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts` | `aac47556` | +36/-0 | 未提交 | — |
| ZC-DEEP-b164 | 37 | `packages/ui/src/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.tsx` | `aac47556` | +37/-0 | 未提交 | — |
| ZC-DEEP-b164 | 38 | `packages/ui/src/components/workflow-timeline/WorkflowArtifactIndex.tsx` | `872ad960` | +38/-0 | 未提交 | — |
| ZC-DEEP-b164 | 38 | `packages/ui/src/components/workflow-timeline/WorkflowCompletionCard.tsx` | `aac47556` | +38/-0 | 未提交 | — |
| ZC-DEEP-b164 | 36 | `packages/ui/src/hooks/useCodingPlanEntryPlanList.ts` | `872ad960` | +36/-0 | 未提交 | — |
| ZC-DEEP-b165 | 36 | `packages/desktop/scripts/gen-ui-fixture/style-checks.ts` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b165 | 36 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-main.ts` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b165 | 36 | `packages/desktop/scripts/mcp-apps-host-fixture/storage-checks.ts` | `aac47556` | +36/-0 | 未提交 | — |
| ZC-DEEP-b165 | 38 | `packages/desktop/src/host/sourceServerReleaseResolver.ts` | `e6ff6fab` | +38/-0 | 未提交 | — |
| ZC-DEEP-b166 | 37 | `packages/ui/src/project-sidebar/useTaskGroups.ts` | `0a1fc56d` | +37/-0 | 未提交 | — |
| ZC-DEEP-b166 | 37 | `packages/ui/src/root/useAccountConnectionLossNotification.ts` | `872ad960` | +37/-0 | 未提交 | — |
| ZC-DEEP-b166 | 37 | `packages/ui/src/settings/workspaceHookReviewCommands.ts` | `aac47556` | +37/-0 | 未提交 | — |
| ZC-DEEP-b166 | 36 | `packages/ui/src/WorkspaceSidebar/RemoteProjectConnectionDetails.tsx` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b167 | 37 | `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` | `872ad960` | +37/-0 | 未提交 | — |
| ZC-DEEP-b167 | 38 | `apps/zcode-cli/packages/tui/src/app-file-mentions.ts` | `a7af675d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b167 | 41 | `packages/desktop/src/main/desktopCuaPermissionIpc.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b167 | 36 | `packages/stream-animate/src/server/frameForecast.ts` | `aac47556` | +36/-0 | 未提交 | — |
| ZC-DEEP-b168 | 37 | `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-base.ts` | `522e851e` | +37/-0 | 未提交 | — |
| ZC-DEEP-b168 | 45 | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` | `522e851e` | +45/-0 | 未提交 | — |
| ZC-DEEP-b168 | 37 | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts` | `522e851e` | +37/-0 | 未提交 | — |
| ZC-DEEP-b168 | 36 | `apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts` | `0f2ef80d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b169 | 36 | `packages/ui/src/index.ts` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b169 | 48 | `packages/ui/src/browser-use/BrowserViewportSurface.tsx` | `0a1fc56d` | +28/-0 | 部分未提交 | 差 20 行 |
| ZC-DEEP-b169 | 35 | `packages/ui/src/components/ai-elements/tool.tsx` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b169 | 35 | `packages/ui/src/components/ai-elements/transcription.tsx` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b170 | 35 | `packages/ui/src/feedback/feedbackSubmitSubmission.ts` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b170 | 36 | `packages/ui/src/hooks/usePluginReferenceCatalog.ts` | `aac47556` | +36/-0 | 未提交 | — |
| ZC-DEEP-b170 | 36 | `packages/ui/src/lib/taskSidePaneMemory.ts` | `3c5b2276` | +36/-0 | 未提交 | — |
| ZC-DEEP-b170 | 35 | `packages/ui/src/lib/zcodeTimelineIdentity.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b171 | 35 | `packages/ui/src/settings/model-provider-section/CodingPlanStatusActions.tsx` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b171 | 35 | `packages/ui/src/settings/model-provider-section/useProviderModelDraft.ts` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b171 | 36 | `packages/ui/src/settings/SettingsHeaderBreadcrumb.tsx` | `872ad960` | +36/-0 | 未提交 | — |
| ZC-DEEP-b171 | 36 | `packages/ui/src/root/accountConnectionLossSuggestion.ts` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b172 | 38 | `apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts` | `783d49a6` | +38/-0 | 未提交 | — |
| ZC-DEEP-b172 | 37 | `apps/zcode-cli/packages/core/src/runtime/methods/goal-summary-title.ts` | `55fedda3` | +37/-0 | 未提交 | — |
| ZC-DEEP-b172 | 36 | `apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoint-persistence.ts` | `55fedda3` | +36/-0 | 未提交 | — |
| ZC-DEEP-b172 | 36 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts` | `54f51bad` | +36/-0 | 未提交 | — |
| ZC-DEEP-b173 | 36 | `packages/zcode-server-cli/src/runtime/paths.ts` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b173 | 36 | `apps/zcode-cli/packages/adapters/src/exec/execution-command.ts` | `522e851e` | +36/-0 | 未提交 | — |
| ZC-DEEP-b173 | 36 | `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts` | `522e851e` | +36/-0 | 未提交 | — |
| ZC-DEEP-b173 | 35 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-state.ts` | `54f51bad` | +35/-0 | 未提交 | — |
| ZC-DEEP-b174 | 38 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/handlers.ts` | `0f2ef80d` | +38/-0 | 未提交 | — |
| ZC-DEEP-b174 | 35 | `apps/zcode-cli/packages/core/src/mcp/app-tools.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b174 | 35 | `apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-nodes.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b174 | 37 | `apps/zcode-cli/packages/office-runtime/src/adapters/parse/docx.ts` | `a7af675d` | +37/-0 | 未提交 | — |
| ZC-DEEP-b175 | 34 | `packages/ui/src/lib/sidebarCodingPlanUpgrade.ts` | `aac47556` | +34/-0 | 未提交 | — |
| ZC-DEEP-b175 | 35 | `packages/ui/src/lib/taskNavigationHistory.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b175 | 35 | `packages/ui/src/settings/memoryUpdatedAt.ts` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b175 | 34 | `packages/ui/src/hooks/useBotBoundGroups.ts` | `aac47556` | +34/-0 | 未提交 | — |
| ZC-DEEP-b176 | 35 | `packages/ui/src/ModelTrajectorySearchHighlight.ts` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b176 | 35 | `packages/ui/src/store/mcpStoreMigration.ts` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b176 | 35 | `packages/shared/src/browser-use/command-metadata.ts` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b176 | 34 | `packages/rpc/src/network-telemetry-middleware.ts` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b177 | 35 | `docs/knip/docs/scripts/get-monthly-sponsorships-opencollective.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b177 | 35 | `packages/ui/src/settings/offPeakUiPresentation.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b177 | 34 | `packages/ui/src/v4/ackActivationBarrier.ts` | `aac47556` | +34/-0 | 未提交 | — |
| ZC-DEEP-b177 | 35 | `packages/ui/src/store/workspaceHookReviewStore.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b178 | 35 | `packages/ui/src/ToolCallBlocks/renderers/execute-group.tsx` | `0a1fc56d` | +35/-0 | 未提交 | — |
| ZC-DEEP-b178 | 34 | `packages/ui/src/ToolCallBlocks/renderers/fallback.tsx` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b178 | 36 | `packages/ui/src/ToolCallBlocks/renderers/get-workflow-run-roster.tsx` | `872ad960` | +36/-0 | 未提交 | — |
| ZC-DEEP-b178 | 35 | `packages/ui/src/app-shell/WorkflowRunPhasePills.tsx` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b179 | 35 | `packages/ui/src/quickpick/QuickPickCommandDialog.tsx` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b179 | 34 | `packages/ui/src/components/ui/context-menu.tsx` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b179 | 34 | `packages/ui/src/components/ui/pptx-selection-action-bar.tsx` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b179 | 34 | `packages/ui/src/slashCommandPanelSections.tsx` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b180 | 34 | `packages/ui/src/conversation-share-interaction/conversationSharePreflightResponse.ts` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b180 | 34 | `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialogActions.tsx` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b180 | 34 | `packages/ui/src/SSHDialog.tsx` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b180 | 35 | `packages/ui/src/v4/ConversationWorkflowCompletion.tsx` | `0a1fc56d` | +35/-0 | 未提交 | — |
| ZC-DEEP-b181 | 34 | `packages/ui/src/v4/MarkdownSelectionTooltip.tsx` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b181 | 34 | `packages/ui/src/workspace-file-tree/useWorkspaceFileTreeWatchers.ts` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b181 | 36 | `packages/ui/src/WorkspaceSidebar/WorkspacePurposeSection.tsx` | `0a1fc56d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b181 | 34 | `packages/web-share/src/main.tsx` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b182 | 35 | `packages/desktop/src/main/desktopWebRemoteControlIpc.ts` | `35f676c6` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b182 | 34 | `packages/desktop/src/main/desktopMainIpcHelpers.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b182 | 33 | `packages/desktop/src/main/browserView/browserScreenshotSurfaceContracts.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b182 | 36 | `packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b183 | 33 | `packages/ui/src/BotsDialog/BoundGroupsCard.tsx` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b183 | 33 | `packages/ui/src/conversation-workspace-target/usePluginCreator.ts` | `0a1fc56d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b183 | 33 | `packages/ui/src/feedback/FeedbackCenter.tsx` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b183 | 32 | `packages/ui/src/mentions/providers/pluginsMentionProvider.ts` | `aac47556` | +32/-0 | 未提交 | — |
| ZC-DEEP-b184 | 35 | `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts` | `0f2ef80d` | +35/-0 | 未提交 | — |
| ZC-DEEP-b184 | 36 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appTools.ts` | `0f2ef80d` | +36/-0 | 未提交 | — |
| ZC-DEEP-b184 | 34 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts` | `0f2ef80d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b184 | 34 | `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts` | `522e851e` | +34/-0 | 未提交 | — |
| ZC-DEEP-b185 | 33 | `packages/ui/src/onboarding/onboardingMeshRenderer.ts` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b185 | 33 | `packages/ui/src/project-sidebar/useProjectTaskNavigation.ts` | `0a1fc56d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b185 | 33 | `packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b185 | 33 | `packages/ui/src/v4/pendingInteractionAdapter.ts` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b186 | 33 | `packages/ui/src/v4/composer/ConversationBackgroundWorkTrigger.tsx` | `0a1fc56d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b186 | 34 | `packages/ui/src/v4/composer/ConversationSelectionReferenceChip.tsx` | `aac47556` | +34/-0 | 未提交 | — |
| ZC-DEEP-b186 | 34 | `packages/ui/src/v4/composer/useDraftModelReadinessGate.ts` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b186 | 35 | `packages/ui/src/ToolCallBlocks/renderers/save-workflow.tsx` | `872ad960` | +35/-0 | 未提交 | — |
| ZC-DEEP-b187 | 35 | `packages/stream-animate/src/client/RunForm.tsx` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b187 | 34 | `apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx` | `a7af675d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b187 | 35 | `packages/desktop/src/host/remotePromptAttachments.ts` | `e6ff6fab` | +35/-0 | 未提交 | — |
| ZC-DEEP-b187 | 34 | `packages/desktop/src/main/localMediaPreviewProtocol.ts` | `4702929e` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b188 | 34 | `packages/desktop/vite.config.ts` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b188 | 33 | `packages/provider-node/src/zcode-builtin-download.ts` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b188 | 33 | `packages/shared/src/model-config.ts` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b188 | 34 | `packages/shared/src/zcode-protocol-v4/wire.ts` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b189 | 34 | `packages/ui/src/v4/workspaceConnectionRegistry.ts` | `aac47556` | +34/-0 | 未提交 | — |
| ZC-DEEP-b189 | 33 | `packages/web/src/share/mockConversationSharePreviewClient.ts` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b189 | 33 | `packages/zcode-server-cli/src/ipc/controlServer.ts` | `0a1fc56d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b189 | 33 | `packages/zcode-server-cli/src/runtime/immutableRelease.ts` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b190 | 34 | `packages/zcode-server-cli/src/runtime/releaseManager.ts` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b190 | 33 | `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-meta.ts` | `0f2ef80d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b190 | 32 | `apps/zcode-cli/packages/cli/src/command-center/handlers/expert.ts` | `3ead6c6a` | +32/-0 | 未提交 | — |
| ZC-DEEP-b190 | 34 | `apps/zcode-cli/packages/debug/server/observation-events.ts` | `3ead6c6a` | +34/-0 | 未提交 | — |
| ZC-DEEP-b191 | 32 | `packages/desktop/src/main/appTelemetryRuntime.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b191 | 32 | `packages/desktop/src/main/desktopMcpTelemetry.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b191 | 32 | `packages/desktop/src/main/desktopNotifications.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b191 | 33 | `packages/desktop/src/main/pluginSandbox/permissionGate.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b192 | 32 | `packages/desktop/src/main/resourceManagerNetwork.ts` | `a17e1a6e` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b192 | 33 | `packages/server/src/source-server/sourceServerProbe.ts` | `3c5b2276` | +33/-0 | 未提交 | — |
| ZC-DEEP-b192 | 32 | `packages/shared/src/background-task-notifications.ts` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b192 | 32 | `packages/shared/src/mcp-apps/sampling.ts` | `aac47556` | +32/-0 | 未提交 | — |
| ZC-DEEP-b193 | 34 | `packages/shared/src/runtimeEnv.ts` | `872ad960` | +34/-0 | 未提交 | — |
| ZC-DEEP-b193 | 32 | `packages/shared/src/source-server/compatibility.ts` | `0a1fc56d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b193 | 34 | `packages/ui/src/app-shell/AnimatedTerminalPanel.tsx` | `0a1fc56d` | +34/-0 | 未提交 | — |
| ZC-DEEP-b193 | 32 | `packages/ui/src/browser-use/HumanBrowserView.tsx` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b194 | 32 | `packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.tsx` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b194 | 32 | `packages/ui/src/git-action-menu/currentSessionFileScope.ts` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b194 | 32 | `packages/ui/src/lib/remotePluginSyncRefresh.ts` | `0a1fc56d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b194 | 32 | `packages/ui/src/lib/taskMainActivity.ts` | `aac47556` | +32/-0 | 未提交 | — |
| ZC-DEEP-b195 | 32 | `packages/ui/src/mentions/nodes/mentionIconDom.ts` | `aac47556` | +32/-0 | 未提交 | — |
| ZC-DEEP-b195 | 32 | `packages/ui/src/onboarding/useOnboardingTelemetry.ts` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b195 | 33 | `packages/ui/src/remote-connection-flow/contract.ts` | `0a1fc56d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b195 | 33 | `packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b196 | 33 | `packages/ui/src/TaskRenameDialog.tsx` | `872ad960` | +33/-0 | 未提交 | — |
| ZC-DEEP-b196 | 32 | `packages/ui/src/v4/composer/PptxElementReferenceChip.tsx` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b196 | 33 | `packages/ui/src/v4/ConversationWorkflowDigests.tsx` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b196 | 32 | `packages/web/src/web-remote-control/adapters/payloadRequester.ts` | `0a1fc56d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b197 | 32 | `packages/web/src/web-remote-control/adapters/relayMessage.ts` | `0a1fc56d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b197 | 32 | `packages/zcode-server-cli/src/server-core/taskActivityTracker.ts` | `0a1fc56d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b197 | 33 | `apps/dev-docs/vite.config.ts` | `55f48e6d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b197 | 33 | `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` | `0f2ef80d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b198 | 35 | `apps/zcode-cli/packages/debug/server/sources.ts` | `3ead6c6a` | +35/-0 | 未提交 | — |
| ZC-DEEP-b198 | 35 | `apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-runs.ts` | `aac47556` | +35/-0 | 未提交 | — |
| ZC-DEEP-b198 | 31 | `docs/knip/docs/astro.config.ts` | `aac47556` | +31/-0 | 未提交 | — |
| ZC-DEEP-b198 | 31 | `packages/client/src/websocket.ts` | `0a1fc56d` | +31/-0 | 未提交 | — |
| ZC-DEEP-b199 | 31 | `packages/desktop/src/main/databaseStartupRelay.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b199 | 31 | `packages/desktop/src/main/pluginSandbox/session.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b199 | 31 | `packages/provider/src/config/provider-data-schema.ts` | `aac47556` | +31/-0 | 未提交 | — |
| ZC-DEEP-b199 | 35 | `packages/shared/src/conversation-share.ts` | `0a1fc56d` | +35/-0 | 未提交 | — |
| ZC-DEEP-b200 | 31 | `packages/shared/src/forceUpdate.ts` | `872ad960` | +31/-0 | 未提交 | — |
| ZC-DEEP-b200 | 31 | `packages/shared/src/sqlite-migrations/runner.ts` | `0a1fc56d` | +31/-0 | 未提交 | — |
| ZC-DEEP-b200 | 32 | `packages/shared/src/subagents-types.ts` | `aac47556` | +32/-0 | 未提交 | — |
| ZC-DEEP-b200 | 31 | `packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactBoard.tsx` | `872ad960` | +31/-0 | 未提交 | — |
| ZC-DEEP-b201 | 31 | `packages/ui/src/components/marketing-touch/marketingPopupAdapter.ts` | `aac47556` | +31/-0 | 未提交 | — |
| ZC-DEEP-b201 | 31 | `packages/ui/src/git-branch-switcher/switchAssist.ts` | `872ad960` | +31/-0 | 未提交 | — |
| ZC-DEEP-b201 | 32 | `packages/ui/src/hooks/useOAuth.ts` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b201 | 31 | `packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts` | `0a1fc56d` | +31/-0 | 未提交 | — |
| ZC-DEEP-b202 | 33 | `packages/ui/src/lib/providerBusinessError.ts` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b202 | 31 | `packages/ui/src/lib/slashCommands.ts` | `aac47556` | +31/-0 | 未提交 | — |
| ZC-DEEP-b202 | 31 | `packages/ui/src/previewPaneCodeContent.tsx` | `872ad960` | +29/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b202 | 31 | `packages/ui/src/settings/model-provider-section/ModelConfigHelp.tsx` | `aac47556` | +28/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b203 | 31 | `packages/ui/src/settings/model-provider-section/ProviderModelModalityOptions.tsx` | `872ad960` | +31/-0 | 未提交 | — |
| ZC-DEEP-b203 | 33 | `packages/ui/src/settings/saved-workflows/savedWorkflowArgsForm.ts` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b203 | 32 | `packages/ui/src/ToolCallBlocks/renderers/resolve-workflow-question.tsx` | `872ad960` | +32/-0 | 未提交 | — |
| ZC-DEEP-b203 | 31 | `packages/ui/src/v4/agentConversationTransportWorkflowRuns.ts` | `872ad960` | +31/-0 | 未提交 | — |
| ZC-DEEP-b204 | 33 | `packages/ui/src/v4/composer/toolbarShortcuts.ts` | `aac47556` | +33/-0 | 未提交 | — |
| ZC-DEEP-b204 | 30 | `packages/web/src/web-remote-control/contracts/transport.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b204 | 34 | `apps/zcode-cli/packages/adapters/src/model/runner-status.ts` | `522e851e` | +34/-0 | 未提交 | — |
| ZC-DEEP-b204 | 32 | `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-trust.ts` | `0f2ef80d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b205 | 30 | `apps/zcode-cli/packages/cli/src/plugins-command-shared.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b205 | 31 | `apps/zcode-cli/packages/core/src/runtime/methods/browser-turn-screenshot.ts` | `55fedda3` | +31/-0 | 未提交 | — |
| ZC-DEEP-b205 | 31 | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts` | `54f51bad` | +31/-0 | 未提交 | — |
| ZC-DEEP-b205 | 32 | `apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts` | `a7af675d` | +32/-0 | 未提交 | — |
| ZC-DEEP-b206 | 33 | `apps/zcode-cli/packages/tui/src/app-selection-keyboard.ts` | `a7af675d` | +33/-0 | 未提交 | — |
| ZC-DEEP-b206 | 30 | `packages/desktop/src/main/browserView/browserVirtualClipboardPageScript.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b206 | 30 | `packages/desktop/src/main/desktopLinuxAppImageIcon.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b206 | 30 | `packages/desktop/src/main/windowsAumidIcon.ts` | `6a8cc6c9` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b207 | 30 | `packages/shared/src/node/privateFilePersistence.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b207 | 30 | `packages/shared/src/plan-identity.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b207 | 30 | `packages/shared/src/remoteSshHostKey.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b207 | 30 | `packages/shared/src/session-debug.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b208 | 31 | `packages/shared/src/zcode-api-retry-status.ts` | `872ad960` | +31/-0 | 未提交 | — |
| ZC-DEEP-b208 | 30 | `packages/ui/src/app-shell/PlanDetailSidePane.tsx` | `872ad960` | +29/-0 | 部分未提交 | 差 1 行 |
| ZC-DEEP-b208 | 30 | `packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx` | `872ad960` | +26/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b208 | 30 | `packages/ui/src/components/ai-elements/conversation.tsx` | `872ad960` | +28/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b209 | 30 | `packages/ui/src/components/marketing-touch/MarketingDialogs.tsx` | `aac47556` | +28/-0 | 部分未提交 | 差 2 行 |
| ZC-DEEP-b209 | 30 | `packages/ui/src/gen-ui/app/tweaks.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b209 | 30 | `packages/ui/src/git-action-menu/commitConversationContext.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b209 | 30 | `packages/ui/src/mentions/providers/subagentsMentionProvider.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b210 | 30 | `packages/ui/src/ModelTrajectorySearchBar.tsx` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b210 | 30 | `packages/ui/src/openWorkspacePageThemeHero.tsx` | `872ad960` | +29/-0 | 部分未提交 | 差 1 行 |
| ZC-DEEP-b210 | 30 | `packages/ui/src/project-sidebar/remote-project-connection.ts` | `3c5b2276` | +30/-0 | 未提交 | — |
| ZC-DEEP-b210 | 30 | `packages/ui/src/project-sidebar/RemoteProjectMenu.tsx` | `0a1fc56d` | +24/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b211 | 30 | `packages/ui/src/remote-connection-flow/requestRemoteProjectConnection.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b211 | 30 | `packages/ui/src/remote-connection/RemoteConnectionTags.tsx` | `0a1fc56d` | +29/-0 | 部分未提交 | 差 1 行 |
| ZC-DEEP-b211 | 31 | `packages/ui/src/remote/remoteWorkspaceController.ts` | `0a1fc56d` | +31/-0 | 未提交 | — |
| ZC-DEEP-b211 | 31 | `packages/ui/src/root/useReconnectingRemoteWorkspaceLogs.ts` | `0a1fc56d` | +31/-0 | 未提交 | — |
| ZC-DEEP-b212 | 30 | `packages/ui/src/resource-manager/storage/StorageCategoryList.tsx` | `0a1fc56d` | +26/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b212 | 30 | `packages/ui/src/resource-manager/storage/useStorageUsage.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b212 | 30 | `packages/ui/src/settings/automationAgentConfigOptions.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b212 | 30 | `packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b213 | 30 | `packages/ui/src/settings/saved-workflows/SavedWorkflowDetailHeader.tsx` | `0a1fc56d` | +24/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b213 | 30 | `packages/ui/src/side-pane-full-view/model.ts` | `3c5b2276` | +30/-0 | 未提交 | — |
| ZC-DEEP-b213 | 30 | `packages/ui/src/ToolCallBlocks/renderers/submit-result.tsx` | `872ad960` | +29/-0 | 部分未提交 | 差 1 行 |
| ZC-DEEP-b213 | 30 | `packages/ui/src/updateStatusModel.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b214 | 30 | `packages/ui/src/v4/composer/modelTriggerDisplay.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b214 | 30 | `packages/ui/src/v4/index.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b214 | 30 | `packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b214 | 30 | `packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b215 | 30 | `packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx` | `872ad960` | +29/-0 | 部分未提交 | 差 1 行 |
| ZC-DEEP-b215 | 30 | `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts` | `26a74c66` | +30/-0 | 未提交 | — |
| ZC-DEEP-b215 | 30 | `docs/knip/docs/scripts/get-monthly-sponsorships-github.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b215 | 30 | `packages/desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b216 | 30 | `packages/shared/src/zcode-protocol-v4/apply.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b216 | 30 | `packages/shared/src/zcode-protocol-v4/rows.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b216 | 30 | `packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b216 | 30 | `packages/ui/src/command-center/commandCenterSearchHistory.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b217 | 30 | `packages/ui/src/components/workflow-timeline/timeline-model.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b217 | 30 | `packages/ui/src/feedback/FeedbackProcessView.tsx` | `aac47556` | +24/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b217 | 30 | `packages/ui/src/highspeed/highspeedOutputFooter.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b217 | 30 | `packages/ui/src/hooks/useProviderSettingsView.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b218 | 30 | `packages/ui/src/lib/mcpStatusProbe.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b218 | 30 | `packages/ui/src/onboarding/OnboardingAgentsFileStep.tsx` | `872ad960` | +24/-0 | 部分未提交 | 差 6 行 |
| ZC-DEEP-b218 | 30 | `packages/ui/src/plugin-ui/domain/pluginUiToolFeed.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b218 | 30 | `packages/ui/src/project-sidebar/useProjectTaskActions.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b219 | 30 | `packages/ui/src/root/botsTaskBroadcast.ts` | `29628c9a` | +30/-0 | 未提交 | — |
| ZC-DEEP-b219 | 30 | `packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b219 | 30 | `packages/ui/src/settings/model-provider-section/ProviderModelDraftState.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b219 | 30 | `packages/ui/src/settings/model-provider-section/SectionLayout.tsx` | `0a1fc56d` | +26/-0 | 部分未提交 | 差 4 行 |
| ZC-DEEP-b220 | 30 | `packages/ui/src/settings/useShortcutRecording.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b220 | 30 | `packages/ui/src/slashCommandHelpers.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b220 | 30 | `packages/ui/src/TaskListItemContextMenu.tsx` | `3c5b2276` | +27/-0 | 部分未提交 | 差 3 行 |
| ZC-DEEP-b220 | 30 | `packages/ui/src/ToolCallBlocks/ToolPresentation.tsx` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b221 | 30 | `packages/ui/src/v4/ConversationTurnRow.tsx` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b221 | 30 | `packages/ui/src/v4/workbenchLayout.ts` | `3c5b2276` | +30/-0 | 未提交 | — |
| ZC-DEEP-b221 | 30 | `packages/ui/src/v4/WorkflowNotificationHoleRow.tsx` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b221 | 30 | `packages/web/src/web-remote-control/adapters/webRemoteControlDeviceInfo.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b222 | 30 | `packages/zcode-server-cli/src/packaging/stageArchives.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b222 | 30 | `apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts` | `522e851e` | +30/-0 | 未提交 | — |
| ZC-DEEP-b222 | 30 | `apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts` | `0f2ef80d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b222 | 30 | `apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts` | `0f2ef80d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b223 | 30 | `apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts` | `3ead6c6a` | +30/-0 | 未提交 | — |
| ZC-DEEP-b223 | 30 | `apps/zcode-cli/packages/core/src/runtime/helpers/attachment-media-resolver.ts` | `ad6dc0eb` | +30/-0 | 未提交 | — |
| ZC-DEEP-b223 | 30 | `apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts` | `c788b9f1` | +30/-0 | 未提交 | — |
| ZC-DEEP-b223 | 30 | `apps/zcode-cli/packages/core/src/session-context/topic-archive.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b224 | 30 | `packages/desktop/src/main/appARMSBootstrap.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b224 | 30 | `packages/desktop/src/main/browserView/browserCommandExecutor.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b224 | 30 | `packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b224 | 30 | `packages/desktop/src/main/startupWorkspace.ts` | `b34d5ba5` | +0/-0 | 已提交且干净 | — |
| ZC-DEEP-b225 | 30 | `packages/desktop/src/renderer/src/plugin-sandbox/relay.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b225 | 30 | `packages/model-option-map/src/merge-patch.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b225 | 30 | `packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b225 | 30 | `packages/shared/src/source-server/connectionErrors.ts` | `0a1fc56d` | +30/-0 | 未提交 | — |
| ZC-DEEP-b226 | 30 | `packages/desktop/scripts/gen-ui-fixture/file-summary.tsx` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b226 | 30 | `packages/stream-animate/src/server/dataStore.ts` | `aac47556` | +30/-0 | 未提交 | — |
| ZC-DEEP-b226 | 30 | `packages/ui/src/components/ai-elements/prompt-input-actions.tsx` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b226 | 30 | `packages/ui/src/components/ai-elements/snippet.tsx` | `872ad960` | +30/-0 | 未提交 | — |
| ZC-DEEP-b228 | 0 | `` | `—` | +0/-0 | 台账解析失败 | no-table |

## 4. 反向核对：提交 → 台账（2026-11-10）

### 4.1 先修正上一轮的两个说法

上一轮报告里写「436 个文件从未进过任何台账」。**这句是错的**，错在工具的范围，不在数据：
`audit-ledgers2.mjs` 只 glob 了 `ZC-DEEP-b*.md`（228 份），把其余台账族整个排除在外——
`ZC-DEEP-svc-*`（46 份，services 线）、`L1-*.md` / `L2-*.md`（core/CLI 线的分量台账）、
`ZC-DEEP-SERVICES-PLAN.md` 与 `coverage-audit.md` 等横切文档，一份都没进解析。

按精确路径重查这 436 个文件：

| 命中方式 | 文件数 | 含义 |
| --- | ---: | --- |
| 某份台账里出现完整路径 | 154 | 有台账记录，可直接对账 |
| 只命中 basename | 282 | 台账用「第 16~30 个文件」这类序号区间表述范围，路径无法直接匹配 |
| 任何文档都找不到 | 0 | — |

所以真实结论是：**这 436 个文件全部落在另外两条线的台账范围内，不是无台账的孤儿**；
§1–§3 的 1,411 条登记只是 b 族的分母，不能当全仓分母用。
这一条同时说明：审计工具本身有口径缺陷，比任何单个批次的漏提交更值得先记下来。

### 4.2 质量扫描（v3 整文件口径）

命令：

```text
node _annot_baseline/deep-quality.mjs d:\code\ZCode \
  --file-list _annot_baseline/snapshot/_not-in-ledger.txt \
  --metric-version v3 --field-mode ast --json q436-whole.json
```

原始 SUMMARY：

```text
SUMMARY metric=v3 files=436 units=65601 coverage=26.6% branch=38.3% field=11.0% comments=40170 substance=90.2% explain=99.1% filler=0.0% weak=1.0%
MAP comments=40170 mappedStrict=17428 mappedBlock=34379 unmapped=5791 reasons=import:2651,structural:208,continuation:2791,gap:0,eof:1,other:140
```

对照：同为整文件口径的主线 1,726 文件（同一次运行，同一版本同一参数）。

| 指标 | 436 文件（另两条线） | 主线 1,726 文件 | 判定 |
| --- | ---: | ---: | --- |
| 注释行 | 40,170 | 187,759 | — |
| weak 行数（分子） | **410** | **8,162** | 436 组的 weak 分子约为主线 1/20 |
| weak 率 | 1.0% | 4.3% | 低 3.3 个百分点 |
| filler 行数（分子） | **3** | **5,272** | 436 组几乎无注水 |
| filler 率 | 0.0% | 2.8% | 低 2.8 个百分点 |
| substance | 90.2% | 85.9% | 高 4.3 个百分点 |
| explain | 99.1% | 97.4% | 高 1.7 个百分点 |

**判定：质量扫描通过**（weak 分子 410 行，与主线同量级且更小；substance 90.2% ≥ 90%）。

两点必须一起记住，否则这个「通过」会被读大：

1. **这是整文件口径，不是 diff 口径。** 文件里包含上游原有注释，所以指标是「文件现状」，
   不是「这批人写了多少水句」。两组用同一口径，横向可比；但对单文件下结论时不成立。
2. **weak 只看分子不看百分比。** 1.0% 是 410 行，不是 0——按 4 万注释行算，把 1.0% 读成「零」
   会漏掉 410 处补深缺口。同理 0.0% 的 filler 实际是 3 行，也不是 0。

单文件层面：weak > 0 的有 128 个文件（最多 `botsService.ts` 28 行、`offPeakTaskService.ts` 27 行、
`offPeakMockGateway.ts` 24 行）；substance < 90% 的有 175 个（主线同口径 1,048 个）。
聚合通过不等于逐文件通过，逐文件清单见 4.4。

### 4.3 归属

| 归属 | 文件数 | 依据 |
| --- | ---: | --- |
| services 线 | 429 | `ZC-DEEP-SERVICES-PLAN.md` 明写范围为 `packages/services/src/**`（467 个受测文件） |
| core/CLI 线 | 6 | `L2-B2/B3/B4/B5` 与 `ZC-DEEP-b32/b40/b48/b59` 有同名条目 |
| desktop/scripts | 1 | `packages/desktop/scripts/mcp-apps-host-fixture/model.ts`，无台账条目 |

**只登记归属，不改别人的东西。** 这 436 个文件的注释内容、密度、门禁记录都不由本线维护；
本条只回答「它们是谁的」，以及「它们也用 v3 口径量过一次，结果在哪」。

### 4.4 逐文件清单（436 行）

列：新增行来自快照提交 `a8784b7e` 的 numstat；weak/filler/substance/explain 为 v3 整文件口径；
「台账精确命中」列出按完整路径匹配到的文档，`—` 表示只能按 basename 命中或未命中。

| 文件 | 新增行 | weak 行 | filler 行 | substance | explain | 归属 | 台账精确命中 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `apps/zcode-cli/packages/contracts/src/tools/bash.ts` | 21 | 0 | 0 | 50.0% | 100.0% | core/CLI 线 | — |
| `apps/zcode-cli/packages/contracts/src/tools/edit.ts` | 9 | 0 | 0 | 52.2% | 100.0% | core/CLI 线 | — |
| `apps/zcode-cli/packages/contracts/src/tools/read.ts` | 19 | 15 | 0 | 78.1% | 93.7% | core/CLI 线 | — |
| `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` | 86 | 1 | 0 | 78.5% | 99.6% | core/CLI 线 | — |
| `apps/zcode-cli/packages/core/src/runtime/helpers/steering.ts` | 116 | 1 | 0 | 80.1% | 99.5% | core/CLI 线 | — |
| `apps/zcode-cli/packages/core/src/tool/handlers/read.ts` | 83 | 3 | 0 | 78.8% | 98.8% | core/CLI 线 | excluded-41-audit.md |
| `packages/desktop/scripts/mcp-apps-host-fixture/model.ts` | 52 | 2 | 0 | 60.4% | 96.2% | desktop/scripts | ZC-DEEP-b91.md |
| `packages/services/src/accessor.ts` | 22 | 0 | 0 | 88.6% | 100.0% | services 线 | — |
| `packages/services/src/bigmodel/codingPlanEntitlement.ts` | 34 | 1 | 0 | 89.7% | 97.4% | services 线 | — |
| `packages/services/src/bigmodel/teamPlanApiKey.ts` | 54 | 0 | 0 | 98.2% | 100.0% | services 线 | — |
| `packages/services/src/bot-project-runtime/contract.example.ts` | 2 | 0 | 0 | 50.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bot-project-runtime/contract.ts` | 9 | 0 | 0 | 90.9% | 100.0% | services 线 | — |
| `packages/services/src/bot-project-runtime/index.ts` | 53 | 0 | 0 | 92.6% | 100.0% | services 线 | — |
| `packages/services/src/bots/botConfigHelpers.ts` | 33 | 0 | 0 | 83.3% | 100.0% | services 线 | — |
| `packages/services/src/bots/bots.ts` | 54 | 1 | 0 | 80.3% | 98.4% | services 线 | — |
| `packages/services/src/bots/botsService.ts` | 3404 | 28 | 0 | 91.4% | 99.3% | services 线 | ZC-DEEP-svc-b1.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/bots/channelMentionResolver.ts` | 32 | 1 | 0 | 94.4% | 97.2% | services 线 | — |
| `packages/services/src/bots/channelReply.ts` | 67 | 3 | 0 | 76.7% | 95.9% | services 线 | — |
| `packages/services/src/bots/channelRuntime.ts` | 71 | 2 | 0 | 85.4% | 97.6% | services 线 | — |
| `packages/services/src/bots/commandOrder.ts` | 8 | 0 | 0 | 87.5% | 100.0% | services 线 | — |
| `packages/services/src/bots/commandParser.ts` | 36 | 5 | 0 | 58.3% | 86.1% | services 线 | — |
| `packages/services/src/bots/config.ts` | 35 | 0 | 0 | 97.4% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/feishuChannelRuntime.ts` | 87 | 3 | 0 | 85.7% | 96.9% | services 线 | — |
| `packages/services/src/bots/groupAdminAttention.ts` | 17 | 1 | 0 | 65.0% | 95.0% | services 线 | — |
| `packages/services/src/bots/groupDeliveryThrottle.ts` | 13 | 0 | 0 | 93.3% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/groupQueueCard.ts` | 18 | 0 | 0 | 94.7% | 100.0% | services 线 | — |
| `packages/services/src/bots/groupReply.ts` | 7 | 0 | 0 | 87.5% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/groupResultDelivery.ts` | 27 | 2 | 0 | 96.8% | 93.5% | services 线 | — |
| `packages/services/src/bots/groupSessions.ts` | 10 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/bots/messages.ts` | 85 | 1 | 0 | 79.1% | 98.8% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/modelSelectionHelpers.ts` | 7 | 0 | 0 | 71.4% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/providers/feishuAppRegistration.ts` | 93 | 0 | 0 | 94.8% | 100.0% | services 线 | ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/feishuGroupMessages.ts` | 76 | 1 | 0 | 91.7% | 98.8% | services 线 | ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/feishuProvider.ts` | 963 | 7 | 0 | 91.6% | 99.3% | services 线 | ZC-DEEP-svc-b3.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/bots/providers/groupInputReaction.ts` | 37 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/groupMemberDirectory.ts` | 35 | 0 | 0 | 97.2% | 100.0% | services 线 | ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/providerRequest.ts` | 42 | 0 | 0 | 96.0% | 100.0% | services 线 | ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/telegramProvider.ts` | 173 | 0 | 0 | 94.0% | 100.0% | services 线 | ZC-DEEP-svc-b3.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/bots/providers/types.ts` | 107 | 0 | 0 | 87.9% | 100.0% | services 线 | ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/webhookProvider.ts` | 147 | 0 | 0 | 96.0% | 100.0% | services 线 | ZC-DEEP-svc-a8.md<br>ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/weixinProvider.ts` | 313 | 0 | 0 | 98.1% | 100.0% | services 线 | ZC-DEEP-svc-a8.md<br>ZC-DEEP-svc-b3.md |
| `packages/services/src/bots/providers/weixinRegistration.ts` | 113 | 0 | 0 | 96.5% | 100.0% | services 线 | ZC-DEEP-svc-b3.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/replyFormatter.ts` | 111 | 13 | 0 | 69.2% | 88.9% | services 线 | — |
| `packages/services/src/bots/repo.ts` | 41 | 0 | 0 | 95.5% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/bots/statusFormatting.ts` | 46 | 3 | 0 | 86.5% | 94.2% | services 线 | — |
| `packages/services/src/bots/storageMigration.ts` | 24 | 0 | 0 | 89.3% | 100.0% | services 线 | — |
| `packages/services/src/bots/taskStreamHub.ts` | 19 | 0 | 0 | 90.0% | 100.0% | services 线 | — |
| `packages/services/src/bots/telegramChannelRuntime.ts` | 100 | 8 | 0 | 82.2% | 93.2% | services 线 | — |
| `packages/services/src/bots/topicContinuation.ts` | 30 | 0 | 0 | 77.1% | 100.0% | services 线 | — |
| `packages/services/src/bots/topicHistory.ts` | 26 | 3 | 0 | 69.7% | 90.9% | services 线 | — |
| `packages/services/src/bots/topicHistoryAttachment.ts` | 21 | 0 | 0 | 90.9% | 100.0% | services 线 | — |
| `packages/services/src/bots/topicPreparationState.ts` | 21 | 0 | 0 | 87.0% | 100.0% | services 线 | — |
| `packages/services/src/bots/topicResource.ts` | 46 | 1 | 0 | 79.2% | 97.9% | services 线 | — |
| `packages/services/src/bots/weixinChannelRuntime.ts` | 92 | 0 | 0 | 97.2% | 100.0% | services 线 | — |
| `packages/services/src/bots/workspaceHelpers.ts` | 37 | 5 | 0 | 59.5% | 86.5% | services 线 | — |
| `packages/services/src/broadcast/broadcastService.ts` | 50 | 0 | 0 | 87.3% | 100.0% | services 线 | — |
| `packages/services/src/client-config/clientConfig.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/client-config/clientConfigService.ts` | 26 | 3 | 0 | 85.7% | 89.3% | services 线 | — |
| `packages/services/src/client-scenes/clientScenes.ts` | 2 | 1 | 0 | 85.7% | 92.9% | services 线 | — |
| `packages/services/src/client-scenes/clientScenesService.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/cloud-content/cloudContent.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/cloud-content/cloudContentService.ts` | 47 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/cloud-content/contentBundleCache.ts` | 98 | 0 | 0 | 99.0% | 100.0% | services 线 | — |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 367 | 4 | 0 | 90.2% | 99.1% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/coding-plan-subscription/codingPlanSubscription.ts` | 31 | 0 | 0 | 86.8% | 100.0% | services 线 | — |
| `packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts` | 8 | 0 | 0 | 80.6% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/collection.ts` | 14 | 0 | 0 | 85.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-DEFECTS.md |
| `packages/services/src/commands/commandFileParser.ts` | 43 | 1 | 0 | 90.7% | 97.7% | services 线 | — |
| `packages/services/src/commands/commands.ts` | 8 | 0 | 0 | 87.5% | 100.0% | services 线 | — |
| `packages/services/src/commands/commandsService.ts` | 240 | 3 | 0 | 83.8% | 98.9% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/conversation-share/conversationShare.ts` | 90 | 2 | 0 | 84.3% | 98.5% | services 线 | — |
| `packages/services/src/conversation-share/conversationShareArtifactDiscovery.ts` | 194 | 5 | 0 | 90.1% | 97.6% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/conversation-share/conversationShareArtifactSource.ts` | 75 | 0 | 0 | 92.3% | 100.0% | services 线 | — |
| `packages/services/src/conversation-share/conversationShareConnectionScope.ts` | 38 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/conversation-share/conversationShareHttpClient.ts` | 129 | 4 | 0 | 92.5% | 97.5% | services 线 | — |
| `packages/services/src/conversation-share/conversationShareInlineImages.ts` | 36 | 1 | 0 | 94.9% | 97.4% | services 线 | — |
| `packages/services/src/conversation-share/conversationShareIntegrity.ts` | 49 | 0 | 0 | 83.3% | 100.0% | services 线 | ZC-DEEP-svc-a8.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/conversation-share/conversationSharePublicProjection.ts` | 215 | 3 | 0 | 88.7% | 98.7% | services 线 | — |
| `packages/services/src/conversation-share/conversationShareService.ts` | 550 | 8 | 0 | 86.6% | 99.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/conversation-share/conversationShareWorkflowSnapshot.ts` | 122 | 2 | 0 | 92.4% | 98.5% | services 线 | — |
| `packages/services/src/conversation-share/sharedContextFormatter.ts` | 34 | 0 | 0 | 86.5% | 100.0% | services 线 | — |
| `packages/services/src/credential/providers/credentialCipherProvider.ts` | 26 | 2 | 0 | 73.3% | 93.3% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/cua-permission-broker/cuaAgentAdmissionGate.ts` | 51 | 0 | 0 | 94.8% | 100.0% | services 线 | ZC-deep-svc-a9.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/cua-permission-broker/cuaHelperInstaller.ts` | 16 | 0 | 0 | 90.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/cua-permission-broker/cuaPipSession.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/cua-permission-broker/cuaPipSessionService.ts` | 20 | 2 | 0 | 84.5% | 97.2% | services 线 | — |
| `packages/services/src/cua-permission-broker/cuaStandaloneStatusLaunch.ts` | 12 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/cua-permission-broker/stableCuaTransport.ts` | 25 | 0 | 0 | 96.0% | 100.0% | services 线 | ZC-deep-svc-a9.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts` | 105 | 0 | 0 | 98.6% | 100.0% | services 线 | — |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts` | 152 | 0 | 0 | 74.5% | 100.0% | services 线 | — |
| `packages/services/src/cua-permission-broker/windowsCuaHelperHostSupport.ts` | 44 | 0 | 0 | 92.1% | 100.0% | services 线 | — |
| `packages/services/src/feedback/compactLogArchive.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/feedback/feedback.ts` | 20 | 0 | 0 | 90.0% | 100.0% | services 线 | — |
| `packages/services/src/feedback/feedbackHttpClient.ts` | 289 | 0 | 0 | 91.9% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/feedback/feedbackLocalTicketStore.ts` | 59 | 0 | 0 | 93.4% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/feedback/feedbackLogArchive.ts` | 84 | 2 | 0 | 87.4% | 97.9% | services 线 | — |
| `packages/services/src/feedback/feedbackService.ts` | 78 | 1 | 0 | 86.9% | 100.0% | services 线 | — |
| `packages/services/src/file/fileService.ts` | 138 | 0 | 0 | 93.4% | 100.0% | services 线 | — |
| `packages/services/src/file/workspaceFileIgnore.ts` | 61 | 0 | 0 | 76.7% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/file/workspaceFileMentionFilter.ts` | 23 | 0 | 0 | 75.0% | 100.0% | services 线 | — |
| `packages/services/src/file/workspaceFileSearch.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/fileWatcher/fileWatcherService.ts` | 29 | 2 | 0 | 82.5% | 95.0% | services 线 | — |
| `packages/services/src/fs/atomicFileUtils.ts` | 32 | 0 | 0 | 95.9% | 100.0% | services 线 | — |
| `packages/services/src/fs/fsFaultInjection.ts` | 93 | 0 | 0 | 93.6% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/adapters/files.ts` | 18 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/adapters/service.ts` | 23 | 0 | 0 | 91.3% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/adapters/stateStorage.ts` | 52 | 0 | 0 | 96.4% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/app/ports.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/contract.example.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/contract.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/index.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/module.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/gen-ui/node.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/git/commitMessageFileScope.ts` | 33 | 0 | 0 | 81.8% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/git/config.ts` | 53 | 0 | 0 | 95.0% | 100.0% | services 线 | ZC-DEEP-svc-a3.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/git/git.ts` | 17 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/git/gitCheckpoint.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/git/gitCheckpointService.ts` | 33 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/git/gitCommitMessageGenerator.ts` | 97 | 1 | 0 | 96.0% | 99.0% | services 线 | — |
| `packages/services/src/git/gitService.ts` | 87 | 0 | 0 | 93.8% | 100.0% | services 线 | — |
| `packages/services/src/git/providers/gitCommandProvider.ts` | 57 | 0 | 0 | 98.4% | 100.0% | services 线 | — |
| `packages/services/src/git/providers/gitEnvironmentProvider.ts` | 15 | 0 | 0 | 88.2% | 100.0% | services 线 | — |
| `packages/services/src/git/repo/gitCheckpointHelpers.ts` | 99 | 0 | 0 | 98.0% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/git/repo/gitCheckpointRepo.ts` | 26 | 0 | 0 | 80.3% | 100.0% | services 线 | — |
| `packages/services/src/git/repo/gitCheckpointStore.ts` | 55 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/git/repo/gitCliHelpers.ts` | 176 | 0 | 0 | 92.6% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/git/repo/gitCliRepo.ts` | 631 | 2 | 0 | 93.2% | 99.9% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/git/repo/gitCliTypes.ts` | 35 | 0 | 0 | 97.1% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/highspeed/highspeedCard.ts` | 6 | 0 | 0 | 83.3% | 100.0% | services 线 | — |
| `packages/services/src/highspeed/highspeedCardService.ts` | 61 | 1 | 0 | 86.3% | 99.2% | services 线 | ZC-deep-svc-a9.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/highspeed/highspeedHttpTransport.ts` | 70 | 0 | 0 | 97.6% | 100.0% | services 线 | — |
| `packages/services/src/highspeed/highspeedMockTransport.ts` | 20 | 2 | 0 | 85.0% | 95.0% | services 线 | — |
| `packages/services/src/hooks/hooksService.ts` | 66 | 0 | 0 | 90.4% | 100.0% | services 线 | — |
| `packages/services/src/hooks/index.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/hooks/workspaceHookConfigMutation.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/hooks/workspaceHookSettingsModel.ts` | 84 | 0 | 0 | 86.9% | 100.0% | services 线 | — |
| `packages/services/src/index.ts` | 66 | 1 | 0 | 98.0% | 99.0% | services 线 | — |
| `packages/services/src/logger/serviceLogger.ts` | 15 | 0 | 0 | 88.9% | 100.0% | services 线 | — |
| `packages/services/src/marketing-touch/marketingAssetRegistry.ts` | 37 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/marketing-touch/marketingTouch.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/marketing-touch/marketingTouchService.ts` | 22 | 2 | 0 | 83.3% | 91.7% | services 线 | — |
| `packages/services/src/mcp-sync/mcpSync.ts` | 8 | 0 | 0 | 84.6% | 100.0% | services 线 | — |
| `packages/services/src/media-preview/mediaPreview.ts` | 27 | 0 | 0 | 88.9% | 100.0% | services 线 | — |
| `packages/services/src/memory/index.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/memory/memoryService.ts` | 86 | 0 | 0 | 86.4% | 100.0% | services 线 | — |
| `packages/services/src/memory/projectMemoryStableRead.ts` | 24 | 1 | 0 | 85.2% | 96.3% | services 线 | — |
| `packages/services/src/model-provider/accountProjectTokenClient.ts` | 15 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/accountProviderApiClient.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/accountProviderApiKeyResolver.ts` | 27 | 0 | 0 | 89.3% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/accountProviderApiTypes.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/accountProviderConnectionResolver.ts` | 55 | 3 | 0 | 85.1% | 97.9% | services 线 | — |
| `packages/services/src/model-provider/accountProviderCredentialKey.ts` | 11 | 0 | 0 | 82.4% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/accountProviderCredentialService.ts` | 20 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/accountProviderCredentialStore.ts` | 18 | 0 | 0 | 87.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/accountProviderInvalidation.ts` | 2 | 0 | 0 | 66.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/accountProviderRequestAuthService.ts` | 44 | 0 | 0 | 97.8% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/accountProviderTeamPlanRequestKey.ts` | 25 | 1 | 0 | 96.2% | 96.2% | services 线 | — |
| `packages/services/src/model-provider/accountRequestAuthService.ts` | 5 | 0 | 0 | 72.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/codingPlanProviderAvailability.ts` | 128 | 2 | 0 | 94.1% | 98.7% | services 线 | — |
| `packages/services/src/model-provider/legacyModelProviderSerialized.ts` | 292 | 1 | 0 | 96.4% | 99.7% | services 线 | ZC-DEEP-svc-a7.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts` | 29 | 0 | 0 | 87.8% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/legacyTeamOrganizationResolver.ts` | 11 | 0 | 0 | 92.9% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts` | 461 | 4 | 0 | 95.9% | 99.2% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/model-provider/offPeakModelSelectionView.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/providerConfigRuntime.ts` | 19 | 0 | 0 | 91.3% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/providerFacadeServices.ts` | 71 | 0 | 0 | 93.5% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/providerProvisioning.ts` | 4 | 0 | 0 | 80.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/providerProvisioningSource.ts` | 41 | 0 | 0 | 94.0% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/providerProvisioningTarget.ts` | 93 | 0 | 0 | 95.4% | 100.0% | services 线 | — |
| `packages/services/src/model-provider/providerRuntime.ts` | 84 | 0 | 0 | 95.7% | 100.0% | services 线 | ZC-deep-svc-a9.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/providerSettingsConnectivity.ts` | 7 | 0 | 0 | 81.8% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/model-provider/zaiStartPlanBilling.ts` | 44 | 1 | 0 | 86.3% | 98.0% | services 线 | — |
| `packages/services/src/model-provider/zcodeBuiltinRemoteConfig.ts` | 6 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/node.ts` | 546 | 0 | 0 | 95.4% | 100.0% | services 线 | ZC-DEFECTS.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/callbackAttribution.ts` | 6 | 0 | 0 | 83.3% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/oauthProfileSchema.ts` | 59 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/oauthProviderLogout.ts` | 14 | 1 | 0 | 92.9% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/providers/bigmodelProviderConfig.ts` | 11 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/providers/configUtils.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/providers/index.ts` | 8 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/providers/zaiProviderConfig.ts` | 12 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/oauth/runtimeConfig.ts` | 1 | 0 | 0 | 62.5% | 100.0% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/official-mcp/officialMcpCredentials.ts` | 82 | 2 | 0 | 81.3% | 98.8% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/official-mcp/officialMcpIssuanceAudit.ts` | 6 | 0 | 0 | 85.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/onboarding/localUsageEvidence.ts` | 10 | 0 | 0 | 78.1% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/onboarding/onboardingRecordService.ts` | 51 | 1 | 0 | 86.8% | 98.5% | services 线 | — |
| `packages/services/src/output-style/index.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/output-style/outputStyleService.ts` | 83 | 0 | 0 | 86.9% | 100.0% | services 线 | ZC-DEEP-svc-a7.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/paths.ts` | 73 | 0 | 0 | 95.1% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/plugin-sync/pluginSync.ts` | 13 | 0 | 0 | 69.2% | 100.0% | services 线 | — |
| `packages/services/src/plugin-sync/pluginSyncArchive.ts` | 90 | 0 | 0 | 97.8% | 100.0% | services 线 | — |
| `packages/services/src/plugin-sync/pluginSyncPath.ts` | 23 | 0 | 0 | 91.3% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/plugin-sync/pluginSyncService.ts` | 320 | 1 | 0 | 84.5% | 99.7% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/plugin-ui-bridge/appToolsContract.ts` | 2 | 0 | 0 | 81.8% | 100.0% | services 线 | — |
| `packages/services/src/plugin-ui-bridge/contract.example.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/plugin-ui-bridge/index.ts` | 4 | 0 | 0 | 50.0% | 100.0% | services 线 | — |
| `packages/services/src/plugin-ui-bridge/instanceAccounts.ts` | 10 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/plugin-ui-bridge/pluginUiAppToolsService.ts` | 13 | 1 | 0 | 71.4% | 92.9% | services 线 | — |
| `packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts` | 83 | 0 | 0 | 82.6% | 100.0% | services 线 | — |
| `packages/services/src/plugin-ui-bridge/pluginUiSamplingService.ts` | 7 | 0 | 0 | 85.7% | 100.0% | services 线 | — |
| `packages/services/src/plugin-ui-bridge/samplingContract.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/plugins/installedPluginRoots.ts` | 23 | 0 | 0 | 95.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/plugins/officialPluginCache.ts` | 9 | 0 | 0 | 77.3% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/plugins/pluginManagement.ts` | 18 | 0 | 0 | 87.9% | 100.0% | services 线 | — |
| `packages/services/src/plugins/pluginManagementService.ts` | 41 | 1 | 0 | 84.4% | 98.4% | services 线 | — |
| `packages/services/src/plugins/plugins.ts` | 16 | 0 | 0 | 81.3% | 100.0% | services 线 | — |
| `packages/services/src/plugins/pluginsService.ts` | 5 | 0 | 0 | 60.9% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/process/processResourceSampler.ts` | 90 | 1 | 0 | 86.5% | 99.2% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/process/processTreeOwnership.ts` | 47 | 0 | 0 | 98.1% | 100.0% | services 线 | — |
| `packages/services/src/process/processTreeSnapshot.ts` | 79 | 0 | 0 | 95.9% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/process/processTreeSnapshotAsync.ts` | 44 | 0 | 0 | 91.5% | 100.0% | services 线 | — |
| `packages/services/src/process/processTreeTerminator.ts` | 100 | 0 | 0 | 98.5% | 100.0% | services 线 | — |
| `packages/services/src/process/processTreeTypes.ts` | 9 | 0 | 0 | 94.1% | 100.0% | services 线 | — |
| `packages/services/src/process/processTreeWaiter.ts` | 46 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/process/runtimeProcessLifecycle.ts` | 20 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/process/windowsProcessListAsync.ts` | 50 | 0 | 0 | 93.1% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/process/windowsTaskkillRunner.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/project-catalog/contract.example.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/project-catalog/contract.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project-catalog/index.ts` | 16 | 0 | 0 | 94.1% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/contract.ts` | 17 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/default-workspace/migration.ts` | 15 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/project-storage/index.ts` | 22 | 0 | 0 | 90.9% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/legacy-tasks.ts` | 36 | 0 | 0 | 95.2% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/migrate-projects.ts` | 55 | 0 | 0 | 96.9% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/migration-order/migration.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/project-repository.ts` | 197 | 1 | 0 | 95.1% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/project-storage/remote-policy.ts` | 12 | 0 | 0 | 85.7% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/project-storage/schema.ts` | 26 | 0 | 0 | 92.3% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/startup-entry.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project-storage/startup.ts` | 30 | 1 | 0 | 84.2% | 97.4% | services 线 | — |
| `packages/services/src/project-storage/test-fixture.ts` | 17 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-b27.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/project-workspace-navigation/contract.example.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/project-workspace-navigation/contract.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project-workspace-navigation/index.ts` | 38 | 1 | 0 | 90.0% | 97.5% | services 线 | — |
| `packages/services/src/project-workspace-navigation/module.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project/autoArchiveScheduler.ts` | 30 | 2 | 0 | 80.0% | 96.0% | services 线 | ZC-deep-svc-a9.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/project/contract.example.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/project/contract.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/project/index.ts` | 78 | 0 | 0 | 92.8% | 100.0% | services 线 | — |
| `packages/services/src/project/legacy-single-root.ts` | 43 | 1 | 0 | 98.0% | 98.0% | services 线 | — |
| `packages/services/src/prompt-attachment-transfer/promptAttachmentTransfer.ts` | 8 | 0 | 0 | 83.3% | 100.0% | services 线 | — |
| `packages/services/src/prompt-attachment-transfer/promptAttachmentTransferService.ts` | 12 | 0 | 0 | 84.6% | 100.0% | services 线 | — |
| `packages/services/src/providers/api/apiEndpoints.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/providers/api/apiJson.ts` | 32 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/providers/api/apiKeyHeaders.ts` | 9 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/providers/api/index.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/providers/api/networkErrorClassifier.ts` | 20 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/providers/api/nodeApiClient.ts` | 109 | 2 | 0 | 98.4% | 98.4% | services 线 | — |
| `packages/services/src/providers/api/nodeApiNetwork.ts` | 60 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/providers/api/requestIdHeaders.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/providers/codexConfigToml.ts` | 59 | 1 | 0 | 90.2% | 98.4% | services 线 | — |
| `packages/services/src/providers/sourceHeaders.ts` | 24 | 0 | 0 | 80.0% | 100.0% | services 线 | — |
| `packages/services/src/providers/zaiBusinessTokenResolver.ts` | 33 | 1 | 0 | 81.8% | 97.0% | services 线 | — |
| `packages/services/src/remote-projects/connection-membership.ts` | 29 | 0 | 0 | 83.9% | 100.0% | services 线 | — |
| `packages/services/src/remote-projects/contract.example.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/remote-projects/contract.ts` | 8 | 1 | 0 | 94.7% | 94.7% | services 线 | — |
| `packages/services/src/remote-projects/index.ts` | 103 | 0 | 0 | 93.0% | 100.0% | services 线 | — |
| `packages/services/src/remote-projects/validation.ts` | 14 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/remote-projects/workspace-settings.ts` | 34 | 0 | 0 | 94.6% | 100.0% | services 线 | — |
| `packages/services/src/remote-sync/remoteSyncWriteAccess.ts` | 14 | 0 | 0 | 92.9% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/runtime-tools/agentProxyEnv.ts` | 28 | 0 | 0 | 81.4% | 100.0% | services 线 | ZC-DEEP-svc-a3.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/runtime-tools/appCaCert.ts` | 30 | 0 | 0 | 94.9% | 100.0% | services 线 | ZC-DEEP-svc-a3.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/runtime-tools/clientPlatform.ts` | 9 | 0 | 0 | 88.9% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/runtime-tools/node-forge.d.ts` | 13 | 0 | 0 | 93.3% | 100.0% | services 线 | — |
| `packages/services/src/runtime-tools/nodeEnv.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/runtime-tools/providerRuntimeResolver.ts` | 21 | 0 | 0 | 92.1% | 100.0% | services 线 | — |
| `packages/services/src/runtime-tools/runtimeCommandEnv.ts` | 60 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts` | 59 | 1 | 0 | 98.5% | 98.5% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/runtime-tools/runtimeToolResolver.ts` | 78 | 0 | 0 | 98.7% | 100.0% | services 线 | ZC-DEEP-svc-a3.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/automationCron.ts` | 73 | 0 | 0 | 85.9% | 100.0% | services 线 | ZC-deep-svc-a9.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/automationCronValidation.ts` | 21 | 1 | 0 | 87.5% | 95.8% | services 线 | — |
| `packages/services/src/session/automationIntervalCarrier.ts` | 23 | 0 | 0 | 91.4% | 100.0% | services 线 | ZC-DEEP-svc-a5.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/automationRepo.ts` | 506 | 3 | 0 | 94.5% | 100.0% | services 线 | ZC-DEEP-svc-a5.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/automationService.ts` | 58 | 3 | 0 | 90.5% | 97.1% | services 线 | — |
| `packages/services/src/session/claude-native/buildImportedClaudeTaskFile.ts` | 16 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/claude-native/claudeNativeImportedSessionTypes.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/claude-native/claudeNativeSessionHeadParser.ts` | 59 | 2 | 0 | 84.7% | 96.6% | services 线 | — |
| `packages/services/src/session/claude-native/claudeNativeSessionImportParser.ts` | 151 | 12 | 0 | 83.0% | 94.1% | services 线 | — |
| `packages/services/src/session/claude-native/claudeNativeSessionImportRepo.ts` | 79 | 0 | 0 | 84.9% | 100.0% | services 线 | — |
| `packages/services/src/session/claude-native/claudeNativeSessionImportService.ts` | 46 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/session/claude-native/importedClaudeHistoryRepair.ts` | 57 | 0 | 0 | 91.2% | 100.0% | services 线 | — |
| `packages/services/src/session/claude-native/importedClaudeTaskFileFilter.ts` | 19 | 0 | 0 | 84.2% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/session/claude-native/jsonLineRecord.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/session/claude-native/persistImportedClaudeTask.ts` | 13 | 0 | 0 | 93.8% | 100.0% | services 线 | — |
| `packages/services/src/session/claude-native/sessionHistoryJsonl.ts` | 15 | 2 | 0 | 73.3% | 86.7% | services 线 | — |
| `packages/services/src/session/continuousStreamCoalescer.ts` | 51 | 1 | 0 | 82.8% | 98.3% | services 线 | — |
| `packages/services/src/session/controllerRemoteIdentityMigration.ts` | 81 | 3 | 0 | 88.8% | 96.6% | services 线 | — |
| `packages/services/src/session/fileChangeTracker.ts` | 44 | 7 | 0 | 72.3% | 93.1% | services 线 | ZC-DEEP-svc-a7.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/legacyTaskSessionFile.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/session/mcpWorkspaceScope.ts` | 10 | 0 | 0 | 92.9% | 100.0% | services 线 | — |
| `packages/services/src/session/offPeakMockGateway.ts` | 202 | 24 | 0 | 79.7% | 90.4% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/session/offPeakResidentExecutions.ts` | 66 | 9 | 0 | 82.4% | 87.8% | services 线 | — |
| `packages/services/src/session/offPeakRuntimeModel.ts` | 52 | 1 | 0 | 78.9% | 98.9% | services 线 | — |
| `packages/services/src/session/offPeakServerClient.ts` | 49 | 2 | 0 | 93.2% | 97.3% | services 线 | — |
| `packages/services/src/session/offPeakTask.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/offPeakTaskRepo.ts` | 249 | 2 | 0 | 87.9% | 99.7% | services 线 | README-summary.md<br>ZC-CROSSREPO-string-literal-audit.md |
| `packages/services/src/session/offPeakTaskService.ts` | 135 | 27 | 3 | 79.2% | 89.6% | services 线 | — |
| `packages/services/src/session/offPeakWorkspaceIdentityMigration.ts` | 5 | 1 | 0 | 77.8% | 88.9% | services 线 | — |
| `packages/services/src/session/sessionMailbox.ts` | 5 | 0 | 0 | 60.0% | 100.0% | services 线 | — |
| `packages/services/src/session/sessionModeOptions.ts` | 24 | 1 | 0 | 92.6% | 96.3% | services 线 | — |
| `packages/services/src/session/sessionRealtimePort.ts` | 14 | 0 | 0 | 78.6% | 100.0% | services 线 | — |
| `packages/services/src/session/sessionTitle.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts` | 604 | 17 | 0 | 91.7% | 98.1% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/session/taskChangeSummary.ts` | 30 | 5 | 0 | 77.8% | 86.1% | services 线 | — |
| `packages/services/src/session/taskIndexRepo.ts` | 501 | 2 | 0 | 93.0% | 99.8% | services 线 | ZC-DEEP-svc-a4.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/tasksDatabase/controller-remote-schema-v4.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/tasksDatabase/migrations.ts` | 80 | 1 | 0 | 92.0% | 98.9% | services 线 | — |
| `packages/services/src/session/tasksDatabase/official-glm-selection-v3.ts` | 8 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/tasksDatabase/prepared.ts` | 12 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-a4.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/tasksDatabase/provider-selection-v2.ts` | 33 | 0 | 0 | 95.3% | 100.0% | services 线 | ZC-DEEP-svc-a4.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/session/tasksDatabase/schema-v1.ts` | 50 | 3 | 0 | 78.4% | 94.1% | services 线 | — |
| `packages/services/src/session/tasksDatabase/source-server-schema-v5.ts` | 59 | 0 | 0 | 96.8% | 100.0% | services 线 | README-summary.md<br>ZC-CROSSREPO-string-literal-audit.md |
| `packages/services/src/session/toolPlanAdapter.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/session/zcodeTaskListTypes.ts` | 9 | 1 | 0 | 100.0% | 88.9% | services 线 | — |
| `packages/services/src/session/zcodeTaskService.ts` | 35 | 2 | 0 | 78.9% | 98.8% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/setting/legacyAccountConnectionSettings.ts` | 41 | 0 | 0 | 95.7% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/setting/normalizeSettingsPatch.ts` | 7 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/setting/observableSettingService.ts` | 4 | 0 | 0 | 75.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/setting/setting.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/setting/settingService.ts` | 87 | 2 | 0 | 93.6% | 98.4% | services 线 | — |
| `packages/services/src/setting/settingsWriteQueue.ts` | 32 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-a6.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/settings-sync/settingsSync.ts` | 13 | 0 | 0 | 76.9% | 100.0% | services 线 | — |
| `packages/services/src/settings-sync/settingsSyncService.ts` | 760 | 11 | 0 | 87.7% | 98.6% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/settings-sync/types.ts` | 11 | 0 | 0 | 54.5% | 100.0% | services 线 | — |
| `packages/services/src/skill-sync/skillSync.ts` | 9 | 1 | 0 | 77.8% | 88.9% | services 线 | — |
| `packages/services/src/skill-sync/skillSyncArchive.ts` | 94 | 0 | 0 | 95.8% | 100.0% | services 线 | — |
| `packages/services/src/skill-sync/skillSyncErrors.ts` | 4 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/skill-sync/skillSyncPath.ts` | 23 | 0 | 0 | 91.3% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/skill-sync/skillSyncService.ts` | 137 | 0 | 0 | 89.0% | 100.0% | services 线 | — |
| `packages/services/src/skills/skillDiscoveryWalk.ts` | 30 | 0 | 0 | 86.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/skills/skills.ts` | 7 | 0 | 0 | 76.9% | 100.0% | services 线 | — |
| `packages/services/src/skills/skillsService.ts` | 548 | 11 | 0 | 89.4% | 98.2% | services 线 | ZC-DEEP-svc-rework.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/source-server-management/sourceServerManagement.ts` | 19 | 0 | 0 | 95.2% | 100.0% | services 线 | — |
| `packages/services/src/source-server-workspace/sourceServerWorkspace.ts` | 7 | 0 | 0 | 85.7% | 100.0% | services 线 | — |
| `packages/services/src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.ts` | 50 | 0 | 0 | 85.7% | 100.0% | services 线 | — |
| `packages/services/src/source-server-workspace/sourceServerWorkspaceService.ts` | 21 | 0 | 0 | 90.5% | 100.0% | services 线 | — |
| `packages/services/src/startup-storage/contract.example.ts` | 3 | 0 | 0 | 66.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/startup-storage/contract.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/startup-storage/index.ts` | 12 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/storage/adapters/fsCleaner.ts` | 49 | 0 | 0 | 89.3% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/storage/adapters/fsWalker.ts` | 28 | 1 | 0 | 78.9% | 100.0% | services 线 | — |
| `packages/services/src/storage/adapters/inProcessScanRunner.ts` | 16 | 0 | 0 | 90.5% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/storage/adapters/rootsResolver.ts` | 10 | 0 | 0 | 78.6% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/storage/adapters/volumeProbe.ts` | 11 | 0 | 0 | 75.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/storage/app/ports.ts` | 7 | 0 | 0 | 83.3% | 100.0% | services 线 | — |
| `packages/services/src/storage/app/scanJob.ts` | 28 | 0 | 0 | 90.6% | 100.0% | services 线 | — |
| `packages/services/src/storage/app/storageService.ts` | 21 | 1 | 0 | 75.9% | 96.6% | services 线 | — |
| `packages/services/src/storage/contract.example.ts` | 3 | 0 | 0 | 50.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/storage/domain/cleanPlan.ts` | 13 | 1 | 0 | 76.2% | 95.2% | services 线 | — |
| `packages/services/src/storage/domain/storageCatalog.ts` | 38 | 0 | 0 | 84.5% | 100.0% | services 线 | — |
| `packages/services/src/storage/domain/usageAggregate.ts` | 26 | 1 | 0 | 93.3% | 96.7% | services 线 | — |
| `packages/services/src/subagents/subagentConfigScope.ts` | 95 | 0 | 0 | 93.4% | 100.0% | services 线 | — |
| `packages/services/src/subagents/subagentMarkdown.ts` | 219 | 0 | 0 | 92.2% | 100.0% | services 线 | ZC-DEEP-svc-a7.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/subagents/subagentModelSelection.ts` | 4 | 0 | 0 | 75.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/subagents/subagentRuntimeConfig.ts` | 60 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/subagents/subagentStorage.ts` | 37 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-a2.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/subagents/subagents.ts` | 5 | 0 | 0 | 90.0% | 100.0% | services 线 | — |
| `packages/services/src/subagents/subagentsService.ts` | 240 | 0 | 0 | 88.3% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/symlinkPointsToTarget.ts` | 8 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/system/integratedTerminalShells.ts` | 40 | 0 | 0 | 97.5% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/system/sshConfigAlias.ts` | 175 | 0 | 0 | 82.4% | 100.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/system/system.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/system/systemService.ts` | 121 | 0 | 0 | 97.5% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/task-facts/contract.example.ts` | 1 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/task-facts/contract.ts` | 17 | 0 | 0 | 84.2% | 100.0% | services 线 | — |
| `packages/services/src/task-facts/index.ts` | 52 | 0 | 0 | 96.2% | 100.0% | services 线 | — |
| `packages/services/src/task-facts/repairSubagentTaskIndex.ts` | 13 | 0 | 0 | 93.8% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/task-groups/contract.example.ts` | 2 | 0 | 0 | 50.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/task-groups/contract.ts` | 13 | 1 | 0 | 80.0% | 93.3% | services 线 | — |
| `packages/services/src/task-groups/index.ts` | 42 | 0 | 0 | 95.2% | 100.0% | services 线 | — |
| `packages/services/src/task-groups/migration-v6.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/task-groups/repository.ts` | 97 | 0 | 0 | 88.2% | 100.0% | services 线 | — |
| `packages/services/src/telemetry/telemetryCore.ts` | 144 | 4 | 0 | 92.3% | 97.8% | services 线 | — |
| `packages/services/src/terminal/terminal.ts` | 8 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/terminal/terminalProfile.ts` | 123 | 0 | 0 | 92.9% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/terminal/terminalProfileMacOs.ts` | 103 | 2 | 0 | 91.3% | 98.1% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/terminal/terminalProfileTypes.ts` | 10 | 0 | 0 | 70.0% | 100.0% | services 线 | — |
| `packages/services/src/terminal/terminalService.ts` | 84 | 0 | 0 | 94.4% | 100.0% | services 线 | — |
| `packages/services/src/types/yazl.d.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/usage-stats/providers/bigmodelSubscriptionProvider.ts` | 18 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/usage-stats/providers/bigmodelUsageMonitorMapper.ts` | 241 | 1 | 0 | 90.3% | 99.6% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/usage-stats/providers/bigmodelUsageMonitorRange.ts` | 54 | 0 | 0 | 96.3% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaMapper.ts` | 47 | 2 | 0 | 91.8% | 95.9% | services 线 | — |
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` | 380 | 1 | 0 | 91.3% | 99.8% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/usage-stats/providers/zcodeMcpQuotaProvider.ts` | 18 | 2 | 0 | 71.8% | 97.4% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/usage-stats/usageStats.ts` | 12 | 2 | 0 | 58.3% | 83.3% | services 线 | — |
| `packages/services/src/usage-stats/usageStatsConfig.ts` | 2 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/usage-stats/usageStatsService.ts` | 36 | 0 | 0 | 81.6% | 100.0% | services 线 | — |
| `packages/services/src/window-controller/windowController.ts` | 17 | 0 | 0 | 69.6% | 100.0% | services 线 | — |
| `packages/services/src/window-project-directory/contract.example.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/window-project-directory/contract.ts` | 6 | 0 | 0 | 71.4% | 100.0% | services 线 | — |
| `packages/services/src/window-project-directory/index.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/zcode-agent/agentStderrCollector.ts` | 11 | 1 | 0 | 92.3% | 92.3% | services 线 | — |
| `packages/services/src/zcode-agent/agentTelemetryEnv.ts` | 9 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/automationToolPolicy.ts` | 9 | 0 | 0 | 91.7% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/zcode-agent/botTopicAdmission.ts` | 6 | 0 | 0 | 77.8% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts` | 66 | 0 | 0 | 94.3% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/groupAttachmentUpload.ts` | 23 | 1 | 0 | 88.5% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/groupRuntimeSnapshot.ts` | 34 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/independentPlanSupport.ts` | 10 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/localRuntimeNetworkCapture.ts` | 16 | 1 | 0 | 73.7% | 94.7% | services 线 | — |
| `packages/services/src/zcode-agent/modelTrajectory.ts` | 99 | 1 | 0 | 82.0% | 99.2% | services 线 | — |
| `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts` | 12 | 0 | 0 | 93.3% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/pluginReferenceCatalogRequest.ts` | 8 | 0 | 0 | 88.9% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/topicResourceBridge.ts` | 18 | 1 | 0 | 90.9% | 95.5% | services 线 | — |
| `packages/services/src/zcode-agent/topicResourcePeers.ts` | 18 | 0 | 0 | 90.5% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/topicResourceRelay.ts` | 41 | 0 | 0 | 88.4% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/topicResourceRelayChannel.ts` | 23 | 0 | 0 | 91.7% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/topicResourceRelayClient.ts` | 24 | 0 | 0 | 88.5% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/topicResourceUpload.ts` | 26 | 0 | 0 | 81.5% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeAgent.ts` | 95 | 1 | 0 | 85.0% | 99.6% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/zcode-agent/zcodeAgentBrowserAmbientContext.ts` | 32 | 0 | 0 | 91.9% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts` | 220 | 4 | 0 | 94.3% | 99.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/zcode-agent/zcodeAgentErrors.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/zcode-agent/zcodeAgentPluginParams.ts` | 47 | 1 | 0 | 93.4% | 98.4% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeAgentPresentationSurface.ts` | 3 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` | 230 | 3 | 0 | 89.9% | 99.2% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 2123 | 9 | 0 | 94.3% | 99.8% | services 线 | ZC-DEEP-svc-b2.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/zcode-agent/zcodeAgentSpawnCwd.ts` | 5 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeConfigOptions.ts` | 11 | 0 | 0 | 93.8% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeProtocolClient.ts` | 76 | 1 | 0 | 90.4% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeProtocolTransport.ts` | 5 | 1 | 0 | 80.0% | 80.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeSessionEventCoalescer.ts` | 50 | 0 | 0 | 91.1% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeStdioTapDevConfig.ts` | 18 | 1 | 0 | 84.2% | 94.7% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeStdioTransport.ts` | 73 | 1 | 0 | 97.5% | 99.2% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeStorageStartupGate.ts` | 31 | 1 | 0 | 97.1% | 100.0% | services 线 | — |
| `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` | 298 | 5 | 0 | 86.2% | 99.0% | services 线 | ZC-SCOPE-TIERS.md |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 1756 | 2 | 0 | 94.3% | 99.9% | services 线 | ZC-DEEP-svc-b2.md<br>ZC-SCOPE-TIERS.md |
| `packages/services/src/zcode-agent/zcodeV4HostCommand.ts` | 32 | 0 | 0 | 89.1% | 100.0% | services 线 | ZC-DEEP-svc-a8.md<br>ZC-DEEP-svc-rework.md |
| `packages/services/src/zcode-session/importedClaudeSessionRepair.ts` | 15 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/zcode-session/zcodeSession.ts` | 38 | 0 | 0 | 89.1% | 100.0% | services 线 | — |
| `packages/services/src/zcode-session/zcodeSessionApiRetry.ts` | 31 | 0 | 0 | 100.0% | 100.0% | services 线 | — |
| `packages/services/src/zcode-session/zcodeSessionDraftRegistry.ts` | 15 | 0 | 0 | 100.0% | 100.0% | services 线 | ZC-DEEP-svc-rework.md |
| `packages/services/src/zcode-session/zcodeSessionService.ts` | 71 | 0 | 0 | 97.6% | 100.0% | services 线 | — |

### 4.5 规则（写进本节，作为后续判据）

1. **每笔注释提交必须有对应台账行**，否则 §2.17 的白名单检查不通过。
   台账行可以是 b 族、svc 族或 L1/L2 族，但必须能按精确路径查到；只有序号区间的，视为未登记。
2. **审计工具的范围必须写进产物。** 任何「全仓」结论都要先声明解析了哪些台账族；
   只 glob `ZC-DEEP-b*.md` 的结果只能叫「b 族审计」，不能叫「全仓审计」。
3. **分母与分子同源。** 报「多少文件没提交」时，分子分母必须来自同一族台账；
   混族比较会凭空造出一批「孤儿」（上一轮 436 就是这么做出来的）。

## 5. 改写计划：总量、差集与分批（2026-11-10）

### 5.1 两个「待改写 weak 行」不是同一集合

| | `zc-gate` diff 口径 | `deep-quality` 整文件口径 |
| --- | --- | --- |
| 范围 | 该批 `git diff -U0 <base>` 新增的注释行 | 1,726 个文件的全部非结构性注释行 |
| 豁免 | 无 | 文件头块（`inHeader`）、中文具体名词（`CN_NOUN`）、数字 / 反引号锚点 |
| 判据 | W / L / POEM | weak（`isWeakLine` + 无指代 / 空泛提醒 / 序数空转 / 同义重复），filler 另计 |
| 来源 | 天然是本线新增 | 需按基线 `8f7daaf0` 的 `+` 行号拆 own / upstream |

判据修正后实测（工具 `diffsets.mjs`，度量 JSON `q-main-head.json`）：

| 量 | 值 |
| --- | --- |
| A：19 批（b207–b226，跳过 b224）diff 口径 | **529** 行 / 76 文件 |
| B：整文件口径 own weak | **7,421** 行 / 1,007 文件 |
| B：整文件口径 upstream weak | 682 行 |
| B：整文件口径 own filler | 5,249 行（全部同时是 own weak，交集 = 5,249） |
| A ∩ B | **242** 行 |
| A − B | 287 行 = `inHeader` 31 / `CN_NOUN` 184 / 数字锚点 6 / 其余 66 |

### 5.2 计划变更

原计划「清 532 行（修正后 529）」作废，改为 **清 deep-quality 认定的全部本线 own weak 行 = 7,421 行**。
理由：diff 口径只看得见这一批新增的注释，看不见 b01–b206 期间已落库的存量；只清 529 会让台账写「已清」而账上仍剩 7,179 行。

- 目标集合：`_annot_baseline/snapshot/weak-own-lines.tsv`（逐行原文，7,421 行）；
  按文件计数见 `weak-own-by-file.tsv`。
- filler 不单列：5,249 行 own filler 全部落在 own weak 内，改完 weak 即覆盖。
- upstream 的 682 行 weak / 13 行 filler 不动（不是本线财产）。

### 5.3 分批节奏

- 每批 ≤60 改写行、整文件不拆 → **138 批**；存量最重的文件 25 行，单文件不会超过上限。
- 按现有每批 ≈120 新增行的节奏折算 ≈62 批（改写批 numstat 为 `+N/−N`，N = 实际改写行数）。
- 每批一个提交，标题以 `bNNN` 开头（§2.19），行数取 `git show --numstat`（§2.15）。

### 5.4 改写批门禁

`zc-commit --rewrite-annot --base <该批改写前 HEAD> --register <tsv>`，四行计数必须为：

```text
删本线注释    n=改写行数   （允许，逐行登记）
删代码        n=0          （必须 0）
删上游注释    n=0          （必须 0）
新增非注释行  n=0          （必须 0）
```

来源判据 = base 上该行的 blame 提交标题（`bNNN` / `注释` / `snapshot(annot)` 算本线）。
`--base` 不得写死成 `8f7daaf0`：那样每批会把此前所有批的改写一起卷进来。
