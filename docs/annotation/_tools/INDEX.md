# 尺子归档（zc-gate / zc-commit）

- 口径：本线自己维护的两把门禁工具，每版归档一份，**只增不改、文件名带版本**；复算一律指向本目录的具体文件，不指向 `_annot_baseline/` 的工作副本。
- `sha1` 一律是 **git blob sha1 前 12 位**（`git rev-parse <rev>:<path>` 可直接核对）；括号里的 `content` 是文件原文的 sha1，仅用于和 2026-11-10 的 b235 记录对照（见 §口径事故）。
- 归档时间以提交时间为准；「首个使用批次」按该版文件在批次开始前已在工作区生效来填。

## 1. zc-gate（判据：W / L / POEM + 改写门禁判定）

| 文件 | 版本 | sha1（blob） | content sha1 | 归档提交 | 改了什么 | 首个使用批次 |
| --- | --- | --- | --- | --- | --- | --- |
| [`zc-gate-v1.mjs`](zc-gate-v1.mjs) | v1 | `0b75b53c8ba1` | `09770a4d25d9` | `9695122f`（14:22 快照） | 初版：W / L / POEM 三判据、`scanFile` 走 `git diff -U0 HEAD` | 无（批次开始前） |
| [`zc-gate-v2.mjs`](zc-gate-v2.mjs) | v2 | `c9d620a3b9a5` | `58d5b810a613` | `611b24a5`（14:40） | 门禁基线参数 `--base`；审计范围不变量 | 无（批次开始前） |
| [`zc-gate-v3.mjs`](zc-gate-v3.mjs) | v3 | `f75c5e64246f` | `f53d75cdc9d7` | `2650dd7a`（14:50） | `ident()` 纳入全大写缩写（≥2 字符，如 UI / ID / API）；W 与 L 同行只计一次（与 waterLines 去重口径一致）；`scanFile` / CLI 支持 `--base` | **b229**（14:58 提交，v3 已于 14:50 归档）；b230–b244 沿用 |
| [`zc-gate-v4.mjs`](zc-gate-v4.mjs) | v4 | `633b334905ee` | — | b245 台账提交 | **嵌套注释判据**：新增 `isNestedComment`，剥掉第一层注释符后正文仍以 `//` 或 `/*` 开头即判嵌套（`// //` 802 行的根因，负例回放 802/802 拦住） | **b245** |

- **v4 是当前活文件**（见上表）；v3 的 blob `f75c5e64246f`、content `f53d75cdc9d7` 仍是 b230–b244 的复算基准，不要因为换版就改历史批次的 `ruler=`。
- 注意：`_annot_baseline` 工作区里 `zc-gate.mjs` 是未跟踪/已修改状态，不代表批次间改过；复算前一律用 `git hash-object` 比对版本。

## 2. zc-commit（改写批七行门禁）

| 文件 | 版本 | sha1（blob） | content sha1 | 归档提交 | 改了什么 | 首个使用批次 |
| --- | --- | --- | --- | --- | --- | --- |
| [`zc-commit-v1.mjs`](zc-commit-v1.mjs) | v1 | `59a7f1713b7b` | `5cb6aa986546` | `9695122f`（14:22 快照） | 五/六行：删代码 / 删上游注释 / 新增非注释 / 新增注释行＋判据命中 | 无（批次开始前） |
| [`zc-commit-v2.mjs`](zc-commit-v2.mjs) | v2 | `629ef5b8fa27` | `11292f07ffc1` | `2650dd7a`（14:50） | 新增 `--rewrite-annot --base --register` 改写门禁：删除按来源分「删本线注释 / 删代码 / 删上游注释」三类 | **b229** 首跑（六行，4 行判据命中） |
| [`zc-commit-v3.mjs`](zc-commit-v3.mjs) | v3 | `165fa79f96a1` | `5cd66fdd5097` | `790e61ba`（15:09） | 增加「原行搬移」「标点级改写」两行（七行）；`punctOnly` 归一化比对（整段 run + 逐行） | **b229** 复核；b230–b233 沿用 |
| [`zc-commit-v4.mjs`](zc-commit-v4.mjs) | v4 | `f2661d7008ee` | `72349bb23278` | `71b58952`（15:20） | 搬移行从「新增注释行」分子中扣除、输出标「不计入改写量」；失败明细打印兼容 `content` 字段 | **b234**、b235 |
| [`zc-commit-v5.mjs`](zc-commit-v5.mjs) | v5 | `005b2b409f54` | `0b50792b03b9` | `a1f911d5`（17:05 台账提交） | 本线归属判据补齐 `docs(注释):` 前缀：L2-B10b 起的注释提交标题不以「注释」开头，旧判据把它误判成上游（b236 首跑 4 行「删上游注释」假阳性，其中 3 行属此因）。判据方向只放宽「本线」，不会让历史批次由过变不过 | **b236** |
| [`zc-commit-v6.mjs`](zc-commit-v6.mjs) | v6 | `032283968d18` | — | `6515ce56`（17:15 台账提交） | **归属判据改根**：删掉 `isOwnCommit(title)`，改为 blame sha ∈ 台账白名单（`own-commits.mjs`）。标题怎么写都不影响；白名单只从台账与本目录 `OWN-COMMITS.md` 长出来，可复算、可审计 | **b237** |
| [`zc-commit-v7.mjs`](zc-commit-v7.mjs) | v7 | `19d38e36b73b` | — | b241 台账提交 | **门禁自报版本**：七行之前打印 `GATE self=<path> blob=<git hash-object>`，`ruler=` 不再靠人手抄（b241 抄成 v4 副本的教训） | **b242 起** |
| [`zc-commit-v8.mjs`](zc-commit-v8.mjs) | v8 | `d5dc8bd91446` | — | b242 台账提交 | **补 JSDoc 计数洞**：`新增注释行` 原先只收 `//` 行，JSDoc 的 `*` 新行既不计数也不过 W/L/POEM（b242 首跑 7 vs numstat 9 暴露） | **b242 起** |
| [`zc-commit-v9.mjs`](zc-commit-v9.mjs) | v9 | `1542e4088fd2` | — | b243 台账提交 | **提交集合断言**：`git add` 后比对 `git diff --cached --name-only` 与本批清单，缺项或多出任何路径一律 `exit 1`（b242 的改名混入代码提交） | **b243 起** |
| [`zc-commit-v10.mjs`](zc-commit-v10.mjs) | v10 | `066509a32c52` | — | b243 台账提交 | **补块注释计数洞**：`新增注释行` 再收 `/*` 起始行（含单行 `/** x */`），剥前缀与尾 `*/` 后过同一套判据（b240 的 26 行单行 JSDoc 曾整批漏判，回溯查出 3 处命中） | **b243 回溯补修起** |
| [`zc-commit-v11.mjs`](zc-commit-v11.mjs) | v11 | `3c65b811b847` | — | b245 台账提交 | **嵌套注释硬拒绝**：新增注释行若剥一层后仍以 `//` 或 `/*` 开头即 `exit 1`；第七行加 `其中嵌套注释 n` 子计数，保持七行结构 | **b245** |
| [`zc-commit-v12.mjs`](zc-commit-v12.mjs) | v12 | `a35b42fa2e4c` | — | b253 台账提交 | **标题后缀去重**：`--subject` 末尾若已带 `(+X/−Y)`（可叠加多次），先剥净再拼 numstat 后缀。b252 的 `(+65/−65) (+65/−65)` 是首例；门禁七行与判据不变 | **b253**（提交 `77c365de` 用带后缀的 subject 实测，落库为单后缀） |
| [`zc-commit-v13.mjs`](zc-commit-v13.mjs) | v13 | `f02be471a849` | — | b278 台账提交 | **顺序前置拦截**：`--rewrite-annot --yes` 必须先证明 `--verify` 已落盘，缺 `--snapshot` / 缺 `t-verify` / `t-verify ≤ t-record` / `t-verify` 不在过去 / 快照文件集≠本批清单，任一不满足即 `exit 9`，**不 `git add`**；`t-verify < commit_time` 从事后断言变成做事时就做不到。负控：先 commit 后 verify → 拒；t-verify 早于 t-record → 拒 | **b278**（b277 曾先 commit 后 verify，只能 reset --soft 补救） |

- **v13 是当前活文件**：`d:/code/_annot_baseline/zc-commit.mjs` 与本目录 `zc-commit-v13.mjs` 逐字节一致（blob `f02be471a849`）。
- **v4 是当前 zc-gate 活文件**：`d:/code/_annot_baseline/zc-gate.mjs` 与本目录 `zc-gate-v4.mjs` 逐字节一致（blob `633b334905ee`）。
- **b286 归档补洞**：`_tools/zc-gate.mjs` 缺 `isNestedComment`（活文件 `_annot_baseline/zc-gate.mjs` 有），
  直接跑归档版 `_tools/zc-commit-v13.mjs` 会 `SyntaxError`；已按 v4 同实现补齐，归档 v13 可独立复跑。
  `judgeEntries` 与活文件逐字一致，历史批次读数不受影响。
- v9 是 b243 本体实跑版本（`GATE self=… blob=1542e4088fd2`）；b243 新增 11 行全为 `//`，v10 复算同值。
- `_tools/zc-commit.mjs`（v4 内容，blob `f2661d7008ee`）已改名为 `zc-commit-pre-v6-DO-NOT-RUN.mjs`，**当前不执行**。
- v5 只是一个补丁，已由 v6 取代；保留 v5 是为了让 b236 的「哪版跑出什么」可追溯。
- `_annot_baseline/zc-commit.mjs` 在该仓里是 `??`（未跟踪），历史只能靠本目录这几份归档复原——所以 v1/v2 也必须留档，不能只留最新版。

## 2.1 归属白名单（zc-commit v6 的判据依赖）

| 文件 | sha1（blob） | 作用 | 首个使用批次 |
| --- | --- | --- | --- |
| [`own-commits.mjs`](own-commits.mjs) | `16b02706cd90` | **v3（b264）：白名单改机器生成，文档散文不再参与解析**——唯一事实来源是 `OWN-COMMITS.tsv`；`loadOwnCommits` 逐行 `rev-parse --verify`，每个 sha 必须解析成 commit 本身；`--verify` 断言「TSV 行数 == 机器生成行数、无缺失、无多余、逐字文本一致」，失败 `exit 1`；`--check` 三态沿用 v2（本线 / 上游 / 未解析，未解析 `exit 3` 并附 author+subject） | **b237**（v2：**b248**；v3：**b264**） |
| [`own-commits-v2.mjs`](own-commits-v2.mjs) | `f56b84fbf964` | v2 归档：从 `ZC-*.md` 散文正则抽白名单（`提交 <sha>` / `安全快照 <sha>`）。**只作历史复原，不要再运行**——b262 的归户翻转就是它把上游 sha 抽进白名单造成的 | b248（归档于 b264） |
| [`own-commits-gen.mjs`](own-commits-gen.mjs) | `28546a6d5737` | 生成器：`git log --format=%H%x09%an%x09%ai%x09%s --reverse` 按 `OWN_AUTHORS`（当前 `zhanglingfeng`）过滤，按 sha 升序渲染 TSV；`--print` 只打印。**b281 起同时写 `OWN-COMMITS.meta.json`（`head` / `generatedAt` / `rows`）**，供产能件做新鲜度断言：白名单落后会让新提交的改写行被判「上游自清」，`done` 少算且不报错（b280 首跑少算 85 行） | **b264**（meta：**b281**） |
| [`OWN-COMMITS.tsv`](OWN-COMMITS.tsv) | `15c011a59bde` | 机器生成的本线白名单，**560 行**（`sha / author / date / subject`，b355 后）。判据是「作者 ∈ OWN_AUTHORS」，不是「台账里被提到过」；新增提交后重跑生成器，不手改。**b281 起配 `OWN-COMMITS.meta.json`**（生成时的 `head` / 时间 / 行数），与 TSV 同批提交；产能件拿它比对 HEAD，不一致即拒跑 | **b264**（meta：**b281**） |
| [`ledger-assert.mjs`](ledger-assert.mjs) | `35afeb266f97` | 把台账算术从手算改成断言：`Σ 各批登记行 = 累计`（逐文件登记数必须等于 b247 批次表计划数，合批/漏登会被抓）、`累计 + 剩余 = 802`、`Σ 全仓实测 = 清单内 + 清单外`，并断言 `清单内实测 = 剩余`；**b256 起输出滚动三列**（144 / 658 / 802 的 计划 / 累计 / 剩余），断言两列计划数等于 144 / 658、`144 累计 + 658 累计 = 802 累计`、批次表每行 `144+658=合计`；**b259 起加 `CLOSE`**（按未完成批次聚合的 `累计 + B11 n + B12 n = 802`）与 **`FILELIST`**（收尾 `--file-list` 必须就是批次表这 15 个文件本身），两条均进断言；**b261 起加 `EXEMPT`**：把 `GREP` 清单外 2 条（`_tools/d7e-shift.mjs:1` 工具自述里的 `// ///`、`docs/webdriverio/docs/ocr-testing/ocr-faq.md:1` 上游文档示例样板）固化成带判据的豁免表，输出 `EXEMPT 2`，并断言 `清单内 + 豁免 = 全仓`、未登记清单外一律 fail、豁免条数对不上 fail；**b261 起批次范围收紧**：只统计「登记文件全部落在 b247 批次表内」的 `*-rewrite.tsv`，802 收口后恢复的常规批（b261）打印 `IGNORED …（非 802 批次，N 行不计入）` 而不污染 802 累计；事实来源是 b247 批次表 + 各批 `*-rewrite.tsv` + `git grep -c`；任一不成立 `exit 1` | **b255**（三列：**b256**；CLOSE/FILELIST：**b259**；EXEMPT/批次范围：**b261**） |
| [`OWN-COMMITS.md`](OWN-COMMITS.md) | `4be96e563432` | 手工登记没有独立批次台账的 L2 覆盖提交（12 条），并写清维护规则；v2 起规则 3 改为「未解析必须人工定归属并回填，否则计待定」 | **b237**（规则 3：**b248**） |
| [`weak-guard.mjs`](weak-guard.mjs) | `a3600ccfacab` | 15 文件 weak **非回归断言**（b258 起每批必跑）：解析两份 `deep-quality --list-weak` 输出，断言 `WEAK lines=N` 等于明细条数、`files=15`；**b259 起比较键从「行号」改为「文件 + weak 行正文」的多重集合**（行号会被本批插入/删除行整体位移，「旧 weak 位移」会被误判成「新增 weak」；回放见 `ZC-deep-b259.md` §0）；`post > pre` 或 `pre > --max`（缺省 8）即 `exit 1` 并打印新增 `文件:行 原因 正文`。存在的理由：全仓 weak 率的分母被别的会话持续撑大，「≤3.1%」天然成立、不能失败，只作兜底；这条才是每批能失败的质量证据。**b260 起头部写明三条已知盲区**（同文件同正文按次数比会漏判、不校验位置故正文互换不报、作用域是单文件故跨文件互换不报）：判据未改，`新增=0` 只是「本键未测到新增」，是近似守卫 | **b258**（改键：**b259**；盲区注释：**b260**） |

- 当前白名单 **560 条**（`OWN-COMMITS.tsv`，2026-11-12 由 `own-commits-gen.mjs` 从 `git log` 生成；本线判据 = 作者 `zhanglingfeng`）。
- **v2 白名单的规模是伪像**：v2 从台账散文抽取，只有 56 条，恰好是「作者 = 本线」的一个子集——也就是说它一直在
  统计「台账里提到过的提交」，而不是「本线写的提交」。作者口径下多出的 226 条属于早期直接提交（没有独立批次台账）。
- **b262 归户翻转的根因（v2 事故）**：台账正文写「本线的注释提交，`872ad960` / `aac47556` 都在册外」，
  被 `PATTERNS[0]` 把两个上游 sha 抽进了白名单，1,001 行归户翻转。写台账时靠措辞规避（sha 不紧跟「提交」6 字符内）
  约束不了人，所以 v3 直接取消散文解析。
- **负例回归（b264 已做）**：往 `ZC-deep-b263.md` 追加一行「本线提交 `deadbeef…`，安全快照 `1234567890ab…`」后跑
  `own-commits.mjs --verify`，输出仍为 `rows=214 generated=214 missing=0 extra=0 text=same`、TSV sha256 不变；
  `--check` 对两个假 sha 判「未解析」并 `exit 3`。删掉该行复验通过。
- 白名单文件跟着台账一起提交；改了就换 sha1，下一批复算前先跑 `--verify`。

## 2.2 产能估算件

| 文件 | sha1（blob） | 作用 | 首个使用批次 |
| --- | --- | --- | --- |
| [`capacity-estimate.mjs`](capacity-estimate.mjs) | `3ff652131ef9` | 从基线 tsv + 各批 `*-rewrite.tsv` 推出已清集合，逐档汇总剩余文件/行/批数；**v2（b264）：ACCT 记账单位从「文件」改为「行」**——done 文件按「基线 weak − 现 weak」记账（现 weak 取 `--weak <list-weak>` 与池定义 `git diff -U0 8f7daaf0 HEAD` 的交集），文件仍有池内 weak 时按 `PARTIAL` 回池排期；**新增断言 `acct_remain == pool_remain`，不等即 `exit 1`**，并打印 `DRIFT` 明细，不接受人工写「差 N 已知」；`--weak` 为必填（缺省 `exit 2`）；`--plan 6x100` 给唯一排期口径，`--plan-print N` 打印前 N 批并**逐片现算 blame 三态摘要 `writable=X upstream=Y pending=Z`**（配额分母只用 `writable`；`pending>0` → `exit 3`；`writable<计划行数` 时提示实际按 `writable` 排）；**b265：新增 `--pre-weak`（本批改写前的 `--list-weak` 快照）算 `self-clearing`，即「没落笔却由相邻改写转强」的行；`PLAN` 行改为 `writable / self-clearing / upstream / pending / quota`，`quota = writable − self-clearing`**；自清行按四桶归类（可写桶才进配额扣减，池外与上游桶不扣，否则会重复计数）；文件头写明权威计数器与「不可相减」的参考口径；`--per-file` 只作每批诊断；**b266：分类顺序定死「池外 → 未解析 → 可写 → 上游」，三态扩成四桶并打印 `pool-out`**——池外的自清行若落「可写桶」，会出现「配额 99 / 实清 100」的矛盾（b265 的 `agent.ts:225` 首版即此错），`PLAN` 行因此改为 `writable / upstream / self-clearing / pool-out / pending / quota`；**b266 同时内置两条等式断言**——四态之和（可写 + 上游 + 未解析 + 池外）必须等于成员文件 weak 合计，池内三桶必须等于 `weak ∩ pool` 实测行数，不等即 `exit 5`（`quota` 式子直接印在摘要里：`quota=N(writable X − self-clearing Y)`；`pending>0` 仍 `exit 3`）；**两条断言各有负控**（注入「漏分类 1 行」/「交集重复 1 行」均 `exit 5`，正常输入 `exit 0`，见 `ZC-deep-b266.md` §2.1）；**b267：新增 `--batch bNNN` 输入校验**——`--pre-weak` 必须是**上一批的批后全仓快照**（批号 = `--batch` 减 1，文件名须含 `post` 且不得含 `before`），`--weak` 必须是本批批后快照，不满足即 `exit 6` 并打印期望文件名；起因是 b267 首次把 `b266-weak-before.txt` 当批前，只污染 `SELF-CLEAR` 归桶、数字未受影响，但同类错误落在 `--weak` 基数上会直接改池子；四条负控（批号对但类型错 / 批号错位 / `--weak` 传上一批 / 批前缺失）均 `exit 6`，其中「批号对但类型错」抓出第一版只比批号的洞（见 `ZC-deep-b267.md` §2.2）。`--batch` 缺省时不校验，保持历史批次可复算。**b281：启动即断言白名单新鲜度**——读 `OWN-COMMITS.meta.json`，缺文件 `exit 2`（`WHITELIST MISSING`），`meta.head ≠ HEAD` 时打印 `WHITELIST STALE 白名单落后 N 个提交` 并 `exit 2`，不进入任何统计；并在 `ACCT lines` 后固定打印 `ACCT NOTE 恒等式只对池内成立；池外 weak 不进 done/remain` | **b239**（断言）/ **b250**（等式与口径标注）/ **b251**（`--plan`）/ **b261**（`--plan-print`）/ **b264**（行口径 + 池等式断言 + 三态摘要）/ **b265**（`--pre-weak` + self-clearing 四桶 + 权威口径注释）/ **b266**（`pool-out` 第四桶 + 分类顺序）/ **b267**（`--batch` 输入校验）/ **b281**（白名单新鲜度 + ACCT NOTE）/ **b273**（快照剥 BOM + 行数/表头断言，`exit 9`） |
| [`capacity-estimate-v1.mjs`](capacity-estimate-v1.mjs) | `8d31b38559da` | v1 归档：整文件 all-or-nothing 记账（`doneLines += baselineCount`）。保留用于复算 b239–b263 的历史数字，**不要再用于新批次** | b239（归档于 b264） |

- **快照文件的 BOM（b272 实测，b273 起工具内断言）**：PowerShell 5.1 的 `>` 会写 UTF-8 BOM，`^WEAK\t` 解析会漏掉**首行** weak，
  `SELF-CLEAR` 因此多算一条（b272 首跑把 `App.tsx:295` 误报成自清，剥 BOM 后 `n=2 → 1`）。
  b273 起 `readWeakSnapshot` **入读统一剥 BOM**，并断言「物理非空行数 == 成功识别行数」且
  「表头 `WEAK lines=N` == 明细行数」，任一不等即 `exit 9`（负控：删一行明细 → `exit 9`）。
  快照仍建议用 `cmd /c "node … > file"` 生成，断言只是兜底。
- **白名单新鲜度的正负控（b281 实测）**：缺 meta → `WHITELIST MISSING …` + `exit 2`；
  把 `meta.head` 改成父提交 → `WHITELIST STALE 白名单落后 1 个提交（生成于 04ba2ad6，当前 HEAD daa89fa22b8c）` + `exit 2`；
  重跑生成器后 → `WHITELIST OK head=… rows=272` + 正常统计。三条都按「改完即还原」操作，
  记录在 `ZC-deep-b281.md` §7.2。
- **登记表与批后快照必须同批落盘（b281 实测）**：缺 `ZC-deep-bNNN-rewrite.tsv` 时 `done` 集合不含本批文件，
  100 行会变成 `ALIGNED … diff=100 MISMATCH` + 六条 `DRIFT`，看起来像口径漂移，实为登记表没落盘；
  补上后同一份快照复跑 `diff=0`。**b282 起加机器检查**：`--plan` 指向的文件不存在时 precheck 一律 `exit 2`，
  不让 ACCT 差值去承担报错职责（`exit 2` 的证据见 §2.5 行级漂移负控表）。

### 2.3 产能口径（b245 修正）

**旧口径（作废）**：`总时长 = 批数 × 每批固定时长 + 总行数 × 单位行时长`。它假设固定成本一批只付一次，于是「合并文件摊薄固定成本」。

**新口径**：`总时长 ≈ 总扫描单元数 × 单位单元时长 + 编辑行数 × 单位行时长 + 返工时长`。

依据（b243/b244/b245 实测）：固定成本的主体是 `deep-quality` 全量扫描（`--list-weak` + `--uncovered` 前后各一次），
按 **units** 计价而非按批计价——b243 `45.8s/1046 units = 0.0438`、b244 `75.9s/1684 = 0.0451`、b245 `82.4s/2099 = 0.0393`。
units 随文件数线性增长，因此合并文件不会降低固定成本，只改变返工的爆炸半径。

**返工是当前瓶颈**：b244 返工 85.2s，占墙钟 49%；b245 降到 21%。根因是 W（无锚点）与 L（≥2 分隔符且无谓词）互补，
改一边掉到另一边。产能报表必须单列返工，不许摊进每文件均摊。

**b252 补充（时长写法，硬约束）**：`批数 × 每批耗时` 只在「每批耗时 = 该批文件数 × s/文件」时才成立。
b251 §2.2 的 `159 × 74.5s ≈ 3.3h` 隐含「批变大、时间不变」，与 b244 的 8 文件反例矛盾，**已作废**。

**b262 更正（`s/文件` 作废，产能改按行计价）**：b252 把 `s/文件` 当产能依据，实测不成立。
b261（5 文件 / 100 行）实测 `50.4 s/文件`，是 `20.6` 的 2.45 倍；而同一批 `s/行 = 2.52` 落在
802 解包批基线 `0.85–2.85` 内。差的不在速度，在**每文件行数**：`s/文件 = 行/文件 × s/行`，
装箱密度一变，`s/文件` 整体平移，所以它是密度的函数，不是时钟。

| 口径 | 值 | 用途 |
| --- | ---: | --- |
| `s/行`（**旧口径**，b261–b272） | **降级为历史值**：2.61 / 2.17 / 2.52 / 1.58 等全部保留，但整列标「手工打点 / 口径不一」 | **不参与**新口径的任何中位数、区间与排期；`1.58` 也不再是主档 |
| `s/行`（新口径，b273 起） | `batch_wall_total` / `batch_wall_controllable` / `落笔段` / `tail` 四量并列（定义见 §2.5） | **n=7 已到（b273–b279：1.51 / 1.11 / 1.72 / 1.06 / 1.69 / 1.98 / 1.07）**：中位数 1.51、极差 0.92（60.9% > 30%），按约定**仍不设主档**；`record_runs` 分组（返修次数 = `record_runs − 1`）：零/一次返修（`≤2`）n=7 中位数 **1.51**，两次以上（`≥3`）n=0 无样本；旧值只作量级交叉验证；`total` 含批间非改写动作，不折算行 |
| `s/行`（中位数，b267 起） | **2.61**（四批干净窗口 b261 1.90 / b262 2.17 / b263 3.04 / b266 3.96 的中位数） | **旧口径**，不再作排期依据；含中断批中位数 3.04 只作上界压力测试 |
| `s/行`（三批窗口） | 2.17（b261 / b262 / b263 的中位数） | **仅三批窗口，不用于排期**；b265 时曾作依据，加入 b266 后由 2.61 取代 |
| `s/行`（趋势） | 1.90 → 2.17 → 3.04 → 3.96（b261/b262/b263/b266） | **单调上升，疑似难度递增，未插桩证实**；若成立，中位数外推会低估后半程，剩余批次按区间上界估 |
| `s/行`（旧点估计） | 2.52（b261 **全批**值，含规划+后测） | **不可用于排期**：它把每批固定成本摊进了行单价 |
| `s/文件` | 50.4（b261 实测）/ 20.6（全历史 68 文件均值）/ 14.9（b245–b247） | 只作每批诊断，**不作产能依据** |

剩余（`b264` 后 **916 文件 / 6,425 行**）按**待改行数**折算（不是文件数 × `s/文件`）：

```text
待改行数   6,824 行          （b261 收口后、b262 选片前）
点估计     6,824 × 2.52 s            = 17,196 s ≈ 4.78 h
区间       6,824 × 0.85 – 2.85 s     = 5,800 – 19,448 s ≈ 1.61 – 5.40 h
平均密度   6,824 / 935 = 7.30 行/文件 → 18.4 s/文件（只在该密度下成立）
b263 后    6,524 × 2.52 s            = 16,440 s ≈ 4.57 h（区间 1.54 – 5.16 h；920 文件 / 6,524 行）
b264 起    6,525 × 2.52 s            = 16,443 s ≈ 4.57 h（区间 1.54 – 5.16 h；921 文件 / 6,525 行；行口径）
b264 后    6,425 × 2.52 s            = 16,191 s ≈ 4.50 h（区间 1.52 – 5.09 h；916 文件 / 6,425 行）
b265 后    6,325 × 2.52 s            = 15,939 s ≈ 4.43 h（区间 1.50 – 5.01 h；911 文件 / 6,325 行）
b266 起    6,325 × 2.17 s            = 13,725 s ≈ 3.81 h（中位数口径；区间 1.90 – 3.04 → 3.34 – 5.34 h）
b266 后    6,225 × 2.61 s            = 16,247 s ≈ 4.5 h（干净批上下界 1.90 – 3.96 → 3.3 – 6.8 h；**排期一律报区间，不报单点**）
```

> 排期两条禁令：① 不用 b261 / b262 的速率外推总工期（最快样本不代表分布）；② 不用 2.17 作分母（仅三批窗口）。
> 落笔段 `s/行` 四批单调上升（1.90 → 2.17 → 3.04 → 3.96），若难度递增成立，中位数会低估后半程。

> `b264` 起 `6,525` 与 `921` 由 `capacity-estimate.mjs` v2 按行口径实测（`ALIGNED acct_remain=6525 pool_remain=6525 diff=0`）；
> `b264` 后同件实测 `ALIGNED acct_remain=6425 pool_remain=6425 diff=0`（`done 996 + remain 6,425 = 7,421`）。
> `b265` 后同件实测 `ALIGNED acct_remain=6325 pool_remain=6325 diff=0`（`done 1096 + remain 6,325 = 7,421`）。
> `b266` 后同件实测 `ALIGNED acct_remain=6225 pool_remain=6225 diff=0`（`done 1196 + remain 6,225 = 7,421`）。
> **收口判据（b265 定稿，见 `ZC-deep-b265.md` §9；A4 为 b311 增补）**：A1 `REMAIN=0`、A2 `done + remain == 7,421`、A3 `ledger-assert PASS`、
> **A4 三数闭合：`done 实际落笔 + Σ 池内自清 + remain == 7,421`**，四条同时成立才算收口，缺一不许写「已完成」。
> A4 的差值必须逐行对到 `POOL-SELF-CLEAR.tsv`，不许用「差 N 已知」放过（理由与量化见 §12.4）。`7,421` 是 `packages,apps,docs/knip` 三个根的 baseline weak 并集（1,007 文件），
> 域一变（加减根/排除项/换基线）三个数都不可比。
> **A2 只对池内成立（b279 量化；b281 定案：明确排除，不纳入）**：池 = 可改写集（基线 diff 的 `+` 行 ∩ 本线 blame）。
> **跨批数字引用纪律（b286 起）**：池外、全仓 weak、`remain` 这类跨批数字，引用时必须带 `post-bXXX` 快照标签；
> 两个快照相减必须写明区间（如 `post-b284 → post-b285`），不得把不同快照的差值当成单批增量（b285 的 `3284` 误读即此）。
> 池外另有 **3,284 行 / 1,308 文件** weak（`post-b279`，b279–b283 四批同值；基线同号 2,678/1,007、行号漂移 601/307、跨行无法归一 5 行），
> **不纳入 `remain`**；全仓 weak（b280 后 8,117 行 / 1,957 文件）只作**外部观测**与分母，不作排期依据。
> 理由：池外主体是上游英文注释与结构性行，本线没有「改写但不改语义」的权限；纳入会把 4,833 的 `remain` 抬到 8,117，
> A2 换分母的同时 `done` 的语义也被稀释（同一行既可能是本线债、也可能是上游文本）。
> 代价必须写明：这 3,284 行（`post-b279`）**永久不排期**，用「全仓 WEAK − pool_remain」持续观测差额，不把它写成 0。
> 任何池外行若被顺带改写，按 `self-clearing` / `pool-out` 登记，不改口径。
> A2 恒等式完整写法：`done + remain == 7,421`，**该恒等式只对池内成立，池外 3,284 行（`post-b279`）另计**。
> 见 `ZC-deep-b279.md` §9。
> **禁止用「池清零」表述「全仓注释完成」**：当批文件集内仍有 4,911 个无整行注释单元，属未承诺范围。
> **权威计数器定稿（b265）**：收口判「清零」只用这一条（`packages,apps,docs/knip` 同域）。
> `6,476` 系列（b261–b264 的 `8acd208e/0cab755e/e3116a93/2e779933` 四时点）是 `packages,apps` 投影，
> 与权威数差 49（`docs/knip` 4 文件 16+13+12+8），**不可与权威数相减**。
> `b263` 及以前的 `920 / 6,524` 是整文件记账的旧值，少算 `cuaDetails.tsx:14` 这 1 行，历史行保留不改。
> **语义抽检口径（2026-11-11，`ZC-semantic-audit-01.md`）**：`done` 数只在「已写入行数」意义上使用，
> 口径写作「已写入 N 行，其中 10 行经 N/P 双读，fail 1」；**抽检 fail 率不参与 `remain` 计算**，
> 不产生回修工作量。`1/10` 的 95% 精确区间约 `0.25%–44%`，不得写成「10% 错误率」，
> 也不得写成「质量已验证」。与 valkey 的 `8/10` 不可并排读：本线是「有原文的 1→1 改写」，
> valkey 是「新写 counter 句」，对象风险不同，数字差一个数量级不代表方法不稳。

**b263 更正（把「单位错」与「数值错」分开）**：

- **单位错**：`s/文件` 不能乘文件数，也不能乘批数——这两种乘法都在默认「每文件行数恒定」。
  `s/文件 = 行/文件 × s/行`，装箱密度一变它就整体平移。作废的是这个用法。
- **数值错**：`20.6` 隐含 `20.6 ÷ 2.52 = 8.2 行/文件`，而 PLAN 复算的整体密度是 `6,824 / 935 = 7.30 行/文件`，
  偏差 `12%`。所以 `20.6` 本身不是错值，只是对应另一个密度。
- 结论：`s/文件` 不再作产能依据（产能按 `s/行 × 待改行数`）；`20.6` 保留为**粗估交叉验证**，
  用它乘文件数得到的量级可用，但必须注明**误差 12%**，不能当点估计。
- **历史估值不整体作废**：当时按「每文件行数」记账的批次墙钟仍可复算（`s/文件 ÷ s/行` 能还原密度），
  作废的只是「乘文件数」这一步。
- 限定成「每文件 14–16 行时可用」也不成立：`14–16 × 2.52 = 35.3–40.3 s/文件`，与 20.6 差一倍；
  该常数唯一自洽的密度是 8.2，而 PLAN 装箱是 7.30，既不是 8.2 也不是 14–16。

**阈值适用范围**（b252 澄清 + b262 收口）：`s/行` 是唯一可跨批比较的阈值，802 解包批与常规批同一套
`0.85–2.85`；偏离超 50%（<0.85 或 >2.85）才按里程碑单发报告。`s/文件` 的 `14.9 ±50%`（7.45–22.35）
随作废一并停用。

### 2.4 `s/文件` 历史对照（b264 从批次台账移出，只留在这里）

`b264` 起批次台账**只记 `s/行`**（含「仅改写段」），`s/文件` 与「隐含密度」两行撤掉，原因见下。
历史值集中在本节，供复算，不得回流到批次台账。

| 批次 | `s/文件`（仅诊断） | 备注 |
| --- | ---: | --- |
| b240 | 32.5 | 合并试跑 6 文件 |
| b241 | 41.7 | 6 文件 |
| b242 | 24.9 | 6 文件 |
| b243 | 10.8 | 6 文件 |
| b244 | 21.9 | 8 文件试批（结论：无摊薄收益） |
| b245 | 23.8 | 5 文件 |
| b246 | 12.2 | 5 文件 |
| b247 | 8.7 | 5 文件 |
| b261 | 50.4 | 5 文件 / 100 行，`s/行 2.52`，密度 20.0 |
| b263 | 166.2 / 67.0 | 5 文件 / 100 行；分子含全量前后测扫描，分母口径见 §2.3 |
| 全历史均值 | 20.6（68 文件） | 隐含密度 8.2 行/文件，与 PLAN 的 7.30 差 12% |

> `s/行` 与逐批时长只在 `ZC-deep-bNNN.md` 的「计时」小节；本表只留 `s/文件` 这一个作废口径的历史值。

**12% 密度偏差**：全历史均值 `20.6 s/文件` 的隐含密度是 `20.6 ÷ 2.52 = 8.2 行/文件`，
而 PLAN 装箱的整体密度是 `6,824 ÷ 935 = 7.30 行/文件`，偏差 `(8.2 − 7.30) ÷ 7.30 = 12%`。
所以 `20.6` 不是错值，它对应的是「每文件 8.2 行」这个并不存在的批次形状。

**用法禁令**：
1. **不得乘文件数**：`总时长 ≠ 剩余文件数 × s/文件`。`s/文件 = 行/文件 × s/行`，密度一变整体平移。
2. **不得乘批数**：`总时长 ≠ 批数 × 每批耗时`，那是「批变大、时间不变」的假设，b244 的 8 文件反例已否掉。
3. **不得作为跨批可比阈值**：`s/文件` 的 `14.9 ±50%` 已随 b262 停用；跨批只认 `s/行`。
4. 允许的唯一用法：同一批内作为复算校验（`s/文件 ÷ s/行` 还原该批密度），或注明「误差 12%」的粗估量级。




### 2.5 落笔预检件（precheck-assert）

| 文件 | sha1（blob） | 作用 | 首个使用批次 |
| --- | --- | --- | --- |
| [`precheck-assert.mjs`](precheck-assert.mjs) | `60566545c001` | 把「预检必须跑最终正文」从纪律改成**工具约束**：两阶段对同一次落笔做断言。`--record` 取 `git diff -U0 <base> -- <files>` 的新增注释行跑 `judgeEntries`，命中必须为 0，并写快照（`base` + 文件清单 + `sha` + 逐行 entries）与 `t-record` 时间戳；`--verify` 重算后**先逐条比对 file / line / 正文原始字节**，不一致即 `exit 7` 并打印前 5 条 `DRIFT`，再要求命中为 0 否则 `exit 1`；通过后写 `t-verify` 并打印 `tail` / `落笔段`。b273 起新增 `--start`（起笔戳）与 `--order`（对 git 提交时间做 `t-start < t-record ≤ t-verify < commit_time` 顺序断言，并打印两段墙钟）。**b274 起 `--record` 必须带 `--plan <tsv>`**：`git diff -U0` 的旧行号集合与新增行号集合分别与 plan 的 `(file, baseLine)` 双向求差，越界 / 漏改非空即 `exit 8` 并逐行打印 `文件:行 + 原文`；唯一放行口是 `--allow <file>`（逐行 `file:line`，只收已登记的池外自清行）；`--verify` 传 `--plan` 时同样复算。用法错 `exit 2`。**b275 起新增 `--scope --plan <tsv>`**：同一套 plan-vs-diff 断言，**只报不拦**（永远 `exit 0`）。**b281 起新增「碰过又还原」检测**：`--start` 对 `git ls-files` 全量拍 mtime 到 `<snapshot>-mtimes.json`；`--record` / `--verify` 复拍，凡 mtime 变了且 `git diff --quiet HEAD -- <file>` 干净的文件即命中，打印 `PRECHECK MTIME touched_restored=N` 与 `MTIME HIT <file>`（最多 12 个），**只计不拦**，用于补 `write_phase`——b280 的 3 行只有人能记，这条把它变成工具读数。**b282 起补上「行级」中间层**：`--watch --plan <tsv>` 每 10 s 对 `--files` 里的文件拍一次**非 plan 行**的 sha（1→1 改写保证行号不变，故非 plan 行必须逐字节恒定），追加到 `writes-<batch>.tsv`；`--record` / `--verify` 末尾按「start = `git show <base>:<file>` 与 record = 工作树」两种合法 sha 复核，出现第三种即 `PRECHECK LINE-DRIFT files=N` + `LINE-DRIFT HIT <file>`（只报不拦）。同时 `--plan` 指向的文件不存在时**一律 `exit 2`**（此前缺失只会让 ACCT 差值报假信号）。**b284 起加第 8 行门禁**：`--record` / `--verify` 按 `-U0` hunk 配对删除行与新增行，只比两侧都是注释的行，比较**前导空白字节**与**行尾字节**，输出 `PRECHECK INDENT indentChanged=<n> eolChanged=<n>`，任一非零 `exit 1`；「替换前」用 `git cat-file --filters <base>:<file>` 取工作区形态（CRLF 树拿到 CRLF），负控 `indentChanged=14 eolChanged=96`、正控 `0/0`。 | **b269**（计时：**b272**；三量：**b273**；集合断言：**b274**；`--scope`：**b275**；`--start` 脏树拦截 `exit 6`：**b279**；mtime：**b281**；`--watch` / LINE-DRIFT / plan 缺失 `exit 2`：**b282**；第 8 行门禁：**b284**） |

- 起因：b268 的**首稿与预检稿不同**——预检跑的是「spawn 用参数数组形式，避免 shell 转义。」，落笔时改写成
  「spawn(file, args) 不经 shell…」，ASCII 逗号被 L 判据算作分隔符，门禁首轮 1 处命中（`ZC-deep-b268.md` §5）。
- 负控（b268 收尾实测）：对最终正文 record（`n=100 hits=0 sha=556bde3c2cc6`）后把
  `clipboard-image.ts:266` 改回「都原样传入」→ `DRIFT #32` + `PRECHECK VERIFY FAIL`，`exit 7`。
- **sha 覆盖范围（b270 前修订）**：`sha` 只覆盖**正文字节**——每个新增注释行的原始文本（去掉前导 `+`，
  保留行内与行尾空白）按行序拼接后取 sha256，**不含文件路径、行号与时间戳**。逐条比对仍含 file / line。
- 负控三条（b270 前实测，同一 worktree，`record n=1 sha=31aead13e216`）：
  | 改动 | 期望 | 实测 |
  | --- | --- | --- |
  | 改一个字（「向上」→「向下」） | exit 7 | `DRIFT #0` + exit 7 |
  | 只加行内空白（插入两个空格） | exit 7 | `DRIFT #0`（原文用 `JSON.stringify` 展示）+ exit 7 |
  | 只改换行（一行拆成两行） | exit 7 | `DRIFT #0/#1`，`record 1 行 / now 2 行` + exit 7 |
  | 回滚到记录原文 | exit 0 | `PRECHECK VERIFY n=1 hits=0 sha=31aead13e216 OK` |
- 已知边界：CRLF/LF 切换由 `git diff` 的文本行切分归一到 `\r?\n` 之后才进正文，因此**换行符类型本身不在
  sha 内**；拆行、并行走条目数/正文，仍会被拦住。
- **mtime「碰过又还原」正负控（b281 实测，临时 worktree `_wt_b281_pre`，前缀 `ctl81`，20,068 文件）**：
  | 控 | 操作 | 期望 | 实测 |
  | --- | --- | --- | --- |
  | 负控 1 | 起笔后不改动，直接 `--record` | 0 | `MTIME touched_restored=0`，`touched_restored=0` |
  | 负控 2 | 真实内容改动（非本批清单文件追加一行） | 不计「还原」 | `touched_restored=0`（该文件 `git diff --quiet HEAD` 不干净） |
  | 正控 | 只 `touch` 一个跟踪文件、内容不变 | 1 + 文件名 | `PRECHECK MTIME touched_restored=1（mtime 变了但内容 == HEAD，计入 write_phase）` + `MTIME HIT packages/ui/src/lib/mermaidRenderBudget.ts`，`exit 0` |
  这是**文件级**检测：只覆盖「整文件回到 HEAD」。脏文件内部的行级还原（同文件其余行仍是真改写）看不到——
  b280 的 3 行、b281 的 `embeddedBrowserHelpers.ts:111` 都属于这类，仍按人工自查计入 `write_phase`（`ZC-deep-b281.md` §7.1）。
- **行级「改过又还原」的中间层正负控（b282 实测，worktree `_wt_b282_ctl`，`mermaidRenderBudget.ts` 2 行 plan）**：
  | 控 | 操作 | 期望 | 实测 |
  | --- | --- | --- | --- |
  | 负控 | 只改 plan 内 2 行，不改其他行 | 0 | `PRECHECK LINE-DRIFT samples=7 files=0`，`line_drift=0` |
  | 正控 | 另把 1 行非 plan 注释改成 `DRIFT PROBE`、停留 5 s 再还原 | 1 + 文件名 | `PRECHECK LINE-DRIFT samples=8 files=1` + `LINE-DRIFT HIT …/mermaidRenderBudget.ts 非 plan 行样本 sha=2358fa1b 出现 3 次`，`line_drift=1`，`exit 0`（不拦） |
  | plan 缺失 | `--record --plan <不存在的文件>` | exit 2 | `PRECHECK RECORD FAIL 缺 plan 文件 …：登记表未落盘，改动行集合与 ACCT 都会指向错误方向` + `exit 2` |
  **残留边界（不写「已解决」）**：采样周期 10 s，因此只能抓**持续超过 10 s** 的漂移；
  10 s 内改完又还原（b281 的 `embeddedBrowserHelpers.ts:111` 就属此类）拍不到，仍靠人工自查记账。
  另外它依赖「1→1 改写、行号不变」这一批次契约。**行数一旦改变，责任在 `--record` 的集合同构断言**
  （越界/漏改 + `exit 8`），watcher 的位移只是**冗余路径：真触发说明契约已先破**，不作为第二条防线（见 §2.6 ④）。
  更彻底的做法是所有写操作走统一包装（`zc-write` 落 `writes.log`），那会改工作方式，本轮不做。
- **边界 × 门禁矩阵（b282 定稿，b284 按四条边界重新编号）**：把「改过又还原 / 行数位移」拆成可判定的失败模式，
  逐条写明谁负责、用什么读数拦；**同一行不允许出现两个工具都说「不是我的责任」**。
  编号回到 b281 提出的四条边界，避免「③ 文件级」与「③ 瞬时」两种编号并存（b283 台账曾因此写错）。

  | # | 失败模式 | 谁拦 | 什么读数 / 退出 | 是否已被别的门禁覆盖 | 结论 |
  | --- | --- | --- | --- | --- | --- |
  | ① | 非 plan 行在 10 s 内改完又还原（瞬时） | **无** | — | 否；未完全还原的残留会进最终 diff，被 ②④ 与七行门禁兜住 | **唯一真空 → 已接受风险** |
  | ② | 行数改变导致整体位移 | **`--record` 集合同构断言**（主） | `PRECHECK RECORD FAIL 改动行集合 ≠ plan 行集合：越界 X / 漏改 Y`，`exit 8` | 是：发生在 watcher 复核与七行门禁之前 | 有主；watcher 的位移读数降级为「冗余路径，真发生说明契约先破」 |
  | ③ | 文件级还原（mtime 变、内容 == HEAD） | `--record` / `--verify` 的 mtime 复拍 | `PRECHECK MTIME touched_restored=N` + `MTIME HIT <file>` | 是——mtime 就是为文件级还原设计的 | **已覆盖**，计入 `write_phase`（只计不拦） |
  | ④ | 行级还原（非 plan 行，持续 >10 s） | `--watch` 采样 + `--record` 的 LINE-DRIFT 复核 | `LINE-DRIFT samples=N files=M` + `sha=… 出现 k 次` | 是（mtime 看不到行级，watcher 是唯一证据） | 有主，计入 `write_phase`（只计不拦） |

  - 编号更正（b284）：b281 说「mtime 覆盖文件级还原」是对的；b283 台账把「③」写成文件级还原又说它是唯一真空，
    是把 ③ 与 ① 串了号。**真空只有 ①（瞬时还原），③ 已被 mtime 覆盖，④ 已被 watcher 覆盖。**
  - ② 的依据（不是推测）：`--record` 先跑 `scopeCheck()`，把「diff 旧行 key」与「diff 新行 key」分别与 plan 行集合求差；
    插入一行会让该 hunk 之后所有新行号整体 +1，`outNew` 立刻非空；删一行则命中 `missing`；一行拆两行则第二行越界。
    三种都 `exit 8`，且发生在判据之前。所以 `writes-<batch>.tsv` 的「行数改变」注释不是第二条防线，
    而是**冗余读数**——真触发时说明 `--record` 已先红，契约（`+N−N`、1→1）在更早的环节就破了。
    `zc-commit` 的 `numstat: +N −M` 只是打印，不对比；注释行 1→2 若两行都过判据它不会红，**不能把它当 ② 的责任人**。
  - ① 的接受理由：瞬时改完又还原**净效果为零**（最终树与 HEAD 一致），且若没有完全还原，
    残留必然进入最终 diff，被 ② 的集合同构或 `zc-commit` 的七行门禁拦下。真正的损失只有过程纪律，
    没有可交付物风险。唯一能闭合它的办法是所有写操作走统一包装（`zc-write` 落 `writes.log`），
    那是改工作方式，本轮明确不做；`--watch --interval` 可调小以缩小窗口，但**不承诺闭合**。
  - 附：另两类失败模式不属于这四条边界，单列以免混号——
    ⑤ `--files` 之外的文件被写：靠下一批 `--start` 的脏树断言延迟一批发现（`exit 6`），半真空，已接受；
    ⑥ 判据漏判：`zc-commit` 判据 + 15 文件 `weak-guard`，有主但为近似守卫（三条盲区见 §2.4）。
- **第 8 行门禁：缩进 / 行尾（b284 起，`precheck-assert` 的 `--record` 与 `--verify`）**：
  b283 的逐行替换脚本把整行重建，14 条原本有缩进的注释被抹成顶格、96 个改动行的行尾从 CRLF 变成 LF，
  而 `--record` 只比正文字节、七行门禁只判行分类，**两者都没报**。现在补成第 8 条读数：
  `PRECHECK INDENT indentChanged=<n> eolChanged=<n>`，任一非零 `exit 1`。
  - 判据：按 `-U0` 的 hunk 把删除行与新增行按序配对（数量不等交给集合断言 ②），只比**两侧都是注释**的行；
    分别比前导空白字节与行尾字节。
  - **「替换前」基准（b289 起改）**：取 `--start` 时拍的**实盘逐行快照** `<batch>-lines.json`
    （每行 `<c|x>|<lead>|<eol>|<sha16>`），不再用 `git cat-file --filters <base>:<file>` 重建。
    旧基准依赖 `core.autocrlf` / `.gitattributes`，同一份代码换个配置判定就翻：b288 的 `cron.ts` 实盘 LF、
    重建 CRLF，15 行 `eolChanged` 全是假阳性。新基准只描述「这一批开始时磁盘上真实的样子」，
    并与 `LINE-DRIFT` 共用同一份快照（同一套行元组、同一个哈希定义），少一处不一致的机会。
    缺 `<batch>-lines.json` 时 `--record`/`--verify` 直接 `exit 2`，不允许退回旧基准。
  - 负控（修复前脚本，worktree `_wt_b283_ctl8` 重放 b283）：`indentChanged=14 eolChanged=96` + `exit 1`；
    正控（修复后脚本，保留原前导空白 + 原换行符）：`indentChanged=0 eolChanged=0` + `exit 0`。
  - b289 基准负控（`_nc_b289` 临时仓，`.gitattributes` 强制 `eol=crlf`、实盘 481 行全 LF，改 15 行注释正文）：
    新版 `indentChanged=0 eolChanged=0` + `exit 0`；旧版（同一 worktree、同一 plan）`eolChanged=15` + `exit 1`。
    证明改的是基准来源，不是把阈值放宽。
  - **SAME 门禁（b289 起）**：`PRECHECK SAME same_rewrites=<n>`，plan 行与实盘基准逐字相同即 `exit 1`。
    b288 有 2 行「替换文案与原文逐字相同」（apply 报 `SAME` 后跳过），判据、缩进、行尾、集合断言都只是笼统的
    「漏改 / 未落笔」；SAME 直接点出是哪几行没改写。它排在集合断言之前，就是为了先给精确行号。
    可达性负控：把 plan 中 1 行还原成原文 → `SAME HIT cron.ts:1` + `exit 1`。
  - 对已提交的 b283 复测：抓出 `indentChanged=12 eolChanged=48`（`b283-fix-indent.mjs` 把 12 条本该顶格的
    注释加了缩进、且只统一了 3 个文件的行尾），修正后 `0 / 0`。`eolChanged` 只存在于工作树，
    提交后 git 按 `autocrlf` 归一，复检必为 0；**它拦的是「提交前那一刻的混合行尾」**。
  - apply 实现同步改为「取原行前导空白 + 原换行符」（`b283-apply.mjs` 的修复版），但门禁是底线，模板只是习惯。
  - **历史回溯（b285 前置）**：`history-indent-audit.mjs` 用同一判据回放 b261–b284 的 26 笔提交，
    b282 `indentChanged=20`（3 文件纯 `//` 行缩进，已由 `6b765c30` 修回）、b283 `12`（已由 `5522d403` 抵消），
    其余 23 批为 0；EOL 列因 `autocrlf` 结构性恒 0（`rawCrlf=0`），工作树残留另查（b282 三文件已归一 CRLF）。
    详见 [`ZC-deep-history-audit.md`](../ZC-deep-history-audit.md)。
- **计时三量并列（b273 起）**：
  | 量 | 起点 → 终点 | 谁打点 | 覆盖 |
  | --- | --- | --- | --- |
  | `batch_wall_total` | 上一提交时间 → 本提交时间（`git log --format=%ct`，默认上一提交 = `<commit>^`，可用 `--prev` 指定） | git | 整批墙钟，含**批间非改写动作**（尺子升级、台账提交） |
  | `batch_wall_controllable` | `t-start` → 提交时间 | 工具 + git | 本批自己可控的一段（改写 + 预检 + 门禁 + 提交） |
  | 落笔段 | `t-start` → `t-verify` | 工具 | 改写 + 预检 + 返修（不含提交） |
  | `tail` | `t-record` → `t-verify` | 工具 | 仅末段（最后一次预检 → verify） |

  **两段墙钟必须并列报（b274）**：`total` 含批间非改写动作，**不得除以行数当改写成本**；
  `controllable` 只用于**同一批内部的横向比较**。**报工时一律用端到端 `s/行`**
  （`(台账提交 − t-start) / 登记行`），因为 `controllable` 不含门禁复跑、返修、快照与台账，
  会低估约 1.7 倍（b286 实测 3.26 vs 5.67）。
  b273 实测 `total=943.0s` / `controllable=195.0s`，两者差 748s 全是 `b8843802` 的尺子升级；
  b274 `total=662.0s` / `controllable=210.0s`；b275 `total=546.0s` / `controllable=202.0s`；
  b276 `total=253.0s` / `controllable=127.0s`；b277 `total=412.0s` / `controllable=209.0s`；
  b278 `total=277.0s` / `controllable=230.3s`；b279 `total=181.0s` / `controllable=125.0s`；
  b280 `total=243.0s` / `controllable=174.1s`；b281 `total=237.0s` / `controllable=224.0s`；
  b282 `controllable=108.8s`（`total` 19,241 s 因关机中断不可比，不进入样本）；
  b283 `total=222.0s` / `controllable=203.0s`；
  b284 `total=210.0s` / `controllable=83.0s`（落笔段 41.0 s，但 100 条正文在 `--start` 前已写好，
  该样本**不进入中位数**，单列为「测量口径失效」）；
  b285 `total=411.0s` / `controllable=98.0s`（落笔段 41.1 s，同样「正文先于起笔完成」，**不进入中位数**）；
  b286 起执行新口径，首个样本 `total=362.0s` / `controllable=316.0s`（落笔段 215.7 s，**含起草时间**，
  `s/行=3.26`，`record_runs=2`）；b287 第 2 个样本 `total=186.0s` / `controllable=149.0s`
  （落笔段 109.5 s，`s/行=1.62`，`record_runs=1`）；b288 第 3 个样本 `total=252.0s` /
  `controllable=231.0s`（落笔段 201.3 s，`s/行=2.57`，`record_runs=2`——首次 `--record` 被第 8 行门禁
  以 `eolChanged=15` 拦下，`cron.ts` 工作树为 LF 而 `git cat-file --filters` smudge 出 CRLF，统一回 CRLF 后通过）；
  b289 第 4 个样本 `total=208.0s` / `controllable=149.2s`（落笔段 116.0 s，`s/行=1.66`，`record_runs=1`，
  首轮预判 7 hits（1 W + 6 L）返修一轮后 0，第 8 行门禁在新实盘基准下 `0/0`——同批不再复现 b288 的假阳性）；
  b290 第 5 个样本 `total=233.0s` / `controllable=199.2s`（落笔段 164.6 s，`s/行=2.21`，`record_runs=1`，
  首轮预判 6 hits（3 W + 3 L）返修一轮后 0，第 8 行门禁 `0/0`、`SAME 0`）；
  b291 第 6 个样本 `total=221.0s` / `controllable=155.0s`（落笔段 135.9 s，`s/行=1.60`，`record_runs=1`，
  首轮预判 9 hits（6 W + 3 L）返修一轮后 0，池外自清 3）；
  b292 第 7 个样本 `total=133.0s` / `controllable=110.0s`（落笔段 89.4 s，`s/行=1.12`，`record_runs=1`，
  首轮预判 10 hits（8 W + 2 L）返修一轮后 0，无自清）；
  b293 `total=202.0s` / `controllable=95.0s`（落笔段 64.8 s，`s/行=0.97`，`record_runs=1`，
  首轮 2 hits（1 W + 1 L）返修一轮后 0，池外自清 2；**起草早于 `--start`，与 b284/b285 同列不进入中位数**）；
  b294 `total=199.0s` / `controllable=117.0s`（落笔段 19.4 s，`s/行=1.19`，`record_runs=1`，
  首轮 6 hits（6 W）返修后 0，无自清；**同样起草早于 `--start`，不进入中位数**）；
  b295 `total=123.0s` / `controllable=47.0s`（落笔段 23.4 s，`s/行=0.48`，`record_runs=1`，
  首轮 8 hits（5 W + 3 L）返修后 0，池外自清 1；**起草早于 `--start`，不进入中位数**）；
  b296 `total=156.0s` / `controllable=80.0s`（落笔段 57.5 s，`s/行=0.88`，`record_runs=1`，
  首轮 10 hits（8 W + 1 L + 1 POEM）返修两轮后 0，无自清；**起草早于 `--start`，不进入中位数**）；
  b297 `total=177.0s` / `controllable=131.0s`（落笔段 108.9 s，`s/行=1.44`，`record_runs=1`，
  首轮 5 hits（4 W + 1 L）返修后 0，池外自清 2；**起草早于 `--start`，不进入中位数**）；
  b298 `total=190.0s` / `controllable=145.0s`（落笔段 120.9 s，`s/行=1.61`，`record_runs=1`，
  首轮 4 hits（3 W + 1 L）返修后 0，无自清，含 1 次 BOM 越界已自纠；**起草早于 `--start`，不进入中位数**）；
  b299 `total=125.0s` / `controllable=102.0s`（落笔段 77.8 s，`s/行=1.12`，`record_runs=1`，
  首轮 4 hits（3 W + 1 L）返修后 0，无自清；**起草早于 `--start`，不进入中位数**）；
  b300 `total=196.0s` / `controllable=124.0s`（落笔段 95.6 s，`s/行=1.36`，`record_runs=1`，
  首轮 6 hits（5 W + 1 L）返修后 0，池外自清 1；**起草早于 `--start`，不进入中位数**）；
  b301 `total=228.0s` / `controllable=111.0s`（落笔段 88.5 s，`s/行=1.11`，`record_runs=1`，
  首轮 2 hits（2 W）返修后 0，无自清；**起草早于 `--start`，不进入中位数**）；
  b302 `total=137.0s` / `controllable=133.0s`（落笔段 106.6 s，`s/行=3.69`，`record_runs=1`，
  首轮 2 hits（2 L）返修后 0，无自清；**30–40 行小批新节奏 n=1，起草在 `--start` 后，合法样本但与小批混算无意义**）；
  b303 `total=89.0s` / `controllable=63.0s`（落笔段 39.4 s，`s/行=1.75`，`record_runs=1`，
  首轮 3 hits（2 W + 1 L）返修后 0，无自清；**小批 n=2，起草在 `--start` 后**）；
  b304 `total=232.0s` / `controllable=98.0s`（落笔段 62.5 s，`s/行=2.72`，`record_runs=2`，
  首轮 0 hits，无自清；**`record_runs=2` 来自 runner 解析缺陷续跑，不是判据返修；total 含工具开发**）；
  b305 `total=64.0s` / `controllable=50.0s`（`s/行=1.39`，`record_runs=1`，首轮 0 hits，无自清；
  **`apply-run` + `gate-run` 首次单次跑完，无 Edit 返修**）；
  b306 `total=219.0s` / `controllable=98.0s`（`s/行=2.72`，`record_runs=1`，首轮 0 hits，无自清；
  **total 含批间 runner 失败闭合改造与 `--from verify` 续跑，不属稳定态**）；
  b307 `total=198.0s` / `controllable=116.0s`（`s/行=3.22`，`record_runs=1`，首轮 2 hits 已返修；
  **失败闭合版 runner 首次五闸全绿从头跑完**；池外自清 1 行不扣配额）；
  b308 `total=115.0s` / `controllable=77.0s`（`s/行=2.14`，`record_runs=1`，首轮 2 hits 已返修；
  **十一闸首跑，`pool-diff` 首次进常规流程**）；
  b309 `total=171.0s` / `controllable=46.1s`（`s/行=1.28`，`record_runs=1`，首轮 3 hits 均 `W/单行无信息`
  并在 `--record` 前返修；**批次前先做 6 处批次外修订，本批无自清**）；
  b310 `total=136.0s` / `controllable=40.0s`（`s/行=1.11`，`record_runs=1`，首轮 1 hit `W/单行无信息`；
  **`pool-diff` 首跑因池外自清未登记判红，登记后补跑 PASS**）；
  b311 `total=156.0s` / `controllable=53.0s`（`s/行=1.47`，`record_runs=1`，
  首轮 3 hits：2 `W/单行无信息` + 1 `L/无信息列举`，均在 `--record` 前返修；
  **`pool-diff` 首跑因池外自清 `sourceServerManagementService.ts:354` 未登记判红，登记后补跑 PASS**）；
  b312 `total=164.0s` / `controllable=35.0s`（`s/行=0.97`，`record_runs=1`，首轮 **0 hit**；
  **`pool-diff` 首跑因块尾 `*/` 自清 `SavedWorkflowMoveDialog.tsx:72` 未登记判红，登记后补跑 PASS**）；
  b313 `total=132.0s` / `controllable=44.0s`（`s/行=1.22`，`record_runs=1`，首轮 1 hit `L/无信息列举`；
  **自清分流上线**：`auto_self_clear=0`，人工登记 1 条（`zip-source.ts:312`，blame 本线但早于池基线，
  按规则②不自动放行），补跑 `allowed=41` PASS）。
  b314 `total=192.0s` / `controllable=128.0s`（`s/行=3.88`，`record_runs=1`，首轮 2 hits 已返修；
  **池内候选只有 11/10 两档、4 文件最小 43 行，故本批 3 文件 33 行**；无自清，
  `pool-diff removed=33 added=0 allowed=38 auto_self_clear=0` 首跑 PASS）。
  新口径单列「n=1 … n=7」，**n=5 起可报中位数（当前 1.66 s/行），但仍不做新旧口径快慢比较**（两者分子不同），
  b315 `total=115.0s` / `controllable=89.0s`（`s/行=2.70`，`record_runs=1`，首轮 1 hit `W/单行无信息` 已返修；
  **首跑 `scope` 判红 3 行越界**（邻行 96–98 被连带改写、不在 plan），逐字还原后重跑全绿；
  本批 33 行为 11/11/11 档，池内候选仍无 1–9 行小文件；无自清，`pool-diff removed=33 added=0 allowed=38 auto_self_clear=0`）。
  b316 `total=138.0s` / `controllable=114.0s`（`s/行=2.59`，**浮动批规模 33–44 首次生效：4 文件 44 行**，
  `record_runs=1`，首轮 1 hit `L/无信息列举` 已返修；无越界、无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`）。
  b317 `total=114.0s` / `controllable=85.0s`（`s/行=1.93`，4 文件 44 行，`record_runs=1`，
  首轮 1 hit `L/无信息列举` 已返修；无越界、无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`）。
  b318 `total=75.0s` / `controllable=68.0s` / `批墙钟=158s`（`controllable/行=1.55`、`批墙钟/行=3.59`，口径见 §6.2），
  4 文件 44 行，首轮 0 hit；无越界、无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`。
  b319 `total=313.0s` / `controllable=214.0s` / `批墙钟=556s`（`controllable/行=4.86`、`批墙钟/行=12.64`），
  4 文件 44 行，首轮 2 hit `L/无信息列举` 已返修；无越界、无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`。
  b321 `total=194.0s` / `controllable=166.0s` / `批墙钟=379s`（`controllable/行=3.77`、`批墙钟/行=8.61`），
  4 文件 44 行，首轮 0 hit；pool-diff 首跑因插点缺 `b320-repo-post.txt` 补跑后 PASS，`removed=44 added=0 allowed=49 auto_self_clear=0`。
  b322 `total=164.0s` / `controllable=158.0s` / `批墙钟=363s`（`controllable/行=3.76`、`批墙钟/行=8.64`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 42 行（11/11/10/10），首轮 2 hit `L/无信息列举` 已返修；
  无越界、无自清，`pool-diff removed=42 added=0 allowed=47 auto_self_clear=0`；
  基准按新规则默认解析 `pre-weak=b321-repo-post.txt`（**未复制快照**，`--start` 前置校验上线后首批）。
  b323 `total=128.0s` / `controllable=121.0s` / `批墙钟=219s`（`controllable/行=3.03`、`批墙钟/行=5.48`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），
  首轮 5 hit（4 `W` + 1 `L`）已返修，其中 `title-generation-sidecar.ts` 的 165/166 属连带越界、返修时逐字还原；
  无自清，`pool-diff removed=40 added=0 allowed=45 auto_self_clear=0`，基准默认解析 `pre-weak=b322-repo-post.txt`。
  b324 `total=175.0s` / `controllable=127.0s` / `批墙钟=299s`（`controllable/行=3.02`、`批墙钟/行=7.12`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 42 行（11/11/10/10），首轮 0 hit；无越界、无自清，`pool-diff removed=42 added=0 allowed=47 auto_self_clear=0`，
  基准默认解析 `pre-weak=b323-repo-post.txt`；两个文件各留 1 行上游 weak（池外，未进 plan）。
  b325 `total=84.0s` / `controllable=77.0s` / `批墙钟=196s`（`controllable/行=1.93`、`批墙钟/行=4.90`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），首轮 1 hit `W/单行无信息` 已返修；无越界，
  `pool-diff removed=41 added=0 allowed=46 auto_self_clear=1`（**首次自动自清**：`pluginsMentionProvider.ts:51`，池外 + 上游 blame），
  基准默认解析 `pre-weak=b324-repo-post.txt`。
  b326 `total=90.0s` / `controllable=84.0s` / `批墙钟=164s`（`controllable/行=2.10`、`批墙钟/行=4.10`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），首轮 3 hit（2 `L` + 1 `W`）已返修；无越界、无自清，
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`，基准默认解析 `pre-weak=b325-repo-post.txt`。
  b327 `total=139.0s` / `controllable=107.0s` / `批墙钟=210s`（`controllable/行=2.68`、`批墙钟/行=5.25`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），首轮 0 hit；无越界、无自清，
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`，基准默认解析 `pre-weak=b326-repo-post.txt`。
  b328 `total=100.0s` / `controllable=71.0s` / `批墙钟=148s`（`controllable/行=1.78`、`批墙钟/行=3.70`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），首轮 0 hit；无越界、无自清，
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`，基准默认解析 `pre-weak=b327-repo-post.txt`。
  b329 `total=132.0s` / `controllable=119.0s` / `批墙钟=190s`（`controllable/行=2.98`、`批墙钟/行=4.75`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），首轮 1 hit（`L` 列举）返修后 0；无越界、无自清，
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`，基准默认解析 `pre-weak=b328-repo-post.txt`。
  b330 `total=98.0s` / `controllable=72.0s` / `批墙钟=134s`（`controllable/行=1.80`、`批墙钟/行=3.35`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 40 行（10/10/10/10），首轮 0 hit；无越界、无自清，
  `pool-diff removed=40 added=0 allowed=46 auto_self_clear=0`，基准默认解析 `pre-weak=b329-repo-post.txt`。
  b331 `total=107.0s` / `controllable=84.0s` / `批墙钟=178s`（`controllable/行=2.33`、`批墙钟/行=4.94`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 36 行（9/9/9/9），首轮 0 hit；`auto_self_clear=1`（`reminder.ts:228` 块尾相邻），池内自清仍 0，
  `pool-diff removed=37 added=0 allowed=43 auto_self_clear=1`，基准默认解析 `pre-weak=b330-repo-post.txt`。
  b332 `total=149.0s` / `controllable=92.0s` / `批墙钟=160s`（`controllable/行=2.56`、`批墙钟/行=4.44`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 36 行（9/9/9/9），判据首轮 0 hit，但 apply 多改 1 行已回退后过闸；无自清，
  `pool-diff removed=36 added=0 allowed=43 auto_self_clear=0`，基准默认解析 `pre-weak=b331-repo-post.txt`。
  b333 `total=163.0s` / `controllable=131.0s` / `批墙钟=258s`（`controllable/行=3.64`、`批墙钟/行=7.17`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 36 行（9/9/9/9），判据 0 hit，但 1 行改写后与原文逐字相同、靠 numstat 35/35 抓出补齐；无自清，
  `pool-diff removed=36 added=0 allowed=43 auto_self_clear=0`，基准默认解析 `pre-weak=b332-repo-post.txt`。
  b334 `total=153.0s` / `controllable=125.0s` / `批墙钟=203s`（`controllable/行=3.79`、`批墙钟/行=6.15`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 33 行（9/8/8/8），判据首轮 1 hit（L 无信息列举）改后 0 hit；无自清，
  `pool-diff removed=33 added=0 allowed=40 auto_self_clear=0`，基准默认解析 `pre-weak=b333-repo-post.txt`。
  b335 `total=229.0s` / `controllable=51.0s` / `批墙钟=1157s`（本批漏跑 `--start`，回退后重拍 `record_runs=2`，三个读数均不可比；墙钟含回退与回放），
  4 文件 33 行（9/8/8/8，其中 9 行档 `upOut=1`，批后留 1 行上游 weak），判据 0 hit；无自清，
  `pool-diff removed=33 added=0 allowed=40 auto_self_clear=0`，基准默认解析 `pre-weak=b334-repo-post.txt`。
  b336 `total=217.0s` / `controllable=172.0s` / `批墙钟=274s`（`controllable/行=5.21`、`批墙钟/行=8.31`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 33 行（8/8/8/9，其中 9 行档 `upOut=1`，批后留 1 行上游 weak），判据首轮 4 hit（L 列举）改后 0 hit；
  scope 首跑拦下 1 行池外误改（已还原，`record_runs=1`）；无自清，
  `pool-diff removed=33 added=0 allowed=40 auto_self_clear=0`，基准默认解析 `pre-weak=b335-repo-post.txt`。
  b337 `total=138.0s` / `controllable=112.0s` / `批墙钟=179s`（`controllable/行=3.50`、`批墙钟/行=5.59`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 32 行（8/8/8/8，**低于 33 下沿 1 行**：当前快照全仓 `ownIn` 最高 8，4×8=32 已到顶；保 4 文件结构不改 5 文件），
  判据 0 hit；无自清，`pool-diff removed=32 added=0 allowed=39 auto_self_clear=0`，基准默认解析 `pre-weak=b336-repo-post.txt`。
  b338 `total=126.0s` / `controllable=111.0s` / `批墙钟=233s`（`controllable/行=3.47`、`批墙钟/行=7.28`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 32 行（8/8/8/8，**低于 33 下沿 1 行**：b337 后快照全仓 `ownIn` 最高仍是 8，4×8=32 已到顶；保 4 文件结构不改 5 文件），
  判据 0 hit；无自清，`pool-diff removed=32 added=0 allowed=39 auto_self_clear=0`，基准默认解析 `pre-weak=b337-repo-post.txt`。
  b339 `total=150.0s` / `controllable=120.0s` / `批墙钟=196s`（`controllable/行=3.75`、`批墙钟/行=6.13`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 32 行（8/8/8/8，**低于 33 下沿 1 行**：b338 后快照全仓 `ownIn` 最高仍是 8，4×8=32 已到顶；保 4 文件结构不改 5 文件），
  判据 0 hit；无自清（四个文件 `upOut=0`，批后全部池内清零），`pool-diff removed=32 added=0 allowed=39 auto_self_clear=0`，基准默认解析 `pre-weak=b338-repo-post.txt`。
  b340 `total=144.0s` / `controllable=114.0s` / `批墙钟=184s`（`controllable/行=3.68`、`批墙钟/行=5.94`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 31 行（8/8/8/7，**低于 33 下沿 2 行**：b339 后快照 `ownIn=8` 只剩 3 个，第 4 个最高 7；保 4 文件结构不改 5 文件），
  判据 0 hit；无自清（`types.ts` 2 行上游 weak 未动），`pool-diff removed=31 added=0 allowed=38 auto_self_clear=0`，基准默认解析 `pre-weak=b339-repo-post.txt`。
  b341 `total=259.0s` / `controllable=214.0s` / `批墙钟=379s`（`controllable/行=7.64`、`批墙钟/行=13.54`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 28 行（7/7/7/7，**低于 33 下沿 5 行**：b340 后快照 `ownIn=8` 已清零，最高档 7，4×7=28 已到顶；保 4 文件结构不改 5 文件），
  判据首轮 1 hit（L 列举）改后 0 hit；自清 1 行（`transcript-hydration.ts:639`，池外），`pool-diff removed=29 added=0 allowed=36 auto_self_clear=1`，基准默认解析 `pre-weak=b340-repo-post.txt`。
  b342 `total=195.0s` / `controllable=133.0s` / `批墙钟=205s`（`controllable/行=4.75`、`批墙钟/行=7.32`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 28 行（7/7 + 7/7 + 7/8 + 7/8，**低于 33 下沿 5 行**：`ownIn=8` 已清零，7 档即上界；保 4 文件结构不改 5 文件），
  判据首轮 2 hit（1 漏改 + 1 跨行句单行缺锚点）改后 0 hit；无自清，`pool-diff removed=28 added=0 allowed=36 auto_self_clear=0`，基准默认解析 `pre-weak=b341-repo-post.txt`。
  b343 `total=124.0s` / `controllable=118.0s` / `批墙钟=218s`（`controllable/行=4.21`、`批墙钟/行=7.79`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 28 行（7/7 + 7/7 + 7/9 + 7/9，**低于 33 下沿 5 行**：7 档即上界；保 4 文件结构不改 5 文件），
  判据首轮 4 hit（1 单行无信息 + 3 无信息列举）改后 0 hit；无自清，`pool-diff removed=28 added=0 allowed=36 auto_self_clear=0`，基准默认解析 `pre-weak=b342-repo-post.txt`。
  b344 `total=126.0s` / `controllable=121.0s` / `批墙钟=257s`（`controllable/行=4.84`、`批墙钟/行=10.28`，墙钟起点取本批最早可观测产物，为下限），
  4 文件 25 行（7/6/6/6，**尾部批**，按 §6.1 第 4 条下探；不参与正常批规模分布与计时中位数），
  判据首轮 2 hit（均为无信息列举）改后 0 hit；无自清，`pool-diff removed=25 added=0 allowed=33 auto_self_clear=0`，基准默认解析 `pre-weak=b343-repo-post.txt`。
  b345 `total=127.0s` / `controllable=120.0s` / `批墙钟=258s`（`controllable/行=5.22`、`批墙钟/行=11.22`），
  4 文件 23 行（7/6/5/5，**碎尾批**首例；A 段计时，不与 B 段合并），判据首轮 2 hit（1 单行无信息 + 1 无信息列举）改后 0 hit；
  `auto_self_clear=1`（`wire-codec.ts:49`，池外上游，只减 weak 不减 `done`），`removed=24 added=0 allowed=32`。
  b346 `total=151.0s` / `controllable=119.0s` / `批墙钟=191s`（`controllable/行=4.25`、`批墙钟/行=6.82`），
  4 文件 28 行（7/7×4，尾部批；全在 `packages/ui`，单一阅读域），判据首轮 3 hit（均为无信息列举）改后 0 hit；
  无自清，`removed=28 added=0 allowed=37 auto_self_clear=0`。
  b347 `total=129.0s` / `controllable=123.0s` / `批墙钟=193s`（`controllable/行=6.47`、`批墙钟/行=10.16`），
  4 文件 19 行（7/4/4/4，**碎尾批**），首轮判据 0 hit 但 `removed=18≠19`——`conversation-share.ts:249` 仍判「空泛提醒」，
  补修提交 `694b6a16` 后 weak `−19`；本批因此有**两个批次提交**（本体 + 补修，`+20/−20`，唯一行 19）。
  b348 `total=132.0s` / `controllable=102.0s` / `批墙钟=162s`（`controllable/行=3.64`、`批墙钟/行=5.79`），
  4 文件 28 行（7/7×4，尾部批；`packages/ui` 四子域），首轮 1 hit 是**改错行**（111↔114 错位）而非文案问题，
  `fix=1/2/不可分`（两次 judge 未留时间戳，b349 起补）；无自清。
  b349 `total=127.0s` / `controllable=90.0s` / `批墙钟=143s`（`controllable/行=4.50`、`批墙钟/行=7.15`），
  4 文件 20 行（7/7/3/3，碎尾批；跨包但同一读链），首轮 1 hit（L 列举，`pluginStore.ts:538`），`fix=1/1/不可分`；无自清。
  **A 段（b337–b349）至此封存**：正常批 n=0、尾部批 n=10（中位 200.5s、极差 162–379s）、碎尾批 n=3（143–258s）。
  也暂不做新口径内部结论。旧口径读数（n=11、中位 1.59 s/行、极差 57.9%）**已随 A 段封存作废**，
  A 段只认 §6.2 第 8 条那两组（尾部 n=10、碎尾 n=3）；跨批比较**含规模效应**，未按固定开销归一。
  **b286 起计时口径切换**：改为「先 `--start` 再起草」后，落笔段与 `controllable` **会包含起草时间**，
  与 b281–b283 的旧口径（起草在 `--start` 前、不计入）不可比；新口径另起一列登记，
  不得与旧口径的 n=11 中位数/极差同列计算。b284/b285 继续单列为「测量口径失效」，不参与任何中位数。
  `--start` 在动第一笔之前调用，已存在则**保留首次**（防「晚起笔」藏耗时）；`--record` 成功写
  `t-record`（`sha` / `record_runs`）并作废旧 `t-verify`；`--verify` 通过写 `t-verify`，有 `t-start` 时打印
  落笔段、否则打印「缺失（未跑 --start）」，**不阻断**；`--order --commit <rev> [--prev <rev>]` 做最终断言
  `t-start < t-record ≤ t-verify < commit_time`（提交时间按秒比较），任一不成立 `exit 7`。
- **起笔前置：树必须干净（b279 起）**：`--start` 先跑 `git status --porcelain`，非空即 `exit 6` 并打印文件清单
  （见 b279 前的 15 文件脏树事故，判定与回滚记录在 `ZC-deep-b279-preflight.md`：脏树让 numstat 越界与 weak 快照都建在不干净地基上）。
  放行路径只能写进工具内的 `START_ALLOW`（相对 repo 的路径前缀），不写进文档；
  负控：树里放 1 个未跟踪文件 → `exit 6`；清空后 `exit 0` 才落 `t-start`。
- **格式化 / 标点重排必红（b279 后补测的负控，回应「无语义 token 变化会不会 fail-open」）**：
  门禁按**行分类**判定，`isComment()` 为假的行只要被删或新增，就分别进「删代码 / 新增非注释行」，
  **与语义是否等价无关**；`标点级改写` 只判注释行去标点后的同形，不是代码行的免检通道。
  | 负控 | 输入 | 实测 | 结果 |
  | --- | --- | --- | --- |
  | N1 | `dirty-15-pre-revert.patch`（15 文件，+2008/−285） | `删代码 274 / 删上游注释 11 / 新增非注释行 238 / 新增注释命中 171`，exit 1 | 红 |
  | N2 | 单行纯空白（`) ;` 多一个空格，零语义差异） | `删代码 1 / 新增非注释行 1`，exit 1 | 红 |
- **这 15 个文件的重排不是工程工具链的产物（b279 实测）**：root `oxfmt` 0.41 与 `apps/zcode-cli` 的
  `oxfmt` 0.47 对脏内容全部报 format issue，prettier 3.8.2 对 `mcpSyncService.ts` 同样报 issue
  （其余 14 个在 `.prettierignore` 的 `apps/zcode-cli/` 里被跳过）；HEAD 版本对 0.47 也不是 clean，
  说明仓库本身**从不强制格式化**。`core.hooksPath=.husky/_`，但 `.husky` 只有 `pre-push`（lint + test），
  `lint-staged.config.mjs` 只跑 affected vitest。**可执行结论：批期间禁止整块 / 整文件写回与保存格式化，
  只做 1→1 行改写；`--start` 的 `exit 6` 是唯一兜底，工具链侧无需改动。**
- **`out_of_scope_edits`（b274 起，与 `record_runs` 分开记；b278 起拆两列）**：越界改动行数必须独立入账，
  **回滚不等于未发生；统计目的是看越界在增加还是减少**，因此不存在「不计入」类别。
  - `out_of_scope_write_phase`：改写完成 → `--record` 之间发现的越界（`--scope` 读数或 numstat 反推）；
  - `out_of_scope_record_phase`：`--record` / `--verify` 的集合断言抓到的越界（`exit 8`）；
  - 每批另标 `rolled_back=yes/no` 与 `includes_upstream=yes/no`；总数 = 两列相加。
  b273 的 4 行（3 本线 + 1 上游）与 b277 的 2 行都属于写前阶段：已回滚，但**照样计入总数**；
  b278 两列均为 0，b279 为 `write_phase 1 / record_phase 0`（`useWebElementContexts.ts:84`
  整块替换越界，`--scope` 抓到后恢复原文），b280 为 `write_phase 3 / record_phase 0`
  （`remoteWorkspaceServiceCollection.ts:180-182` 改写块越界，跑 `--scope` 之前已自查恢复，
  工具读数为 0 但仍按「回滚不等于未发生」计入）；b281 为 `write_phase 1 / record_phase 0`
  （`embeddedBrowserHelpers.ts:111` 误删又补回，属脏文件内的**行级**还原，文件级 mtime 看不到）；
  b282 为 `write_phase 0 / record_phase 0`（6 W 返修，`LINE-DRIFT samples=49 files=0`、
  `touched_restored=0`，是首个带行级漂移读数且零越界的批）；b283 为
  `write_phase 0 / record_phase 0`（2 W + 1 L 返修，`LINE-DRIFT samples=91 files=0`、
  `touched_restored=0`，矩阵后首批照常推进、未新增门禁）；b284 为
  `write_phase 0 / record_phase 0`（6 W + 1 L 返修，第 8 行门禁 `indentChanged=0 eolChanged=0`，
  `LINE-DRIFT files=0`）；b285 为 `write_phase 0 / record_phase 0`（1 W 返修，
  `touched_restored=0`，`LINE-DRIFT files=0`，第 8 行门禁 `0/0`）；b286 为
  `write_phase 0 / record_phase 0`（5 W + 3 L 返修，`touched_restored=0`，
  `LINE-DRIFT files=0`，第 8 行门禁 `0/0`）。b287 为 `write_phase 0 / record_phase 0`
  （1 W + 1 L 返修，首轮命中 2/92 = 2.2%，`touched_restored=0`，`LINE-DRIFT files=0`，
  第 8 行门禁 `0/0`）。b288 为 `write_phase 0 / record_phase 0`（首轮 6 hits：1 POEM + 4 W + 1 L，
  其中 2 条是 `SAME` 空替换；`touched_restored=0`，`LINE-DRIFT files=0`，第 8 行门禁首次拦下
  `eolChanged=15` 并在修 EOL 后 `0/0`）。b289 为 `write_phase 0 / record_phase 0`（首轮 7 hits：1 W + 6 L，
  返修一轮后 0，`record_runs=1`；`touched_restored=0`，`LINE-DRIFT files=0`，第 8 行门禁取 `--start` 实盘基准后 `0/0`）。
  b290 为 `write_phase 0 / record_phase 0`（首轮 6 hits：3 W + 3 L，返修一轮后 0，`record_runs=1`；
  `touched_restored=0`，第 8 行门禁 `0/0`）。
  b291 为 `write_phase 0 / record_phase 0`（首轮 9 hits：6 W + 3 L，返修一轮后 0，`record_runs=1`；
  池外自清 3，第 8 行门禁 `0/0`、`SAME 0`）。b292 为 `write_phase 0 / record_phase 0`
  （首轮 10 hits：8 W + 2 L，返修一轮后 0，`record_runs=1`；无自清，第 8 行门禁 `0/0`、`SAME 0`）。
  b293 为 `write_phase 0 / record_phase 0`（首轮 2 hits：1 W + 1 L，返修一轮后 0，`record_runs=1`；
  池外自清 2，第 8 行门禁 `0/0`、`SAME 0`）。b294 为 `write_phase 0 / record_phase 0`
  （首轮 6 hits：6 W，返修后 0，`record_runs=1`；无自清，第 8 行门禁 `0/0`、`SAME 0`；
  另有一次 `zc-commit` 标点级改写拦截，属提交门禁返修，不计入越界）。b295 为 `write_phase 0 / record_phase 0`
  （首轮 8 hits：5 W + 3 L，返修后 0，`record_runs=1`；池外自清 1，第 8 行门禁 `0/0`、`SAME 0`）。
  b296 为 `write_phase 0 / record_phase 0`（首轮 10 hits：8 W + 1 L + 1 POEM，返修两轮后 0，
  `record_runs=1`；无自清，第 8 行门禁 `0/0`、`SAME 0`，LF 文件 `result-display.ts` 上 `eolChanged=0`）。
  b297 为 `write_phase 0 / record_phase 0`（首轮 5 hits：4 W + 1 L，返修后 0，`record_runs=1`；
  池外自清 2，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；另新暴露 2 条 weak 记 PARTIAL，不计越界）。
  b298 为 `write_phase 1 / record_phase 0`（首轮 4 hits：3 W + 1 L，返修后 0，`record_runs=1`；
  无自清，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；**越界 1 = 用 PowerShell `Set-Content`
  就地改 3 个文件时各带入一个 BOM（第 1 行 `\uFEFF//`），`numstat` 由 13/13 变 14/14 后当场剥除还原，
  `--scope`/`MTIME`/`LINE-DRIFT` 均未捕获，按人工自查记账**）。
  **二十六批合计 = 13**（越界计数不含第 8 行门禁返修）。
  b299 为 `write_phase 0 / record_phase 0`（首轮 4 hits：3 W + 1 L，返修后 0，`record_runs=1`；
  无自清，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；b298 的 BOM 事故无复发）。
  b300 为 `write_phase 0 / record_phase 0`（首轮 6 hits：5 W + 1 L，返修后 0，`record_runs=1`；
  池外自清 1，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；全程 Edit/apply 脚本，无 BOM 复发）。
  b301 为 `write_phase 0 / record_phase 0`（首轮 2 hits：2 W，返修后 0，`record_runs=1`；
  无自清，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；1 行缩进前缀未匹配由 Edit 补齐，无 BOM）。
  b302 为 `write_phase 0 / record_phase 0`（首轮 2 hits：2 L，返修后 0，`record_runs=1`；
  无自清，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；apply 首跑漏映射中断后补齐重跑，无 BOM）。
  b303 为 `write_phase 0 / record_phase 0`（首轮 3 hits：2 W + 1 L，返修后 0，`record_runs=1`；
  无自清，第 8 行门禁 `0/0`、`SAME 0`、`LINE-DRIFT 0`；全程 Edit/apply 脚本，无 BOM）。
  b304 为 `write_phase 0 / record_phase 0`（首轮 0 hits，`record_runs=2` 系 runner 解析缺陷续跑；
  无自清，`SAME 0`、`INDENT 0/0`、`line_drift 0`；apply-run 覆盖预检 `covered=36/36`，无 BOM）。
  b305 为 `write_phase 0 / record_phase 0`（首轮 0 hits，`record_runs=1`；无自清，
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；runner 单次输出 5 条 PASS，无 Edit 返修，无 BOM）。
  b306 为 `write_phase 0 / record_phase 0`（首轮 0 hits，`record_runs=1`；无自清，
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；runner 改失败闭合后首跑规格错一次，
  `--from verify` 续跑通过、未重复 `--record`，无 Edit 返修，无 BOM）。
  b307 为 `write_phase 2 / record_phase 0`（首轮 2 hits 均 `L/无信息列举`，Edit 返修 2 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；池外自清 1 行，不扣配额）。
  b308 为 `write_phase 2 / record_phase 0`（首轮 2 hits 均 `L/无信息列举`，Edit 返修 2 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；无自清，`pool-diff removed=36 added=0 allowed=37`）。
  b309 为 `write_phase 3 / record_phase 0`（首轮 3 hits 均 `W/单行无信息`，Edit 返修 3 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；无自清，`pool-diff removed=0 added=0 allowed=36`）。
  b310 为 `write_phase 1 / record_phase 0`（首轮 1 hit 为 `W/单行无信息`，Edit 返修 1 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；**池外自清 1**（`commands-command.ts:279`），
  `pool-diff` 首跑判红、登记后 `removed=37 added=0 allowed=38` PASS）。
  b311 为 `write_phase 3 / record_phase 0`（首轮 3 hits：2 `W/单行无信息` + 1 `L/无信息列举`，
  Edit 返修 3 行后归零；`SAME 0`、`INDENT 0/0`、`line_drift 0`；**池外自清 1**
  （`sourceServerManagementService.ts:354`），`pool-diff` 首跑判红、
  登记后 `removed=37 added=0 allowed=39` PASS）。
  b312 为 `write_phase 0 / record_phase 0`（首轮 **0 hit**，无返修；`SAME 0`、`INDENT 0/0`、
  `line_drift 0`；**池外自清 1**（`SavedWorkflowMoveDialog.tsx:72` 块尾 `*/`），
  `pool-diff` 首跑判红、登记后 `removed=37 added=0 allowed=40` PASS）。
  b313 为 `write_phase 1 / record_phase 0`（首轮 1 hit `L/无信息列举`，Edit 返修 1 行；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；**自清 1 条人工**（`zip-source.ts:312`，
  blame 本线、早于池基线，`auto_self_clear=0`），补跑 `allowed=41` PASS）。
  b314 为 `write_phase 2 / record_phase 0`（首轮 2 hits：1 `W/单行无信息`（缺 ASCII 锚点）+
  1 `L/无信息列举`（逗号 2 个无谓词），Edit 返修 2 行后归零；`SAME 0`、`INDENT 0/0`、
  `line_drift 0`；**无自清**，`pool-diff` 首跑 `removed=33 added=0 allowed=38 auto_self_clear=0` PASS）。
  b315 为 `write_phase 1 / record_phase 0`（首轮 1 hit `W/单行无信息`（缺 ASCII 锚点），Edit 返修 1 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；**首跑 `scope` 判红**：96–98 邻行被连带改写、
  `out_of_scope_edits=3`，逐字还原后 `plan=33 diff_old=33 diff_new=33 out_of_scope_edits=0` PASS；
  无自清，`pool-diff removed=33 added=0 allowed=38 auto_self_clear=0`）。
  b316 为 `write_phase 1 / record_phase 0`（首轮 1 hit `L/无信息列举`，Edit 返修 1 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；`out_of_scope_edits=0`，无越界；
  无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`）。
  b317 为 `write_phase 1 / record_phase 0`（首轮 1 hit `L/无信息列举`，Edit 返修 1 行后归零；
  `SAME 0`、`INDENT 0/0`、`line_drift 0`；`out_of_scope_edits=0`，无越界；
  无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`）。
  b318 为 `write_phase 0 / record_phase 0`（首轮 0 hit，`SAME 0`、`INDENT 0/0`、`line_drift 0`；
  `out_of_scope_edits=0`，无越界；无自清，`pool-diff removed=44 added=0 allowed=49 auto_self_clear=0`）。
  **四十六批合计 = 24**（越界计数不含第 8 行门禁返修）。
  `--scope` 只测「跑的那一刻还在漂移的越界」；b281 起 `PRECHECK MTIME touched_restored=N`（§2.5）
  补上「整文件碰过又还原」，b282 起 `LINE-DRIFT` 再补「非 plan 行改过又还原（>10 s）」，
  但**10 s 内的瞬时还原仍无工具证据**，这部分继续靠人工自查记账。
  `record_runs` 只表示预检返修轮数，不回滚也不包含越界。
- **首轮命中率（b287 起每批必报）**：`--record` 首轮 hits / 本批登记行，与 `record_runs` 同表登记。
  当前 `b283 3.1% / b284 7.0% / b285 1.4% / b286 8.2% / b287 2.2% / b288 6.7% / b289 7.8% / b290 6.7% / b291 9.3% / b292 10.2% / b293 2.0% / b294 6.1% / b295 8.2% / b296 11.0% / b297 5.5% / b298 4.4% / b299 4.4% / b300 6.6% / b301 2.0% / b302 5.6% / b303 8.3% / b304 0.0% / b305 0.0% / b306 0.0% / b307 5.6% / b308 5.6% / b309 8.3% / b310 2.8% / b311 8.3% / b312 0.0% / b313 2.8% / b314 6.1% / b315 3.0% / b316 2.3% / b317 2.3% / b318 0.0%`，三十六批合计 `128 / 2,397 ≈ 5.3%`（近十批 b309–b318 为 `14 / 414 ≈ 3.4%`）。
  某批显著升高时先查文件类型构成（JSDoc 开合行、结构行、长接口声明占比），再谈起草质量，不单看比值归因。
  b288 的 6.7% 中含 2 条 `SAME`（替换文案与原文逐字相同、等于未改写），扣除后为 4/90 = 4.4%，
  与均值一致。**b289 起 `SAME > 0` 进 `--record`/`--verify` 门禁**（判据看不见空替换）；
  b289 首批在新门下 `SAME 0`，首轮 7 条全部是真实判据命中（L 占 6），返修一轮后清零。
  b290 首轮 6 条为 3 W（纯中文短句缺 ASCII 锚点）+ 3 L（`、`/`,` 达 2 个无谓词），同样一轮清零。
- **集合断言与负控（b274 前实测，临时 worktree 改 2 行 / plan 只登记 1 行）**：
  | 改动 | 期望 | 实测 |
  | --- | --- | --- |
  | plan 外多改 1 行 | exit 8 | `PRECHECK SCOPE plan=1 … out_of_scope_edits=1` + `SCOPE OUT old/new 文件:6` + exit 8 |
  | plan 多登记 1 行但未改（漏改） | exit 8 | `SCOPE MISSING …:7` + `越界 0 行 / 漏改 1 行` + exit 8 |
  | 越界行逐条写进 `--allow` | exit 0 | `plan=1 allow=1 … out_of_scope_edits=0` + `record n=2 hits=0` |
  | plan 与改动集合完全一致 | exit 0 | `plan=2 diff_old=2 diff_new=2 out_of_scope_edits=0` |
  plan tsv 按**形状校验**读入（`baseLine` 必须是纯数字才计一行，表头自然跳过），不按位置跳首行。
- **`--scope`（b275 起）：改写完成 → `--record` 之间先跑一次，只报不拦。** 起因是 b274 的
  `WorkflowTimelineTracks.tsx:318` 越界只能从 `numstat +19/−20` 反推——断言只在 `--record` 时才跑，
  「写完」到「record」之间是漂移窗口。`--scope` 复用同一套 `scopeCheck()`，打印
  `PRECHECK SCOPE plan=… out_of_scope_edits=…` 与 `SCOPE OUT / SCOPE MISSING`（明细截断 12 行），
  两项均为 0 时打印 `PRECHECK SCOPE PASS`，**一律 `exit 0`**；拦截仍在 `--record` / `--verify`（`exit 8`）。
  它不是第二条门禁，是同一条断言的前置读数——所以 `--scope` 通过**不能**替代 `--record`。
- 负控（b273 前实测，临时前缀）：`record n=100` 后把戳改成 `2026-11-10T18:50:00Z / 18:50:50Z / 18:51:30Z`
  （均早于提交）→ `PRECHECK ORDER OK`、`batch_wall=349.0s`；把 `t-start` 改晚于 `t-record` → exit 7；
  删 `t-start` → exit 7；`t-verify` 改晚于提交时间 → exit 7；`t-start` 改成 2099 年 → exit 7。
- **顺序前置拦截负控（b278 起，`zc-commit` v13，`--rewrite-annot --yes` 时生效）**：
  | 构造 | 期望 | 实测 |
  | --- | --- | --- |
  | 只有 `t-record`、没有 `t-verify`（先 commit 后 verify） | exit 9 | `ORDER GATE FAIL 缺 negctl-t-verify.txt（未跑 --verify）` + `拒绝提交`，`HEAD` 不变、`diff --cached` 为 0 行 |
  | `t-verify` 早于 `t-record` | exit 9 | `ORDER GATE FAIL t-verify(…) 不晚于 t-record(…)` + 拒提交，`HEAD` 不变 |
  | 正常顺序（record → verify → commit） | exit 0 | b278 实测：`ORDER GATE PASS record=2026-11-11T04:02:06.315Z verify=2026-11-11T04:02:10.292Z files=6`，之后才 `git add` 与 `git commit`（`fd7c023c`） |
  拦截在 `git add` **之前**，失败不留暂存区残留；不需要也不允许再靠 `reset --soft` 补救。
- `--start` 缺失时 `tail` 仍可算、`batch_wall` 仍可算，只有 `--order` 拒绝——三量互不依赖，但顺序断言要三戳齐全。
- 与 `zc-gate` 的关系：直接 `import { judgeEntries } from './zc-gate-v4.mjs'`，判据不复制、不另写一份；
  `zc-gate` 换版时本件须同步归档并改 import。
- 它不是门禁：七行门禁仍由 `zc-commit.mjs` v13 负责；本件只保证「门禁看到的正文 == 预检过的正文」。

### 2.7 历史回溯审计（history-indent-audit，b285 前置）

| 文件 | sha1（blob） | 作用 | 首个使用 |
| --- | --- | --- | --- |
| [`history-indent-audit.mjs`](history-indent-audit.mjs) | `4593ff7aed1d` | 用第 8 行门禁的判据回放每批 `提交^..提交`：`-U0` hunk 内按序配对，只比两侧都是注释的行，比较前导空白与行尾；两侧取 `cat-file --filters`。逐行与 `expect_*` 比对，另加**净额断言**（改写行与 `-fix` 行逐行镜像），任一条不成立 `exit 1`。EOL 列在历史里结构性恒 0，打印 `rawCrlf=0` 证明是归一化抹掉而非漏查 | b285 前置（不属批次） |
| [`history-indent-batches.tsv`](history-indent-batches.tsv) | `b4ee4927b361` | 26 行登记表（24 批 + 2 个 `-fix`）：`batch / commit / expect_indent / expect_eol / note`；非零值只登记已修复的历史缺陷，不写「希望是 0」 | 同上 |

- 首跑即负控：登记值为 0 时抓出 b282 `20`、b283 `12` 并 `exit 1`（`unexpected=2`）；补登后复跑 `unexpected=0`。
- 净额：`NET b282 mirrored=yes`、`NET b283 mirrored=yes`；只比数量不够，逐行镜像才算「修回去了」。
- 结果与判定见 [`ZC-deep-history-audit.md`](../ZC-deep-history-audit.md)。

## 3. 不属于本目录的尺子

| 文件 | 版本 | sha1（blob） | content sha1 | 出处 | 首个使用批次 |
| --- | --- | --- | --- | --- | --- |
| `deep-quality.mjs` | v1.8 | `09c50b7bd5a2` | `cda2388ed021` | `_annot_baseline` 提交 `ba738a0`（14:42，另线） | b229–b234 |
| `deep-quality.mjs` | v1.9（重建件） | `8042442fe198` | `4be849e81205` | `_annot_baseline` 提交 `4364e2e`（15:21，另线） | b235 |
| `deep-quality.mjs` | v2.0 | `756bea66122a` | `5144fefd8888` | `_annot_baseline` 提交 `aa69f6c`（另线） | **b256**（B8） |

- 本目录的 `deep-quality.mjs` 是 content `7975a4486eae` 的旧副本，**既不是 v1.8 / v1.9 也不是 v2.0**，不得当尺子使用；b256 起的活文件在 `_annot_baseline/deep-quality.mjs`（v2.0），本目录副本未同步。
- v1.8→v1.9 的判据差异：`identTokens` 纳入全大写缩写。实测 weak 集合与 RATIOS 在 b234/b235 四个快照上**逐字一致**，只有 `substance` 上移 0.3pp；因此 weak 可跨版本并列，substance / explain 不可跨版本比较。
- v1.9→v2.0 的差异：**只改遍历跳过表**（补 `out / dist-server / dist-node / dist-viewer / dist-types / bundled-agents`），判据、计数、输出格式零改动。同一快照 `8a4d8e02` 上 v1.9 `10,085/329,503`、v2.0 `10,085/329,480`，弱分子逐字相同，少掉的 8 文件 / 23 行是 `node-repl-host/dist-types/*.d.ts`。**引用全仓率必须带版本**：v1.9 的 3.1% 与 v2.0 的 3.1% 分母不同，不得相减。

## 4. 批次 ↔ 版本对照（2026-11-10）

统一按 blob sha1 12 位。b230/b234 台账里记的正是这三列；b235 台账误记成 content sha1，见 §5。

| 批次 | 时间窗（提交） | deep-quality | zc-gate | zc-commit |
| --- | --- | --- | --- | --- |
| b229 | 14:58:44（`0dd058e9`） | v1.8 `09c50b7bd5a2` | v3 `f75c5e64246f` | v2 `629ef5b8fa27` → 复核换 v3 `165fa79f96a1` |
| b230 | 15:06:40–15:08:51（`53ac2dae`） | v1.8 `09c50b7bd5a2` | v3 `f75c5e64246f` | v3 `165fa79f96a1` |
| b231 | –15:10:51（`8a9bf367`） | v1.8 `09c50b7bd5a2` | v3 `f75c5e64246f` | v3 `165fa79f96a1` |
| b232 | –15:12:49（`9f09a5be`） | v1.8 `09c50b7bd5a2` | v3 `f75c5e64246f` | v3 `165fa79f96a1` |
| b233 | –15:14:36（`9a16b176`） | v1.8 `09c50b7bd5a2` | v3 `f75c5e64246f` | v3 `165fa79f96a1` |
| b234 | 15:17:49–15:19:45（`59dcc46d`） | v1.8 `09c50b7bd5a2` | v3 `f75c5e64246f` | v4 `f2661d7008ee` |
| b235 | 15:23:22–15:26:31（`14e81d85`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v4 `f2661d7008ee` |
| b236 | 16:57:03–17:03:01（`14d5c8ce`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v5 `005b2b409f54`（首跑 v4 失败，归档 v5 后重跑通过） |
| b237 | 17:09:43–17:13:53（`832a0225`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v6 `032283968d18`（首跑即用 v6，4 行真上游被拦下） |
| b238 | 17:20:54–17:24:41（`c3f5fbc4`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v6 `032283968d18`（首跑拦下 1 行上游 JSDoc + 1 行 L，返工后通过；T1 已打点） |
| b239 | 17:25:58–17:27:55（`eaa331c7`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v6 `032283968d18`（首跑即通过，无返工；三段 51/27/39=117，纯同口径样本） |
| b240 | 17:30:12–17:33:27（`477f5d6a`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v6 `032283968d18`（合并试跑 6 文件，首跑即通过；195s，32.5s/文件；白名单补 `55f48e6d` → 27 条） |
| b241 | 17:35:42–17:39:52（`da7c8668`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v6 `032283968d18`（合并第 2 批 6 文件；250.4s，**41.7s/文件**；弱行 16→4，4 行上游豁免；返工 1 次） |
| b242 | 17:44:41–17:47:10（`14c0e7e1`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v8 `d5dc8bd91446`（6 文件；149.2s，**24.9s/文件**；弱行 18→3，3 行上游豁免；返工 1 次＝补 v8 计数洞） |
| b243 | 17:52:19–17:53:24（`18e274fc`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v9 `1542e4088fd2`（6 文件；65.1s，**10.8s/文件**；弱行 13→0；零返工；含 v7 洞回溯） |
| b243-R | 17:53:40–17:59:43（`1c54edbb`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v10 `066509a32c52`（回溯补修 b240 三行单行 JSDoc 水句；+3/−3；提交集合断言 `expected=2 staged=2`） |
| b244 | 18:02:46–18:05:41（`a149ef4d`） | v1.9 `8042442fe198` | v3 `f75c5e64246f` | v10 `066509a32c52`（**8 文件试批**；175.2s，**21.9s/文件**（含返工）/ 11.25（不含）；弱行 21→4，4 行上游豁免；返工 1 次＝3 次门禁迭代；结论：8 文件无摊薄收益，回落 4–5） |
| b245 | 18:09:37–18:11:36（`3f2e1cae`） | v1.9 `8042442fe198` | **v4 `633b334905ee`** | **v11 `3c65b811b847`**（5 文件；119.2s，**23.8s/文件**；弱行 12→3，3 行上游豁免；嵌套注释硬拒绝上线，802 行负例回放 802/802；802 行分类 658 合格/144 仍水） |
| b246 | 18:14:29–18:15:30（`2896fd1e`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（5 文件；60.9s，**12.2s/文件**；弱行 10→0；零返工；658 行 (a) 二次分类 A1=658 / A2=0，抽样 10/10 一致） |
| b247 | 18:17:14–18:17:58（`6269b765`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（5 文件；43.5s，**8.7s/文件**；弱行 7→2，2 行上游豁免；零返工；802 行立项按「先 144 后 658」拆 12 批、每批 ≤100） |
| b248（802-B1） | 18:19:00–18:25:03（`a08969d2`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（`offPeakTaskStore.ts` 68 行 = 144 侧 10 改写 + 658 侧 58 去前缀；363s；弱行 0→0；`onlyPre/onlyPost=0`；numstat `68 68` 非净删除；own-commits **v2 三态**上线，`pending=0`） |
| b249（802-B2） | 18:27:31–18:29:28（`d74fd00a`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（`conversationTurnNavigatorHelpers.ts` 64 行 = 15 改写 + 49 去前缀；**常规成本 117s，一次性 0**；弱行 0→0；`onlyPre/onlyPost=0`；numstat `64 64`；返工 3s 由脚本在写盘前拦截；产能均值改为只算常规段 71.5s/批） |
| b250（802-B3） | 18:32:08–18:34:25（`6abb2f65`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（`packages/shared/src/git.ts` 62 行 = 13 改写 + 49 去前缀；137s（一次性 30 / 常规 107）；弱行 0→0；`onlyPre/onlyPost=0`；numstat `62 62`；**capacity 口径对齐**：939=剩余不是总量，471=flat 2 文件/批，同口径 map 批数 b240 313 → b250 307） |
| b251（802-B4） | 18:35:30–18:37:31（`fa64af7b`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（`app-view.tsx` 68 行 = 13 改写 + 55 去前缀；121s（一次性 0 / 常规 121，返工 5s）；弱行 1→0，substance 85.6%→91.3%；`onlyPre/onlyPost=0`；numstat `68 68`；**批数口径定稿**：`PLAN 159`（≤6 文件且 ≤100 行/批）为唯一排期口径，470/307 降级为对照/上界；**>100 行切批规则**上线；3 条回读 3/3 完整） |
| b252（802-B5） | 18:41:58–18:43:42（`3567cd77`） | v1.9 `8042442fe198` | v4 `633b334905ee` | v11 `3c65b811b847`（`pptxElementReference.ts` 65 行 = 14 改写 + 51 去前缀；104s（一次性 160 / 常规 104，返工 20s）；弱行 0→0，substance 83.9%→88.5%；`onlyPre/onlyPost=0`；numstat `65 65`，CRLF 保持；**时长算法改按文件成本**（14.9 s/文件 → 3.9h，20.6 → 5.4h 上界），b251 的 `159 × 74.5s = 3.3h` 作废；s/文件 阈值限定常规注释批，802 批按 s/行 1.7–1.9 判定） |
| b253（802-B6） | 18:46:20–18:48:23（`77c365de`） | v1.9 `8042442fe198` | v4 `633b334905ee` | **v12 `a35b42fa2e4c`**（`workspace-hook-digest.ts` 60 行 = 18 改写 + 42 去前缀；123s（一次性 210 / 常规 123，返工 8s）；弱行 0→0，substance 75.0%→86.3%；`onlyPre/onlyPost=0`；numstat `60 60`，CRLF 保持；**点估计改 20.6 s/文件 → 5.4h**（300 个 1–2 行档文件实测中位 412 行 / 186 单元，与历史 401 / 174 同构，14.9 系抽样偏低）；**v12 修标题后缀重复**；中间检查三项：387/802、全仓 `// //` 417（清单内 415 + docs 2）、全仓 weak 10,397/358,119（2.9%）vs B1 前 10,085/329,503（3.1%）） |

## 5. 口径事故（2026-11-10，b235）

b230/b234 台账的 `ruler=` 记的是 **git blob sha1**，b235 记的是 **文件 content sha1**。两种算法对不同文件必然给出不同值，于是 b235 看起来像「三把尺子全变了」。逐条核过后：

1. `zc-gate`：`f75c5e64246f`（blob）与 `f53d75cdc9d7`（content）是**同一份 v3 文件**，批次间未改动。
2. `zc-commit`：`165fa79f96a1`（v3 blob）→ `f2661d7008ee`（v4 blob）是**真实改动**（搬移扣除），发生在 b234 之前，b234/b235 用的是 v4。
3. `deep-quality`：`09c50b7bd5a2`（v1.8 blob）→ `4be849e81205`（v1.9 content）是**真实换版 + 约定差异**，换版由另线在 15:21 完成（`4364e2e`），本线未参与。

**处置**：从 b236 起 `ruler=` 一律写 blob sha1，并附本索引里的版本号；b235 台账不改历史行，只在 §10 追加更正。

## 5.1 口径事故（2026-11-10，b250）：`939 / 471 / 313` 不是同一件事

b247/b248/b249 的报告里并排打印 `SUM 939 文件 / 6828 行 / 471 批`，被读成「总量 939、总批数 471」，
又与 b240 的 `313 批` 对比，看起来像「只清了 68 个文件却多出 158 批」。实际是：

1. `939 / 6828` 是**剩余**（基线 1007 / 7421 − 已清 68 / 593），标签 `SUM` 有歧义；
2. `471` 是**flat 2 文件/批** 的剩余批数；`313` 是 b240 时点、**合并档位**（1–2 档 6 文件/批）的剩余批数；
3. 同口径今天为 `307` 批，比 b240 的 313 少 6，与 1–2 档清掉 40 文件吻合。

**处置**：`capacity-estimate.mjs` 改标签 `SUM` → `REMAIN`，并新增三行 `ACCT`：
`done + remain = 基线`（文件、行各一条，现场判定 OK/MISMATCH）+ 批数口径说明；任一不等即 `exit 1`。

## 5.2 批数口径定稿（2026-11-10，b251）：只认 `PLAN`

`REMAIN` 行里的 `470`（flat 2 文件/批）与 `307`（1–2 档 6 文件/批）都不是实测批规模，并排展示会被读成两个候选。b251 起：

1. **唯一排期口径** = `capacity-estimate.mjs --plan 6x100`：≤6 文件且 ≤100 行/批，按行数降序贪心装箱；推导依据是实测 b243 6 文件、b247 5 文件 + 立项上限 100 行/批（6 文件约束先于 100 行约束生效，均值 5.9 文件 / 42.9 行）。
2. `470` / `307` 降级为**对照/上界**，脚本输出已写「不作为排期依据」；任何时长估算只能乘 `PLAN` 的批数（或 802 剩余批数），不得混乘。
3. **>100 行文件的切批规则**（B9 起照用）：切点优先级 = 符号边界（顶层 `export` / `function` / `class` / `interface` 起始行）→ 逻辑段（完整注释块 + 其悬挂代码）→ 行数硬切；硬切只落在空行或注释块边界，禁止句中断行；超限文件单独占一批，批内分 `Bx-1 / Bx-2` 多次门禁，中间不夹其他文件，整体登记一个批次号；切点须在改写前写入 TSV 的 batch 字段。
4. **每批 3 条「只去前缀」行回读**：只记录剥一层后语义是否完整、是否该改判 144，不改正文；用于给机械解包加人工门（A2=0 是全仓结论，逐批抽查防单文件误判）。

## 5.3 全仓口径：断言只认干净 worktree；v2.0 起两作用域同值（b255 记录，b256 收口）

历史（v1.9）：主工作区扫描会把构建产物算进去——跳过表只有 `target / node_modules / .git / dist / build / .venv / __pycache__`，不含 `out`、`dist-server`、`dist-node`、`dist-viewer`。实测 `77c365de` 主工作区比干净 worktree 多 216 文件、27,048 条注释行（`packages/desktop/out` 199 个），同一提交两个读数 2.9% vs 3.1%，判据依赖「磁盘上有没有构建产物」。

b256 起（v2.0）：跳过表补齐这些产物目录，`77c365de` 主工作区与干净 worktree 同值；B1 前快照 `8a4d8e02` 上 v1.9 / v2.0 都是 **3.1%**（`10,085/329,503` → `10,085/329,480`）。「中途不扩排除表」的禁令由 b256 用户指令解除，代价是所有历史数字必须标版本。

仍然保留：**断言输入一律取干净 worktree**。原因是主工作区还有别的会话的未提交改动。同提交 `c40c4d70` 两作用域对比（v2.0）：干净 worktree `9,491 / 329,480 / 10,084`，主工作区 `9,493 / 331,156 / 10,175`，差 **+2 文件 / +1,676 注释 / +91 weak**。其中 `+1,676` = 新增 2 文件 35 行 + 15 个共同文件被加注 +1,641 行；`+91` 全落在这些文件内，与本线无关。

**单位注意**：`10,175` 是 weak **注释行数**（`RATIOS` 分子），`9,491` 是**文件数**，两者不得相减（b257 曾报「差 684」，即此误）。b256 §0 写的 `+90` 是拿主工作区与 `8a4d8e02` 快照跨提交相减所得；同提交基线是 `10,084`，正确差值 `+91`。

## 6. 使用约束

1. 每批门禁前先比对活文件 sha1（`git hash-object`）与本表一致；不一致即停，先归档再跑。
2. 归档即活文件的定版：改工具必须先提交归档，再用于新批次；不允许「活文件改了、归档没跟上」。
3. 复算历史批次时同时钉住 `deep-quality` 版本与 `zc-gate` 版本；只有 weak 分子分母可比，substance / explain 不跨版本比较。

### 6.1 批规模与越界分歧（b316 起）

1. **批规模浮动 33–44 行**：按 `pick-generic` 候选的实际可用行数，取能凑出的最接近组合，
   **优先 4 文件**；只有候选确实不足 33 行才退到更小批。批号连续、每批一提交，台账记实际行数分布。
   例：11/10 两档时候选 `11+11+11+11 = 44` 取 44 行，不再固定 36 行、不再出现连续 33 行批。
2. **不为凑量放宽判据**：`pick-generic` 判 strong 的行一律不写；批小一点可以接受，改 strong 行不行。
3. **越界还原必须留分歧记录**：每次 `gate --scope` 报 `SCOPE OUT` 后，当批台账 §0 必须登记
   「行号 / `pick-generic` 判定 / 我的判定 / 最后按哪边执行」，并用**关掉句元合并**的口径复核该行：
   若逐行也判弱，归入 1,046 类（已在既有计数内则不重复加）；若逐行判强，写明理由并关闭分歧。
4. **尾部批（tail batch）：4 文件合计 <33 时允许下探，下限 25（b345 起写死）**
   - 触发条件（同时成立，纯算术，不需每批临时论证）：① 候选 `ownIn` 最高档 ≤ 7；② 取最大的 4 个文件，
     合计在 25–32 之间。
   - **不补第 5 个文件**。理由（可复用到下一批复核）：候选按 `ownIn` 降序给出，第 5 个就是下一个最大的，
     留到下一批不会消失；而补进来只改变批次形状（4→5），让逐文件登记与 `files=4/4` 的结构断言失真，
     对「这一批能写多少行」没有帮助——b344 的第 5 个只有 5 行，5 文件合计 30 仍在下沿之下。
   - 处置：台账 §0 标题写「尾部批」并原样抄 `TALLY`、`plan=`、`files=4/4` 三行；该批**计入 `done`**，
     但不进正常批的规模分布统计与计时中位数；INDEX §12.1 也单独标「尾部批」。
   - **绝对下限 15 行（b345 起）**：4 文件合计 <15 时**不许单独成批**，二选一里选「并入相邻批」（合批）：
     允许该批文件数 >4，台账 §0 记「合批 + 实际文件数 + 合并了哪几批」。
     不选「凑 5 文件」的理由是算术：末段是 1–2 行/文件档（299 文件 / 381 行），5 文件合计 5–10 仍 <15，
     凑文件补不到下限，只会把批数变成伪精度。合批只出现在收尾，且 `files=4/4` 失配处已有台账说明可审计。
     区间定义：**正常批 ≥33 ｜ 尾部批 25–32 ｜ 碎尾批 15–24 ｜ <15 合批**。
   - **33 是目标，不是硬指标**：A 段（b337–b349，13 批）**行目标达成 0/13**——32/32/32/31 与全部 28/25 都落在尾部区间，
     b345 23、b347 19 是碎尾。历史台账若写「正常批 n=4（32/32/32/31）」，那是 ≥31 的旧阈值，**无规范出处，已作废**；
     B 段（b350 起）起 **33 不再是目标**（见第 5 条），区间分档只作统计口径。
   - 碎尾批单独登记在 §12.6，**计入 `done`、不进中位数**——这两件事分开写，不用「不计入」含糊。
5. **形状 B：目录聚类（软约束） + 文件上限 6 + 无固定行目标（b350 起定案；b1–b349 不回溯）**
   - **上限从 30 下调到 6（b350 实测依据）**：`capacity-estimate --plan 6x100` 给出
     `PLAN 86 批 / 均值 6.0 文件 / 14.6 行`、`PLAN#1 writable=38`（86 是在 `remain=1,255` 上算的；
     `remain=1,217` 时 **85 批**，b351 后 `1,181` 时 **84 批**——两次各减 1 批，差额就是 b350、b351
     执行掉的 6 文件各自所在的 `PLAN#1`，见 b351 台账 §7）。
     `capacity-estimate` 已核对**无隐含上限**：全文只对字符串/argv 做 `slice`，文件集合走
     `for (const [file, count] of baseline)` 全量遍历，`--plan 6x100` 的 `maxFiles/maxLines` 是**每批上限**，
     不是「只取前 N 个文件」；未 done 文件按基线计数是模型假设（L311–L317），不是截断。

   | 方案 | 每批文件数 | 批数 | 平均行/批 | 33 行达成 | 总时长 |
   | --- | --- | ---: | ---: | --- | ---: |
   | **B（cap 6，b350 起）** | cap 6 / 实测批均 **6.0** | **78**（按剩余 993，实测密度） | 12.7 | 无目标；实测 avg 12.7 / max 30 | **3.5h（中位，见第 6 条）** |
   | ~~B（cap 30）~~ | ~~cap 30 / 均值 13.1~~ | ~~41~~ | ~~34~~ | ~~不可执行~~ | ~~2.61h~~ |

   - **A 案整行已删（口径说清）**：「4 文件」不是 A 段全段的 cap，只是 **b332–b349 尾段**的批上限
     （18 批实测批均 **4.00**、max **4**、29.2 行/批）。A 段全段 **b266–b348** 实测 **4.78 文件/批**
     （max **8**）、**57.0 行/批**。原表「cap 4 / 实测均值 6.5」把两个口径并排，且 6.5 > 4 算术上不成立；
     与其并列的「80 批 / 16 行」隐含 **4.0 行/文件**，与池内 **2.4 行/文件**不相容，**一并作废**。
     若把 cap 4 推广到剩余 1,255 行，按 2.4 行/文件只有 9.6 行/批、约 **131 批**，比 B 的 86 批更差。
   - **B 是被迫的（成本归因）**：池内密度约 **2.4 行/文件**（1,255 行 ÷ 516 文件），
     6 文件只能出 **14.4 行**；14.4 行配 A 段中位批墙钟 153s 即 10.6 s/行（区间 9.8–11.1 s/行）。
     要回到「32 行/批」需 **13 文件/批**，正是爆上下文的配置，不可执行。
     **3.66h 与「后段约 4.2h」都建立在「收口段 ≈53s」这个前提上**（3.66h = 86×153s，4.2h = 86×176s），
     而 b351 实测收口 **178s**；按 178s 重算 84 批约 **5.9h**，按 b352 的 87s 重算约 **3.8h**（两者都是外推区间，不是定值）。
     历史 **2.61h（cap30）** 与早先的「约 2h」两个数**均标不可执行**。
   - **逐批总时长模型**：`批时长 = 起草 14s + 行数×4.44s + 收口`。
     36 行批（收口 178s）**352s**、14 行批 **254s**、10 行批 **236s**；
     按 84 批 / 1,181 行：收口 178s → `84×192 + 5,244 ≈ 21,372s ≈ 5.9h`，
     收口 87s → `84×101 + 5,244 ≈ 13,728s ≈ 3.8h`，收口 60s → `≈ 3.2h`（**乐观极限，当前不可达**）。
   - **前快后慢：4.63 s/行 不许外推**。b350 的 4.63 s/行（176s ÷ 38 行）是**首批读数**，那 38 行来自
     6 个候选集中的文件（**6.3 行/文件**，7+7+6+6+6+6）。后段按 2.4 行/文件算，同样 6 文件约 14 行：
     176s → **12.2 s/行**；若有效行跌到 10 行 → **17.6 s/行**。所以 4.63 与由它派生的 3.66h 都只是
     首批口径，**不作整段下界**（整段按收口 178s 重算见上条 5.94h）；
     上一轮 **9.8–11.1 s/行** 只作**后段预期值**，不作整段均值。
   - **成本监控（b352 起改口径）**：`s/行` 只作记录值，**不作停批依据**（36 行批 9.78、10 行批 17.6，
     它会随批内行数跳）。停批用两个独立信号：
     ① **收口段 >150s 连续 3 批** → 停批查收口（白名单/产能/台账写作哪一项超时）；
     ② **可控段 s/行 >8 连续 3 批** → 停批查判据/回改（可控段 = `--start` → 批次提交，不含收口）。
   - **不设固定行目标（b351 起）**：删掉「33 行」目标，改为「按贪心装箱取整批候选，行数如实报」。
     A 段 0/13、B 段均值 14.6 已证 33 不可达，继续拿 33 当指标只会制造伪精度；
     §12.6 的尾部/碎尾分档仍按实际行数登记（那是统计口径，不是目标）。
   - **目录聚类是软约束**：同目录优先，允许跨目录，但**一批不超过 4 个顶层目录**。
     b350 跨 4 个顶层（`packages/ui` 2 / `adapters` 2 / `core` 1 / `tui` 1）**在规则内**，
     不再是「首批例外」；超过 4 个才需要写理由并停批回报。
   - **断言改为按清单长度**：`zc-commit` 的 `files=<本批清单长度>`（不再固定 4），
     `scope` 的 `out_of_scope_edits=0` 不变；`pool-diff` 与自清检查按同一清单长度执行。
     **任一批 `auto_self_clear>0` 或 `pool-diff added>0` 立即停批回报**，不连续跑过。
   - **切换点 b350**：b345–b349 仍按形状 A（4 文件）。两段的 `批墙钟` 不得跨切换点合并求中位数/极差，
     报数时 A 段、B 段分开列；主中位数与碎尾中位数两套读数照旧（§12.6）。
     若 B 段碎尾占比降到 <50%，可恢复单套，但必须在 §12.6 写明恢复依据与生效批号。
   - **自足化基线重建**：每 40 批的自足化审计，在 b350 之后的第一批重建基线（形状变了，
     旧基线的文件数分布对不上），重建时并列「旧基线 / 新基线」两份读数。
6. **剩余池的实测密度与批数（b358 前定案，取代本节此前全部时长数）**
   - 快照 `b357-repo-post`：全仓 weak **4,234 行 / 1,668 文件**；**池内 993 行 / 468 文件**，
     密度 **2.12 行/文件**（旧文里的 2.4 是 `1,255 ÷ 516`，已过期；且 993 行不再只落在 516 文件上）。
   - **密度分档**（按每文件池内剩余行数）：

     | 档 | 文件数 | 行数 | 占池内行 |
     | --- | ---: | ---: | ---: |
     | ≥5 | 21 | 105 | 10.6% |
     | 2–4 | 231 | 672 | 67.7% |
     | 1 | 216 | 216 | 21.8% |
     | 0（只剩池外，永不清零） | 1,200 | 0 | 0% |

   - **贪心装箱（6 文件 / ≤100 行）实测**：**78 批**，行/批 min 6 / max 30 / **avg 12.73**；
     分布：6 行 ×36 批、12 行 ×13、18 行 ×14、24 行 ×9、30 行 ×3，其余 14/22/27 各 1。
     末段 36 批是「6 文件各 1 行」，这正是**不许用头部 30.4 行/批外推**的原因。
   - **时长**（模型 `14s + 行数×s + 61s 收口`）：**收口项由 63.5s 改 61s**，因为 63.5 的样本里含
     b357 的 158s，其中 55s 已被 `STALE-EXPECTED` + `TOTAL-START` 消除；不能一边说开销修掉了、
     一边把它留在定价里。**采纳口径①：剔除 158s**，样本 `39/45/77/82`（b353/b356/b358/b354）→ 中位 **61s**。
     78 批下：s=6.60 → **3.45h**；s=7.09 → 3.58h；s=8.0 → **3.83h**；**区间 3.4–3.8h**。
     收口项改动量：`−2.5s/批 × 78 批 ≈ −195s（−3.3min）`。
     **2.5h 只作乐观值**（= 33 批 × 30 行头部外推，实测密度下不可达），单独标注、不作排期依据。
   - **取代关系**：`3.66h`、`3.8h`、`5.9h`、`3.2h`、`2.61h`、上一轮的「单值 2.5h」**全部作废**；
     其中 3.8/5.9 是「旧批数 84 × 旧收口口径」的外推，与本条不是同一批数口径，不可混用。
   - **b358 后复测**（`b358-repo-post`）：池内 **963 行 / 462 文件 = 2.08 行/文件**；
     ≥5 档由 21 文件降到 **15 文件 / 75 行**（b358 吃掉的 6 个各 5 行、无残留）；
     贪心装箱 **77 批 / avg 12.51**；按 s=6.6、收口 61s 为 **3.37h**（s=8 → 3.75h），区间 **3.4–3.8h**。
     结论不变：排期按 **3.4h** 量级；2.5h 不再作为任何下界或排期依据（见下方「下界口径」）。
   - **b359 后复测**（`b359-repo-post`）：池内 **933 行 / 456 文件 = 2.05 行/文件**；≥5 档降到 **9 文件 / 45 行**；
     贪心装箱 **76 批 / avg 12.28**；s=6.6、收口 61s → **3.29h**（s=8 → 3.66h），**区间 3.3–3.8h**。
   - **下界口径（b360 前订正）**：**撤销「2.5h」这个下界**。它由 `3.63 s/行` 推出，而 3.63 与 4.87 是
     B 段密度最高的两批（每批 30 行集中在 5 行/文件档），拿它当全局下界等于把头部效应算两遍；
     76 批比 78 批少两批、少 60 行，地板反而降到 2.5h，算术上也自相矛盾。
     下界只用**与批数同源的 s/行**：`6.60`（B 段可控段 s/行中位，b353–b359 为 3.80/6.60/3.59/7.37/7.09/4.87/3.63）
     → **3.29h**；上界用停批阈值 8.0 → 3.66h。排期一律按 **3.3–3.8h**，不引用单批最低值。
   - 复算件：`_annot_baseline/density-bands.mjs`（一次性测算，不进闸）。

### 6.2 计时口径（b317 起）

| 名称 | 起点 | 终点 | 含 | 不含 |
| --- | --- | --- | --- | --- |
| `total`（闸内 `batch_wall_total`） | 上一提交 | 批次提交 | 选行、读码、写作、判据返修、六闸 | 台账收口、下一批准备 |
| `controllable`（闸内 `batch_wall_controllable`） | `--start` 落戳 | 批次提交 | 读码、写作、判据返修、六闸 | 选行、台账收口 |
| `批墙钟` | 本批第一次工具调用 | 台账提交 | 选行、读码、写作、门禁、台账写入与提交 | 批间空闲 |

1. `controllable/行` 是**闸内段墙钟**，不是产能；`批墙钟/行` 才是端到端，跨任务只作量级参考。
2. 引用「用时」时 `controllable` 与 `批墙钟` 必须并排出现，或注明只报其一；单给 `s/行` 视为口径不明。
3. 首调用于白名单批内时用白名单提交时间近似（误差 ≤3 s）；其余批次在批开始时显式落 `date` 戳。
4. **插点批次不落 `repo-post` 时，禁止复制快照顶替**：复制会制造一个「该批从未实测」的档案文件，
   与「登记表必须与批后快照同批保存」冲突。两种正当做法：
   (a) **首推：插点批也现扫一份真快照**（成本一次扫描，`b320` 之后补做同款）；
   (b) 下一批显式 `--pre-weak <最近一笔批后快照>`，日志里留下 `pre-weak=` 该文件名，
   并在台账写明「b 批未改扫描域」的两条证据：`git diff --stat <前批>..<本批父> -- packages apps docs/knip` 为空、
   `git status --porcelain` 为空。
   `gate-run --start` 已前置校验：基准缺失且未给 `--pre-weak` 时 **exit 1**，不落 `t-start`、不改工作树，
   并打印「补批号 / 显式指定 / 现扫」三条处置。b321 的复制品已删除，改用显式 `--pre-weak b319-repo-post.txt`。
5. **跨批比较只做了「按行归一」，没做「按规模归一」（b345 起强制标注）**：`s/行` 只除掉了行数，
   没扣固定开销（起草段 + 台账收口段），也没按批规模做协变量。因此引用跨批计时结论时必须带
   「含规模效应」标注，尾部批（§6.1 第 4 条）与碎尾批（§12.6）的计时**不参与**正常批中位数与极差。
6. **八批三段实测（b337–b344，全部可切段）**：起点取 `bXXX-files.txt` 的 mtime（与批墙钟同源，
   早于它的 cand/pick 不计，属下限），`可控段` 终点是批次提交，`收口段` 终点是台账提交。

   | 批 | 行 | 起草 s | 可控 s | 收口 s | 批墙钟 s |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | b337 | 32 | 6 | 112 | 61 | 179 |
   | b338 | 32 | 11 | 111 | 111 | 233 |
   | b339 | 32 | 6 | 120 | 70 | 196 |
   | b340 | 31 | 8 | 114 | 62 | 184 |
   | b341 | 28 | 11 | 214 | 154 | 379 |
   | b342 | 28 | 8 | 133 | 64 | 205 |
   | b343 | 28 | 18 | 118 | 82 | 218 |
   | b344 | 25 | 59 | 121 | 77 | 257 |

   收口段均值 **85.1 s**（中位 73.5，极差 61–154），与行数无关；起草段 6–59 s 的抖动来自白名单提交位置。
7. **`墙钟/行 ~ 1/N` 回归不可识别（b345 记）**：八点拟合 `a·(1/N) + b` 得 `a=554.3 s`、`b=−10.94 s/行`、
   `R²=0.429`；去掉 b341 后 `a=429.9 s`、`b=−7.39 s/行`、`R²=0.822`。**截距为负**说明模型在数据范围外
   （`1/N` 仅 0.031–0.040，即 25–32 行）外推，固定项被放大、可变项被压成负数，不能据此下「固定开销摊薄」的结论。
   残差层面 b341 一个点占总平方和 **43%**，是主要离群点。可用的只是第 6 条的分段实测（收口段 ~85 s），
   不是这条回归。
8. **A 段计时封存（b349 收口补最后一批，b350 起另起 B 段）**：A 段＝b337–b349（13 批）。
   **按 §6.1 的 ≥33 判定，A 段没有任何正常批**：32/32/32/31 全落在尾部区间（25–32），
   此前台账写的「正常批 n=4（32/32/32/31）」用的是 ≥31 的旧阈值，**没有规范出处，作废**。

   | 组 | 区间 | n | 批号 | 中位数 | 极差 |
   | --- | --- | ---: | --- | ---: | --- |
   | 正常批 | ≥33 行 | **0** | — | — | — |
   | 尾部批 | 25–32 行 | 10 | b337–b344、b346、b348 | 200.5s | 162–379s |
   | 碎尾批 | 15–24 行 | 3 | b345（258s）、b347（193s）、b349（143s） | 不报（n<4） | 143–258s |

   **A 段无正常批，行目标 33 达成 0/13**；**b350 切形状 B 的依据即此——33 在 A 段从未填满**。
   **离群标注**：尾部批 n=10 的 **200.5s 不能当 A 段代表值**（A 段无正常批）；b341 的 **379s** 是唯一超 300s 的点，
   剔除后 n=9 中位 **196s**、极差 162–257s。两套读数并列时须写明是否含 b341。
   碎尾批只报两个值，不与尾部批合并求中位数；引用主中位数必须同时给出尾部/碎尾读数。
9. **块注释的 1:1 口径（b348 起）**：「断言行 1:1」只对单行 `//` 成立；块注释（`/* */`、多行 JSDoc）
   按「**断言数 : 注释块数 = 1:1**」，注释行数 = 块数 + 块内续行数。
   CL1–CL6 实测（b347 后复查）：**1,350** 个单元（plan 行数）中 **575** 个带注释块，
   注释行 **594** = 575 块 + **19** 条续行（来自 **10** 个多行块）；明细见
   `opensource/valkey/docs/annotation/comment-lines-vs-assertions.tsv`。
   台账记的「断言位置 570」与实测 575 差 **5**：这 5 个是 **S 行上方的散文块**（非断言行，已由散文统计），
   逐条见 `opensource/valkey/docs/annotation/STATUS-20261111.md` §「5 个非断言注释块」；
   故 570 / S 780 / S 率 57.8% / 断言率 42.2%（分母 1,350 单元）**均不变**。
   **定位前必须反转义**：plan 的 `code` 列用 `\\` 表示 `\`（`\\0`、`\\r\\n`、`\\\\x`），
   不反转义会得到「5 条未定位」的假象；反转义后 1,350/1,350 全部命中。
   **module.c 六片同测（1,320 plan 行）**：字面比对命中 **1,316**、未命中 **4**；反转义后 **1,320/1,320**。
   只在反转义后命中的 4 条：`VK-M02:2973`（`\"%s\"`）、`VK-M02:3007`（`\"%s\"`）、`VK-M03:4365`（`"\r\n"`）、
   `VK-M05:18071`（`VM_##n` 宏拼接行）。两边合计 14 条，全部是转义表示差异，无行号漂移、无作废。
   台账写「行数」时必须注明是断言数还是注释行数。
10. **并列两个数必须给分母**：任何一句话里同时出现两个数，必须写明各自的分母/口径——
    写「575 个带注释块的单元（plan 1,350 条）」而不是「575 个单元」；写「900 单元 = CL1–CL5 各 225（分母 5 片）」
    而不是「900 单元 = 各 225」。写不出分母的数不许并排放。
11. **台账固定字段 `fix=`（b348 起，§4 末尾一行）**：`fix=首轮hit数/回改行数/回改秒`，无回改写 `fix=0/0/0`。
    依据：b328–b347 共 20 批里 **12 批**发生过回改（判据首轮 hit、漏改、越界、空泛提醒），占 60%，
    超过 1/3，故设为固定项。历史批次**不回填耗时**（没有逐次编辑时间戳），仅 b347 有实测 41s。
12. **收口段：拆解、目标与压缩（b353 起执行）**
    - **固定项实测**：批后快照 **8.3s**、白名单重生成 **0.2s**、产能重算 **23s**（`--plan`）/ **1s**（记账）、
      台账写作与提交 **52s**（b351，改 7 处 INDEX）。
    - **b351 试错 94s 拆解**：`WHITELIST STALE` 秒退 + 恢复（软重置 / 重生成 / 重跑产能 23s / 重提）≈ **40s**；
      `ALIGNED diff=36` 排查（找因、发现 rewrite.tsv 未落盘）≈ **40s**；`rewrite.tsv` 补登记 ≈ **1s**；时间戳与 sha 采集 ≈ **13s**。
    - **一次性 / 周期判定**：STALE 在方案①下 **每 5 批复现一次**（meta 永远落后 HEAD）→ 校验改轻量；
      `ALIGNED` **每次收口都可能复现**（顺序错就来一次）→ 改成一句命令给差异文件；`rewrite.tsv` 补登记 **一次性**（流程固化后即一条 copy）。
    - **收益重定价**：①/② 合计只省 **19–21s（12%）**；试错 94s + 台账 52s = **146s（82%）** 才是主项。
      试错压到 ≈3s 后 178s → **87s**，再叠加台账模板化可到 ≈**70s**。
    - **工具**：`preflight.mjs --whitelist` 打印 `FRESH` / `STALE-OK docs-only n=k` / `STALE-BAD <文件>`；
      `preflight.mjs --batch bNNN` 打印 `REWRITE-TSV OK n=k` / `MISSING` / `DIFF missing=… extra=…`。
      两条都在 1s 内，不再手工比对。
    - **目标 60s、floor 45s**：台账压到 35s、试错压到 2s 后，固定项 floor 为 `8 + 2 + 35 = 45`，
      b353 实测 **45s** 已贴住 floor；停批阈值仍是**连续 3 批 >150s**。
      **90s 降级为 cushion**（floor 的两倍），只用于发现严重回归，不再作目标。
    - **`docs-only` 放行判据**：落后提交涉及的文件必须全部以 `docs/annotation/` 开头且扩展名为 `.md/.tsv/.json`；
      出现 `.mjs`（如 `_tools/preflight.mjs`）或任何代码路径一律判 `STALE-BAD`，先重生成白名单再继续。
      放行只替代「白名单新鲜度」检查，**不替代 `ALIGNED`**：窗口收口（每 5 批）仍必须跑产能并断言 `ALIGNED diff=0`。
    - **5 批窗口的兜底分工**：窗口内每批由 `preflight --batch` 当场拦「rewrite.tsv 与清单不一致」；
      `ALIGNED` 只作窗口收口的汇总校验，**不当每批兜底**。窗口内 `remain` 用增量记账。
    - **两条独立计数不许合并**：`done += 本批行数` 与 `files -= 批后 weak 归零的文件数` 分别记，
      台账并列写「行 +N / 文件 −M」，**M 可以小于 N/6**（有文件留上游 weak，属正常）。
    - **台账模板化**：脚本可填的固定位置 = §0 `TALLY/plan/files`、§1 表、§3 六闸、§6/§7 产能读数、
      §8 计时（时间戳文件）、§9 提交表；**必须人写** = §2 改动内容、§1 目录分布说明、§10 判据结论。目标：台账段 ≤30s。
    - **总时长用区间，不给单点**：收口 87s → **3.8h**；收口 178s → **5.9h**；收口 60s 的 **3.2h** 只作**乐观极限**。
      b357 收口后已取得普通收口实测（n=4，中位数 63.5s），**单一数定为 ≈2.5h**，见第 14 条。
13. **记账口径（b354 起写死）**：`done += 实写行数 + 池内自清行数`；`files -= 批后 weak 归零的文件数`。
    **两条独立计数各写分母，不合并成一列**。`removed` 是「weak 消失行数」，含**池外**自清；
    池外自清只减全仓 weak，**不减池内 remain**，所以含池外自清时 `done` 的增量会小于 `removed`（差 1 行）。
    b354 的 interim 曾写 `done 6,342 / remain 1,079`（按 `removed=31`）；**b355 全量重算判定差 1，已订正为
    `done 6,341 / remain 1,080`**，差额就是 `toolbarShortcuts.ts:218` 这条**池外**自清——即 `removed` 比池内实清多 1。
    **历史 progress 数（83.6/84.1/84.6%）** 全部取自 `done = 7,421 − remain`（weak∩pool 口径），
    本身不含池外自清，**不需要回算**；10 行自清里属池内的是 0 行，不进入这条式子。
    - **`files` 指标自 b358 起拆两列**：`可清文件数 / 含池外残留文件数`。判据是「该文件 weak 全集是否都在池内」：
      全在池内 = 可清（改写后能到 0）；有任一行在池外 = **永不清零**（池外行不可写）。
    - b357 快照：可清 **382** ／ 含池外残留 **1,286**（86 个既有池内行也有池外行、1,200 个只剩池外），
      合计 1,668；池外残留共 **3,241 行**。清单：`docs/annotation/NEVER-CLEAR.tsv`。
    - **b360 全量 blame 定终值**：可清 **136** ／ 含不可写残留 **1,520**，合计 1,656。
      不可写 = 池外残留 **3,241 行** + 池内但 blame 属上游 **495 行**；
      其中 113 个文件既有可写行也有不可写行（能改写、但永远清不到零）。
    - 文件数指标的 **floor 是 1,520**，`1,656 → 0` 不可达；报进度只报可清的 136。
    - 清单 `NEVER-CLEAR.tsv` 已换成四列 `writable / upstream / residue / path`（1,520 行）。
14. **收口统计按流程分段（b354 起）**：preflight **之前**（b345–b352）样本 **n=3**：53 / 178 / 87；
    preflight **之后**为「普通收口」，样本 **b353(45)、b354(82)、b356、b357** 共 **n=4**（**采纳口径①：承认 n=4**）。
    b355 的 **60s 是窗口收口**（含全量重算），**单列、不并入**，也不影响普通收口的中位数方向。
    「b353–b357 五批」这个旧说法作废；b357 之后按 **n=4** 取中位数与极差。
    - **实测（b357 收口后）**：45 / 82 / 39 / 158 → **中位数 63.5s**、**极差 39–158s**（跨度 119s）。
      b357 的 158s 含约 55s 一次性排查（`total` 起点 sha 核对 + 白名单 `STALE-BAD`）；按要求**不剔除**，
      且四个点里 b357 取最大，剔除与否中位数都是 63.5s。
    - **单值总时长 ≈2.5h**：`14s 起草 + 30.4 行/批 × 6.60 s/行 + 63.5s 收口 = 278s/批`，
      剩余 993 行 ÷ 30.4 ≈ **33 批**；若按 b357 的 23 行/批（43 批）重算约 2.7h，故该值对批量不敏感。
15. **`total` 的起止点（b356 起写明）**：`total` = **上一提交 → 本批批次提交**（含起草前段与批间文档提交的空档）；
    `controllable` = `--start` → 批次提交；`批墙钟` = 最早产物（`bNNN-files.txt`，若 `bNNN-t-start.txt` 更早则取它）→ 台账提交。
    三者关系：`批墙钟 = 起草 + controllable + 收口`，`total = (上一提交 → t-start) + controllable`。
    因此 `total` 与「起草 + 可控」或「可控 + 收口」都对不上，差额就是「上一提交 → t-start」这一段（b353/354/355 分别是 38/8/3s）。
    **`s/行` 的分子一律用 `controllable` 或 `批墙钟`，不用 `total`**；历史批次的 `total ÷ 行数` 不可与 `s/行` 并列比较。
    - **b360 前用 b359 timeline 复核 `total`**：`total − controllable` = **上一提交 → `--start` 的起草准备段**。
      四批实测差值 3 / 12 / 13 / 53s，逐批对得上：
      b355 `11:25:53 → 11:25:56 = 3s`、b357 `11:35:28 → 11:35:40 = 12s`、
      b359 `11:54:05 → 11:54:18 = 13s`、b358 `11:46:20 → 11:47:13 = 53s`（该批重筛候选多花的时间）。
      **公式保留**：`total = 起草准备（上一提交→--start） + controllable`；
      恒等式 `批墙钟 = controllable + 收口` 仍然只在两处成立（`109+61=170`、`146+77=223`）。
      引用约束不变：**`s/行` 分母不用 `total`**，`total` 只作「含起草准备」的整段参考。
16. **`hit_rate`（b359 起写死，b366 重定义，**b378 起拆分口径**）**：`首轮问题条数 ÷ 行数`，分子含**起草后所有检查**
    （`sentence-precheck` + `judge-generic` + 六闸 + 等集断言），不再只数 judge；台账 §0 必填。旧值保留作对照。

    **拆分（b378 起，三列必须同时出现，不许合并）**：

    | 列 | 定义 | 进 `hit_rate` 分子？ |
    | --- | --- | --- |
    | **判据类首轮问题** | 写盘后被 `precheck` / `judge` / 六闸 `判据=0` / 等集断言**判否的行数** | **是** |
    | **格式类首轮问题** | 写盘后被 `record` 闸判否的行数（`indentChanged` / `same` / `mtime`） | 否，单列 |
    | **落笔前 lint 拦截** | 写盘**前**被文本级 lint（分隔符计数 / `ANCHOR` / 指代词）拦下的条数 | 否，单列 |

    理由：`10.3% → 3.3% → 0%` 那段曲线里，b375 的唯一命中是 `indentChanged`（格式类），
    b376/b377 的 0 是「lint 把问题挡在写盘前」。三者混在一个数里，看起来像质量突变，实际是**判定点前移了**。

    - **历史 `34/330` 的性质（b378 复核）**：分子 28（judge 的 L/W）+ 5（precheck 缺锚点/缺谓词）+ 1（六闸 L），
      **全部是判据类，不含任何缩进/格式类**。所以 b375 的那 1 条（缩进）**不能计入这条曲线**，
      必须记在「格式类」列；否则 34/330 与 3.3% 不可比。
    - **b375 / b376 / b377 按新口径重记**：
      b375 判据类 **0**、格式类 **1**、lint **0**；b376 判据类 **0**、格式类 **0**、lint **1**；
      b377 判据类 **0**、格式类 **0**、lint **1**。
    - **`0.0%` 只表示「写盘后没返工」，不表示「一次写对」**：b376 / b377 都是 lint 先拦下 1 条再改写，
      若那条直接写盘，判据类会是 1。台账 §0 必须写这句，禁止把 0 读成质量突变。

    | 批 | 行数 | 旧 judge-only | 新 all-checks（下界） | 增量来源 |
    | --- | ---: | ---: | ---: | --- |
    | b353 | 35 | 1（2.9%） | 1（2.9%） | — |
    | b354 | 30 | 2（6.7%） | 2（6.7%） | — |
    | b355 | 34 | 0（0%） | 0（0%） | — |
    | b356 | 30 | 1（3.3%） | 1（3.3%） | — |
    | b357 | 23 | 3（13.0%） | 3（13.0%） | — |
    | b358 | 30 | 9（**30.0%**） | 12（**40.0%**，重建↓） | precheck 缺锚点 ×3 |
    | b359 | 30 | 1（3.3%） | 2（6.7%↓） | precheck 缺锚点 ×1 |
    | b360 | 24 | 3（12.5%） | 3（12.5%） | — |
    | b361 | 25 | 3（12.0%） | 3（12.0%） | — |
    | b362 | 20 | 0（0%） | 0（0%） | — |
    | b363 | 19 | 2（10.5%） | 2（10.5%） | — |
    | b364 | 17 | 3（17.6%） | 3（17.6%） | — |
    | b365 | 13 | 0（0%） | 2（**15.4%**） | precheck 缺谓词 ×1 + 六闸 L ×1 |
    | **合计** | **330** | **28（8.5%）** | **34（10.3%↓）** | 比值 **1.21↓** |

    - **`↓` = 下界（不是实测）**：b353–b364 的首轮草稿没留档（`--register` 覆写了 plan），
      precheck 分量是**终稿回放**补的，六闸分量只有 b365 有个案记录，所以这些新值只会偏低。
      **本轮 `hit_rate` 合计 10.3% 与比值 1.21 都是下界**；**唯一首轮实测是 b365 的 2 条（15.4%）**，
      b358 的 40.0% 是**重建值**（judge 实测 9 + 终稿回放补 3），不是在首轮同时观测到的。
      标记必须长在数字身上：这些数过三轮就会被当实测引用。

    - **回算口径与局限**（回算件 `_annot_baseline/hit-rate-replay.mjs`，输出 `hit-rate-replay.txt`）：
      `judge_first` 与 `rows` 取各批台账 §0 的记录值；`gate_first` 只有 b365 留有个案（六闸报 L），
      其余批记 0 的依据是终值 `判据=0` 与 `fix` 轮数对齐，**未逐条留证**；
      `precheck` 在 b365 之前不存在，其分量由**终稿回放**得到（首轮草稿未留档：plan 被 `--register` 覆写、
      draft 未进 git），因此**整列是下界，不是首轮实测**。唯一首轮实测的是 b365 = 2。
    - 终稿回放同时给出一条独立结论：**13 批终稿的 judge 残差全为 0**（合并词表后跑 `judgeEntries`），
      说明两份表合一没有让任何已提交行由「过」变「不过」；precheck 侧只在 b358/b359 报 4 行缺锚点
      （`ProviderSettingsCard:366`、`jsx-preview:90`、`usePlugins:145`、`fileMentionProvider:142`）。
      这 4 行**定性为「历史残留·主动放弃」**：已提交、判据上不是 weak（`judgeEntries` 判 0），
      只是不满足 b365 才上线的「每行必须有锚点」自检；**不回改，也不计入 remain**。
      写死这一条是为了不让它既像欠账、又不进账本。
    - **阈值口径（方向写死：更严，不是放宽）**：新口径下 `20%` 只相当于旧口径 **`16.5%`**（`20 ÷ 1.21`），
      等义阈值是 **`24%`**（`20 × 1.21`）。所以「20% 暂不动」的实质是**比原来更严、只会多停批、不会漏停批**；
      下调会把这条线压得更紧，上调才是放宽——本轮**没有放宽**。
      且换口径不改变任何历史停批判定：b353–b366 里没有任何两批连续 >20%
      （b358 重建值 40.0% 的下一批 b359 只有 6.7%），所以 20% 暂不下调也不上调，
      **观察 b366–b370 五批再定**。连续两批 >20% 仍停批做语义抽检。
    - **分子再扩一项（b366 起）**：**等集断言**（`git diff -U0` 行号集合 == plan）也算首轮检查。
      它是六闸 `scope` 的同源前置、且比 `out_of_scope_edits` 更早更严（b366 的 `deploy.ts:134` 就是它拦下的，
      若等到六闸才报，读数同样是 1 条）。不把它计入会让 `hit_rate` 系统性低报。
    - **落笔顺序（b366 事故固化）**：`--start` → `pick-generic` → **起草落笔** → `plan-new` → precheck →
      等集断言 → judge → 六闸。`pick-generic` 必须在落笔前跑：它用 `git blame` 取归属，
      已改的行会返回全 0 sha，整批落 `pending`（b366 首跑 `plan=0 pending=31`）。详见 `DEFECTS-MASTER.md` **D-004**（含三行最小正控）。
    - **`--from` 只能跳到 commit 之前**：`sha` 只存在于完整跑的那次进程内存里，`--from pool-diff` / `--from order`
      会被判「缺 `--commit`」。若只在收尾段补跑（如 b367 补登记自清），改用
      `precheck-assert.mjs --order --commit <sha> --prev <父提交>` 直接复算，判据同源、读数照抄。
    - **放行依据唯一是 `deep-quality` 全仓扫描（b382 写死）**：`judge hits=0`、`precheck` 全绿**都不构成放行**。
      b381 的 `WorkspaceFileSearchSection.tsx:232` 同义重复（远程/远端）正是 `judge` 放过、全仓扫描抓到的。
      台账 §0 的「判据类」列必须附**抓取步骤**（`precheck` / `judge` / 六闸 / `deep-quality`），
      让每个 0 自证是哪把尺量出来的。已复核 b376–b380：各批 30/30/10/15/16 条目标行对下一批全仓快照
      `still_weak` 全为 **0**，故那几批的 0 与 b381 可比。
    - **池外自清必须登记**：自己 blame、又不在 plan 的行从 weak 集合消失，六闸一律判
      `UNREGISTERED SELF-CLEAR`（硬失败，`allow` 文件对它无效）。只能在 `POOL-SELF-CLEAR.tsv`
      按 `<file>:<line> / batch / blame / out-of-pool / 成因` 人工登记一行；这类行**不进 done/remain**，
      只解释「全仓 weak 减得比池内多」的差额（b367 减 27、remain 减 26）。

    - **分类不混**：`W` 里的「无锚点」（起草时没写标识符/数字/反引号）单列一类，**不计入 L**；
      b358 的 4 条 W 全属这一类（`ProviderSettingsCard:68/115/201`、`stack-trace:547`），与尺子无关，是起草习惯问题。
    - **语义抽检第二轮**（b361 停批后执行，b355–b361 抽 20 条，seed `20261112`）：
      有增量 11 / 弱增量 7 / 复述 2 → `有+弱 = 18/20 = 90.0%`，Wilson 95% **[69.9%, 97.2%]**；
      **按总体构成加权后 89.3%，仅「有增量」加权 51.0%**；总体构成 条件 50 / 顺序 31 / 数据流 115。
      分层条件类 4、顺序类 5、数据流类 11；判定线 ≥50% → **通过，恢复 b362**。明细见 `SEMANTIC-CHECK-2.md`。
    - **语义抽检第三轮**（b364 停批后执行，b355–b364 抽 20 条，seed `20261113`）：
      有 11 / 弱 5 / 复述 4 → `有+弱 = 16/20 = 80.0%`，Wilson 95% **[58.4%, 91.9%]**；
      **加权后 82.5%，仅「有」加权 54.7%**；总体构成 条件 73 / 顺序 42 / 数据流 137；一致率 75%。
      判定线 ≥50% → **通过，可开 b365**。明细见 `SEMANTIC-CHECK-3.md`。
    - **对外读数一律成对报两个数**（`有+弱` 与 `仅「有」`），并附**双读者一致率 75%**（第三轮 15/20）：
      前者衡量「读者是否少回溯」，后者衡量「是否拿到因果」；
      **导航型注释算前者、不算后者**——不构成缺陷，但必须分开报，不得只报一个。
      若要把后者推高，办法是写作时补「不这样会怎样」，不是加批数。
17. **`zc-commit --register` 会覆写入参 plan 文件（b358 事故）**：`gate-run` 把 `--register` 指向 `bNNN-plan.tsv`，
    提交成功后该文件被替换成「删除侧」登记表（内容是**改写前**文本），事后从 plan 复制出的 `rewrite.tsv` 就会记错内容列。
    处置：开批落盘后立刻 `Copy-Item bNNN-plan.tsv bNNN-plan-new.tsv`，收口用 `-plan-new.tsv` 生成 `rewrite.tsv`。
    b358 的 `ZC-deep-b358-rewrite.tsv` 已按源码重生成（30 行新文本）并单独提交订正。
18. **池内剩余 = 可写 + 上游（b360 全量 blame 定案）**
    - 复算件 `_annot_baseline/pool-own-blame.mjs`（一次性，不进闸）。
    - 快照 `b359-repo-post`：池内 **933 行 / 456 文件**，按 blame 拆成
      **可写 438 行（276 文件）** + **上游 495 行**（池内但作者非本线，永不可写）。
    - **b360 后**（`b360-repo-post`）：池内 **909 行 / 450 文件** = **可写 414** + 上游 495；
      可清到零 **130** 文件；上游 495 行在两批里一行未动，说明这部分确实不归本线。
    - 可写行的密度分档（b359）：≥5 → 1 文件 / 5 行；2–4 → 89 文件 / 247 行；1 → 186 文件 / 186 行。
    - **排期只按可写行算**：贪心 6 文件装箱约 **45 批 / avg 9.2 行**；
      `14 + 9.2×6.6 + 61 ≈ 136s/批` → **≈1.7h**（s=8.0 → 1.8h）。
    - 因此 `capacity` 的 `remain 909` 是「池内观测值」，**不是待办量**；b360 后待办量记 **414**，
      进度分母用 `done 6,512 + 414`。`remain` 与 `writable` 的差 495 不得再拿来算时长。
    - **时长暂缓（b363 起）**：b362 的 3.45 s/行、收口 35s、批墙钟 104s 虽是 B 段最低，但它是**第一份完全按新流程跑的样本**，
      带「刚改完流程格外仔细」的偏差。**b363–b365 三批跑完、水平仍在这附近，才改 1.7h**；
      在此之前不改，也不拿 3.45 当新基准外推下界。台账加**「近三批」滚动窗口**（行/批、s/行、收口），b365 后一起看。
    - **滚动窗口不用于反推批数**（b364 订正）：近三批 21.3 行/批 是贪心先吃高密度文件的结果，
      与 b350 的 30.4 行/批 是同一个坑。**剩余批数仍用「9.20 行/批 + 尾段 6 文件各 1 行」的结构算**
      （350 行按此估 ≈ 40 批，b365 全量 blame 后给准值），**不得用 21.3 反推**。
      滚动窗口只回答一个问题：水平是否稳定（用于决定 1.7h 改不改）。
    - **可写 414 行的贪心复跑**（6 文件 / ≤100 行 / 同顶层目录优先）：**45 批**，
      行/批 **min 6 / avg 9.20 / max 25**，末段 **12 批全是「6 文件各 1 行」**，45 批里有 **31 批 ≤6 行**。
      时长 `14 + 9.20×6.60 + 61 ≈ 136s/批` → **1.70h**（s=8.0 → 1.86h）。
      与旧「1.7h」几乎无差是因为那本来就是按 45 批估的；**若按 46 批（438 行）等比折到 43 批就少算 2 批**，
      原因是尾段全是 1 行文件、批数由「6 文件」而非行数决定——**折比例会低估**。
    - **时长口径定稿（b365 后）**：`1.7h` 是**上界（cushion）**，取「45 批 × 6.6 s/行 + 收口 61s」的悲观侧，
      不是中值。**b365 的 7.31 s/行不得当新基准**（13 行小分母 + 一轮回改，见 `ZC-deep-b365.md` §6）。
      中值用近四批窗口实测：`14s 起草 + 9.2 行 × 4.60 s/行 + 42s 收口 ≈ 98s/批`。
      批数仍按 9.20 行/批 的结构算：当前可写 320 行 ÷ 9.20 ≈ **35 批** → `35 × 98s = 3,430s ≈ 57min`；
      b365 前按 40 批排期时才是 `3,920s ≈ 1.09h`。**批数与时长必须成对报**：
      「35 批 + 1.1h」对不上（差 5 批 ≈ 8min），要么 35 批配 0.95h，要么 1.1h 配 40 批。
19. **进度分母双列（b361 起）**：池内 **495 行属上游、永不可写**，对基线 100% 不可达。
    **该条「对可达上限 6,926」一列已于 b371 作废**：`REMAIN` 里没有上游分量，`6,926 = 7,421 − 495`
    无法从当前工具链复现（见 §6.2 第 22 条与 §12.1 待复核条）；下面原文保留仅供对账。
    - 对基线 7,421：`done 6,512 / 7,421 = 87.8%`（与历史序列可比）；
    - 对可达上限 `7,421 − 495 = 6,926`：`6,512 / 6,926 = 94.0%`（**`已完成` 的终值用这一列**）；
    - **进度上限 93.3%**（= 6,926 / 7,421），不可达 **495 行**。
    - 说明：用户口径里写的「不可达 1,421 行」与 `7,421 − 6,926 = 495` 对不上，
      本文件按 **495** 记；若 1,421 另有算法，请指出后我再改。
    - 收尾时只报 94.0% 这一列，避免停在 87% 附近被误读成没干完。
20. **改行定位（b361 事故，D-001 的邻近类型但不是同一类）**
    - 事实：计划行 **84**，我按文本匹配改成了 **66**；发现后还原 66、重改 84，最终 scope 读数 `25/25`。
    - **当时没有在错误状态跑 scope**，因此没有 `plan_lines_covered` 读数与退出码可报；
      抓到它的是 `judge-generic`（第 84 行仍判弱），不是 scope。
    - 不是 D-001：D-001 是「行数相等、计划集合整体平移后仍被覆盖」；本次是**行集合不相等**
      （计划 84 / 实际 66），scope 的 `out_of_scope_edits` 会命中；b364 负控实测报 `plan_lines_covered=0/1` + `exit 1`，只是当时没跑到。
    - **流程（b362 起强制执行）**：
      ① 改前按**计划行号**取原文，与计划文本逐行比对一致才允许编辑（禁止只按文本匹配）；
      ② 一批改完先 `git diff -U0` 取改动行号集合，与计划行号集合做**等集断言**；
      ③ 断言通过再跑 `judge-generic`，最后跑六闸。
21. **起草后、judge 前的机械自检（b365 起强制）**
    - 命令：`node _annot_baseline/sentence-precheck.mjs --plan bNNN-plan-new.tsv`
    - 只查两类**机械可判**的问题，不改尺：① 注释正文无锚点（标识符 / 数字 / 反引号）；
      ② 逗号 `[、,，]` ≥2 且无谓词表词汇（含 `为/即/表示`）。
    - 输出 `missing_anchor=N / missing_predicate=N` + 行号清单；**全 0 才进 `judge-generic`**，否则 exit 1。
    - 依据：b362–b364 首轮 hit 全是这两类，判语义是浪费；提前到起草后，0.5s 一轮。
    - 实跑：b364 最终文本 `missing_anchor=0 missing_predicate=0`；注入样例（「搜索、等级筛选、导出三组按钮。」）
      报 `A` 1 条 + `P` 1 条、exit 1。

22. **文件侧四个分母（b372 起定稿；批报只用 1,007 作文件侧分母，其余标辅助）**

    | 数 | 定义 | 关系 | 用途 |
    | ---: | --- | --- | --- |
    | **1,007** | 基线（`weak-own-by-file.tsv`）里含**本线** weak 的文件 | `done 623 + remain 384 = 1,007` | **文件侧分母（辅助）**；`ACCT files OK` 就是它 |
    | 1,592 | 当前全仓扫描有**任一条** weak 的文件（含池外 / 上游） | `72 可清 + 1,520 永不清零` | 观测值，**不进任何分母** |
    | 1,520 | `NEVER-CLEAR.tsv` 行数：weak 里有**不可写行**的文件 | `1,286（residue>0）+ 234（仅上游 495 行）` | 只核判据，不进 `done/remain` |
    | 1,286 | 上述 1,520 中**池外残留 > 0** 的子集 | `⊂ 1,520`；1,520 − 1,286 = 234 | 同上 |
    | 384 | 当前**含可写行**的文件（= 1,007 的剩余侧） | `⊂ 1,007`；`384 × 1.73 行/文件 = 663` | 只用于排期装箱 |

    - **唯一进度分母是行**：`done 6,758 ÷ 7,421 = 91.1%`。文件侧的 `623 ÷ 1,007 = 61.9%` 是辅助列，
      两个数并列时必须各写分母；`1,592` / `1,286` / `384` 不得单独当「完成了百分之几」的分母。
    - 恒等校验（b371 实测）：`1,592 − 1,520 = 72` = 可清文件数，与容量表「可清 72」一致。
23. **cap 6 → cap 10（b372 起；只留这一个结论）**
    - **cap 6 不是 scope / `plan_lines_covered` 的要求**：那两项是**逐文件**的集合等式
      （plan 行集合 == `git diff -U0` 实际改动行集合），与一批装几个文件无关；`pool-diff` 也只按「本批文件集」比对。
      cap 6 是 b350 为**起草上下文**定的（当时 13 文件/批 × 7 行 ≈ 90 行，爆上下文）。
    - 现在尾段是 216 个 1 行文件：cap 10 的一批只读约 10–40 行（最大 40，仍低于 b366 已跑过的 30 行 + 余量），
      上下文成本低于 b350 时 cap 6 的 42 行。**结论：cap 提到 10 文件/批，≤100 行/批不变。**
    - 装箱结果（`pack-b371.mjs … 10 100`）：b372 前 **39 批**（384 文件）、b372 后 **38 批**（374 文件），
      行/批 `min 4 / avg 17.0 → 16.4 / max 40 → 39`，22 批整批 1 行文件。
    - **时长重算（旧值全部作废，保留原文不静默替换）**：

    | 口径 | 批数 | 收口/批 | 每批模型 | 总时长 |
    | --- | ---: | ---: | --- | ---: |
    | ~~35 批 × 98s~~ | ~~35~~ | ~~42s~~ | ~~`14 + 9.2×4.60 + 42`~~ | ~~0.95h~~ **作废（b365 前口径）** |
    | ~~40 批 × 98s~~ | ~~40~~ | ~~42s~~ | 同上 | ~~1.09h~~ **作废** |
    | ~~45 批 × 136s~~ | ~~45~~ | ~~61s~~ | ~~`14 + 9.2×6.60 + 61`~~ | ~~1.7h~~ **作废（批数由旧 687 行估出）** |
    | cap 6 / 64 批（对照） | 64 | 61s | `14 + 10.4×5.04 + 61 = 127s` | 2.3h |
    | cap 10 / 38 批 · 收口 61s | 38 | 61s | `14 + 16.4×5.04 + 61 = 158s` | **1.7h（下界）** |
    | cap 10 / 38 批 · 收口 150s | 38 | 150s | `14 + 82.7 + 150 = 247s` | **2.6h（主报下沿）** |
    | cap 10 / 38 批 · 收口 332s（b372 实测） | 38 | 332s | `14 + 82.7 + 332 = 429s` | **4.5h（主报上沿）** |
    | 参考：按 b372 批墙钟 500s 外推 | 38 | — | 500s | 5.3h（含可控段，非纯收口口径） |

    - **主数 = 含估算合计（b400 定稿）**：**`4.64h`** = `16,714.6s` = `controllable 6,276.0 + 收口 7,239.5 + S5 实测 619.1 + S5 估算 2,580.0`，覆盖 **B 段 b350–b400（51 批）**。
    - **副数 = 全实测可见**：**`3.93h`** = `14,134.6s` = `6,276.0 + 7,239.5 + 619.1`，其中 `S5` 只有 **8 批**实测（b393–b400）。
      `S5` 缺 **43 批**按 **8 批实测中位 `60.0`** 补 `2,580.0s`；`619.1 ÷ 60.0 ≈ 10.3` 不能当批数。
      收口列 42 批实测 + 9 批（b374–382）由 `批墙钟 − controllable` 导出，端点各 `±0.5s` → `±4.5s（0.4%）`；b367 的 `controllable` 取 `157.0`。
    - **A 段边界**：`b1–b349` 台账无统一计时字段，**不计入、不外推**；`4.64h` 不是 400 批全项目总耗时。
    - **两种「小时」**：`0.10h / 0.30h / 1.29h` 是剩余批次预估，`3.93h / 4.64h` 是已完成累计，不可相减；`0.08h` 已降级为 b399 时点历史值（CLOSING §7）。
    - **`S5_closeout` 预登记失效**：`S3b 428.3 + S5 96.4 = 524.7s`，超上界 `220.0s` 达 138%；不得写成「96.4 低于下界」。
      工具往返按 `TOOL_TRIP` 从每批收口扣除，不整批剔除；`ACCIDENT_TIMING` 只剩 b389 一种情形。
      b390 时同式得 `1.29h`（20 批 / 199 行，cap 10）；b391 的 `0.71h` 是 cap 20 版，**b392 判据受邻接自清污染、回退作废后重新成立**；b393 为 cap 20 第 3 批，结论「净收益为正、判据不稳定」（首轮干净率 2/3）。
      单点参考：b391 反推每批固定项 `105.1 − 20×3.45 ≈ 36.1s` → b393 的 7 批下 `0.80h`，**n=1、不采用**；
      `61.4s` 仍是 cap 10 四点拟合，未在 cap 20 下重估。
      拟合残差 `4.2%` 是 **in-sample**、不是预测误差（§5.3）；窗口 `b399 / b398 / b397` 的**净**收口中位是 `95.0s`（三批 `95.0 / 77.0 / 114.0`，无构造值）。**这是模型输出，不是端点包络。**
    - **口径（b392 起）**：主报与包络同用 A；`S3b` 计入，不再拆「65 + 56」。窗口锚点**显式**给
      `--anchor=batch|pre`（不给即报错），台账落盘后用 `--report-only --anchor=batch` 重算。b400 标 `CLOSEOUT_BATCH` 后窗口为 `b399/b398/b397`；本线固定 `--cost=A` 取含文档全成本（CLOSING §5.1），主数已改实测总计（见上）。
    - **`S5` 回填计入主报（b395 起，b400 统一 8 批中位）**：`S5_PER_BATCH = 60.0s = median(160.0, 96.4, 84.0, 62.0, 58.0, 57.0, 56.0, 45.7)`，公式为 `批数 × (61.4 + 60.0) + 行数 × 3.45 + 批数 × 中位`。
      b393 的 `160.0s` 是特例（当批重排了收口顺序并多一次提交），b400 起**计入** 8 批中位，不再剔除，避免两套常数。
    - **`TOOL_TRIP` 只能来自仪器（b395 起）**：逐条登记在 `_annot_baseline/trip-log.tsv`（批次/命令/原因/秒数/时间戳），
      `estimate-lib` 优先读它，台账文本 `TOOL_TRIP:` 仅作回退。禁止「取整段」「取中值」手挑。
    - **`S3b` 切分状态（b397 定稿）**：b390–b394 分开可算；b395 合并、b396 名义分开实质合并，**B 口径对这两批不可算**。
      当前窗口 `b396/b395/b394` 含两批不可算样本，B 只在历史台账备查；主报固定 A。b397 起台账 `Write` 完成即打点、数据行写完再打点。
    - **`S5_closeout` 预登记（b397）**：区间 `[160.0, 220.0]s`，点估计 `190.0s`；最终报告同时给「不含 / 含」两数，
      `0.30h` 标「常规批口径」（含 ≈ `0.34–0.36h`）。
    - **`池外残差` 降为异常字段（b397）**：基线 `3,233`，只在 ≠ 3,233 时报告；恒定是 `全仓 − 池内` 同减的结果。
    - **最后一批 `plan=19` 验收预登记（b397）**：`removed − selfclear == 19`；`allowed = 19 + selfclear_rows + auto`；
      `pool_remain=0` 且 `ALIGNED ... diff=0 OK`；六闸全绿 `n=0`；`1,520 = ACTIVE + CLEARED` 与集合恒等只标定义。
    - **`order` 字段改名（b397）**：`total=` → `elapsed_since_start=`（上一提交 → 本提交整段墙钟，与收口段无关）。
    - **白名单刷新结构化（b398）**：`closeout --report-only` 开头强制跑 `own-commits-gen`，不再依赖「第 10 步记得跑」；
      文档提交后再跑 report-only 不会出 `WHITELIST STALE`，`S5` 的补记提交在结构上不再必要。
    - **主报两项统一统计量（b398 起，b400 统一 8 批中位）**：收口项 = 窗口 3 批中位；`S5` = 8 批实测中位
      `60.0 = median(160.0, 96.4, 84.0, 62.0, 58.0, 57.0, 56.0, 45.7)`；旧 `57.0 = median(57.0, 45.7, 58.0)` 是 3 批小样本，b400 起作废，不再两套常数并用。
    - **旧判据删除（b398）**：「`S3b` 是否为实际写作工作量」在现行拆分下不可算，改以 **A 口径是否含全部文档写作** 定义；B 仅窗口三批都有独立 `S3b` 时可用。
    - **批报固定三列（b398）**：`清理行 / 全仓清零文件数 / 新进` 必须单列，缺一项写「缺」（b397 漏报，当批 `20 / 17 / 0`）。
    - **批前 done 脚本校验（b399）**：`closeout` 打印 `[批前校验] pre_done == prev_done`，不等即 `exit 2`；
      批前值禁止手填（已三次手抄出错：`1,412 文件`、b392 `S2 35.6`、b397 前 `7,342`）。
    - **`S5` 剔除缺陷样本（b399）**：`57.0 = median(57.0, 45.7, 58.0)`，`84.0`（b397 白名单失效）按 `TOOL_TRIP` 同一规则退出常数，
      台账标「构造值」；b398 的 `57.5` 留痕，主报同为 `0.15h`。
    - **GATE-DEBT 8 条落地（b399）**：§6 逐条给 id 与「接受」理由，§0 增一行「未清 8 条，均为口径边界/工具近似」。
    - **收口两行口径（b399）**：池内完成与全仓残留必须分两行，后者引收口时刻实测并注明「扫描归类量，不等于上游债余额」。
    - **EOL 判定前置（b400）**：落笔统一走 `_annot_baseline/apply-lines.mjs`，先按行识别行尾再替换，禁止整文件统一行尾；
      b391/b399 两次 `eolChanged` 返工（合计约 110s）在结构上不再发生。
    - **`*_runs` 固定字段（b400）**：批报与台账必须列 `record_runs / verify_runs`，`> 1` 时写原因与秒数；`n=0` 不能盖住重试。
    - **阈值换代封顶（b400）**：cap 20 的唯一一次换代已在 b396 用掉，此后固定 `173.25`；只有档位变更才允许再换。
    - **`S5` 覆盖只 8 批（b400 定稿）**：`S5` 数值只在 b393–b400 有（`619.1s`）；其余 43 批按 8 批中位 `60.0` 估算 `2,580.0s`，主数 `4.64h`、副数 `3.93h`。不得用「51 批」标题装只覆盖 8 批的分项。
    - **`CLOSEOUT_BATCH` 排除（b400）**：b400 含终表与总账，标 `CLOSEOUT_BATCH: true`；实测值保留，**建模窗口退为 `b399/b398/b397`**，不把收口批混进样本。
    - **`Navigation.tsx:308` 的 `W` 口径（b400 复核）**：原文是纯中文「手机断点下容器改为纵向居中…」，无标识符才判 `W`；`` `lg` `` 在反引号内满足 `ident()` 的 2 字符规则
      （实测 `ident('`lg` …') = ['lg']`、`isWeakContent=false`），`judge-generic` 与 `zc-gate-v4` 同一实现，**不存在两套口径**；台账原写「仅 `lg` 两字符」为误述，已订正。
    - **模型区间 `0.06–0.09h`（历史值，已降级）**（系数取实测比值极值 `×0.73 / ×1.19`：b388 `1.19` / b389 `0.73` / b390 `0.874` / b391 `0.81` / b392 `1.15` / b393 `0.90`）。
      **手算复算见 CLOSING §5.4**（现为实测累计 7 步：三项实测 + S5 缺口估算 + 主/副数）。
    - **模型杠杆（历史值，随 `0.08h` 降级）**：维持 `95.0s` 则 `0.08h`；回到 `77.0s` 则 `0.07h`。
    - **观测上下界 = `0.05–0.07h`（参考，不进主报）**：`1 × 178.8s ≈ 0.05h`、`1 × 262.0s ≈ 0.07h`，
      两端是窗口 `b399 / b398 / b397` 的**净**批墙钟（`262.0 / 178.8 / 242.0s`）。
    - **为何撤掉包络主报（b384）**：六版区间 `1.3–3.9 → 1.5–2.1 → 1.3–2.0 → 1.4–1.9 → 1.1–1.6 → 0.7–1.8`
      每一版都由某一批进出窗口决定，没有一版来自模型。过定拟合已立住（**4.2% 为 in-sample 残差**）；b400 起主数为**含 `S5` 估算的 `4.64h`**（副数 `3.93h`），模型只作历史对账。
      **事故成本从此不进任何报数**：b381 的 40s、b376 的 86s 都不再抬高成本结构。
      ~~1.1–1.6h~~、~~1.3–1.5h~~、~~1.3–2.0h~~、~~1.6–2.1h~~、~~1.5–2.1h~~、~~1.3–3.9h~~、~~1.2–1.7h~~、~~1.3–4.5h~~、~~2.6–4.5h~~ 均已作废，仅作对账。
    - **`1.7h` 只在「收口回到 61s 且 s/行 回到 3.18」时成立**，即 `38 批 / 收口 61s 时的下界`——
      它与已作废的「45 批 × 136s = 1.7h」**没有任何推导关系**，只是数字撞车。
    - **估计器（b379 起改口径，`s/行` 退役；b380 起只剩过定拟合；b384 起包络降为参考）**：主报只有一个数——
      **`a + c_l·L + 批数 × 收口` 的模型输出**。窗口 min/max 包络只作「观测上下界」旁注，不进主报、不进任何决策。
      **分段计时一律保留一位小数**（b383 起）：`S0–S4` 相加必须等于收口，`53.6 ≠ 54`——写 `53.6s`，
      `批墙钟` 也按一位小数与之对齐，不许出现「差 0.4 说不清」的尾巴。
      `controllable s/行` 退到台账明细，**不再进主报**：b378 那种「10 文件 × 1 行」的批 `9.10 s/行` 没有信息量，
      却把窗口的 `s/行` 中位抬到 7.00，纯属行驱动口径的遗物。
    - **当前窗口 b399 / b398 / b397（b400 标 `CLOSEOUT_BATCH` 已排除）**：净墙钟 `262.0 / 178.8 / 242.0s`、净收口 `95.0 / 77.0 / 114.0s`（中位 95.0s，仅历史参照）。
      三批都无工具往返（`TOOL_TRIP` 全 0），本窗口中位**不含构造值**。
      **b394 起不再整批剔除**：b381（`capacity` 顺序错 40s）与 b384（两次解析返修 29s）的 `ACCIDENT_TIMING` 撤销，
      改为 `TOOL_TRIP` 扣减、批次保留；`ACCIDENT_TIMING` 只剩 b389（整批不可信）。理由：整批剔除会把真实写作/对账一起扔掉，且逐批剔除会让窗口系统性偏小。
      剩余 **0 批 / 0 文件 / 0 行**（b400 已收口，`pool_remain=0`）。
    - **⚠ 旧上沿形状标注作废**：`1.49h` / `231s` / `240s` 这一套随事故批剔除，只作历史；
      参考区间上沿现在是 `176s`（b385 的 `10 文件 / 20 行`），**不是** `240s` 的 `10 文件 / 24 行`。
    - **收口中位与观测包络必须同源（b385 定死，b394 改扣减）**：台账里的 `TOOL_TRIP:` 在**中位与包络两处同时扣**；
      只有 `ACCIDENT_TIMING:`（整批不可信，当前仅 b389）才两处同时剔除。不许一边扣一边留。
      `closeout.mjs` 每批打印 `[窗口]`、`[工具往返]`、`[观测包络]`，报表照抄。
      当前中位取自 **b399 / b398 / b397**（净 `95.0 / 77.0 / 114.0s` → `95.0s`）；b389 标事故、b400 标 `CLOSEOUT_BATCH`，两处都不进。
      窗口只由「最近三批非事故」决定，**不人为固定**；每批 `[窗口]` 行写明实际用了哪三批。
    - **剩余形状旁注（b385 起必写）**：b400 收官后剩余 `0 行 / 0 文件`，`plan=19` 已全部落笔，池内归零。
      模型按这个形状外推；出现多行文件时须重述适用性，不许临时解释。
    - **点估计的已知缺口**：公式丢掉 `c_f` 项，`|c_f| ≲ 1.3 s/文件 × 19 ≈ 25s ≈ 0.01h`，
      所以 `0.08h` 的不确定度约 ±0.01h（另加 ×0.73/×1.19 的外推区间）。这一项只作旁注，不进公式。
      **逐批必报（b384 起）**：批报与台账每批给出「批数 / 剩余行 / 收口中位」三项与结果，不许一批有一批无。
      b383 漏报，已在 b383 台账补记 `1.19h`。
    - **窗口移动（b378–b380 相对 b377–b379）**：`231s` 滚出、`176s` 滚入 → 中位墙钟 `179 → 176s`；
      区间 `1.3–2.0h → 1.3–1.5h`（上沿从 231 换到 179，是离群形状滚出，不是精度提升）。
    - **下一次替换**：窗口 b379–b381 重算，只报「中位墙钟移动多少 → 区间变成多少」。
    - **⚠ 区间宽度随窗口内离群值伸缩 ≠ 精度提升**：`1.3–3.9h → 1.6–2.1h → 1.3–2.0h → 1.3–1.5h` 的收窄与回宽，
      全部由离群批进出窗口造成（`451s` 与 `417s` 已滚出），不表示把握变大。看区间本身，不要当收敛证据。
    - **⚠ `c_f` 只有上界，没有等号（b380 复核后改写）**：b377/b378 两点解 `c_f = 5.5`；
      b379（`F=5, L=15`）外推应 81.5s、实测 **118s**（+45%）；三点解 `c_f = −1.8` 是**共线产物，不能编物理意义**。
      b380 的对照：`F=5/L=15` 与 `F=10/L=16`，`controllable` 分别 **118.0 / 118.0 s**。
      **这一对的独立性（必读）**：两批各自跑 `gate-run --start` 取 `t-start`、各自 `zc-commit-v13` 取提交时间，
      两端独立记录；但**提交时间是 git 秒级时间戳，`controllable` 的显示精度是 0.1s、真实分辨率只有 1s**，
      所以两个 `118.0` 应读作 **`118.0 ± 0.5s`**，不是「精确相等」。
      按 `ΔF = +5`、`ΔL = +1`、噪声 ±5s：`c_f ∈ [−1.3, +0.9] s/文件` → **结论写成 `|c_f| ≲ 1.3 s/文件`，不是 `c_f = 0`**。
      等号在这种数据上不成立，上界才成立；`c_f` 不进任何公式。
    - **⚠ 标定批不是随机批**：b378（10 文件全 1 行）是装箱最后一批，即「最省形状」；b379 的 `F=5`、b380 的 `F=10/L=16` 也都是刻意选形。
      三批读数天生偏乐观，**不得当作平均形状引用**。
    - **⚠ 两点闭环检验的是可加性，不是参数准度**：`159 vs 156` 只证明 `墙钟 ≈ 起草 + 收口`；
      用 N 点解 N 个未知数残差恒为 0，所以「预测—实测吻合」在点解里是恒等式，不是证据。
      要验证参数必须留**不参与求解**的额外点（b379 就是这样的点，结果把假设证伪了）。
    - ~~「INDEX 增量改每 3 批一次」能把上沿从 4.5h 压到 3.9h~~ ——**该推论基于 b372 的估算分解，已作废**。
      实测口径：工具段（扫描 + 白名单 + 容量）合计 **9s**，收口几乎全是写作；
      因此「收口 ≤150s」在工具侧无障碍，瓶颈只在台账写作轮次本身。
    - 固定成本切两段：`64×75 = 80min`（cap 6）对 `38×75 = 48min`（cap 10）；
      收口一项 `35×61 = 36min`（旧口径）→ `64×61 = 65min`（cap 6）→ `38×61 = 39min`（cap 10，仅下界情形）。
    - **里程碑 = 池内可写行归零（b372 末 623 → 0）**，不是 100%：`7,421` 的 100% 不可达（495 行上游永不可写）。
24. **「清零」必须区分池内 / 全仓（b374 起）**
    - **池内清零** = 该文件在池内的可写行全部改完（capacity 的 `REMAIN` 不再含它）→ 批报里「N 个文件清零」用这个。
    - **全仓清零** = 该文件 `deep-quality` 扫描 **0 条 weak**（含池外）→ **另报一个数**，并列出未清零的文件名。
    - b373 实测：**池内清零 10 / 全仓清零 7**，差的 3 个全是池外上游残留：
      `side-pane-full-view/model.ts:128/129/130`（blame `3c5b2276`）、
      `slashCommandHelpers.ts:51`（`0a1fc56d`）、
      `ConversationDraftSuggestedPromptsContainer.tsx:743`（`872ad960`）。
    - 与 `可清 57` 的关系：`可清 = 全仓有 weak 的文件 − 1,520`，只统计**能全仓清零**的文件；
      池内清零但全仓未清零的文件仍留在 `NEVER-CLEAR` 的 1,520 里。
      所以「池内清零数 − 全仓清零数」= 本批落进 `NEVER-CLEAR` 的文件数（b373 为 3）。
    - **固定对账列（每批必报，三个数自证）**：`清理文件数 / 全仓清零 / 新进 weak 文件数`，
      并满足恒等式 **`本批 weak 文件数 = 上批 − 全仓清零 + 新进`**；`新进 > 0` 即质量事故，须列出文件与行号。
    - **集合以 `deep-quality.mjs` 末行 `WEAK lines=N files=M` 的 `M` 为唯一真源**（b376 起）。
      旧表里的 `1,584 / 1,577 / 1,572 / 1,564` 都比末行 **+1**（差值正确、绝对值偏 1，来历已查不到）；
      下表已换成末行值，旧值不再引用。
    - 已验四批：

      | 批 | 清理文件数（池内清零） | 全仓清零 | 新进 weak | 上批集合 → 本批 | 恒等式 |
      | --- | ---: | ---: | ---: | --- | --- |
      | b373 | 10 | 7 | 0 | 1,583 → 1,576 | `1,583 − 7 + 0 = 1,576` ✔ |
      | b374 | 10 | 5 | 0 | 1,576 → 1,571 | `1,576 − 5 + 0 = 1,571` ✔ |
      | b375 | 10 | 8 | 0 | 1,571 → 1,563 | `1,571 − 8 + 0 = 1,563` ✔ |
      | b376 | 10 | 8 | 0 | 1,563 → 1,555 | `1,563 − 8 + 0 = 1,555` ✔ |
      | b377 | 10 | 8 | 0 | 1,555 → 1,547 | `1,555 − 8 + 0 = 1,547` ✔ |
      | b378 | 10 | 9 | 0 | 1,547 → 1,538 | `1,547 − 9 + 0 = 1,538` ✔ |
      | b379 | 5 | 4 | 0 | 1,538 → 1,534 | `1,538 − 4 + 0 = 1,534` ✔ |
      | b380 | 10 | 5 | 0 | 1,534 → 1,529 | `1,534 − 5 + 0 = 1,529` ✔ |
      | b381 | 10 | 8 | 0 | 1,529 → 1,521 | `1,529 − 8 + 0 = 1,521` ✔ |
      | b382 | 10 | 9 | 0 | 1,521 → 1,512 | `1,521 − 9 + 0 = 1,512` ✔（2 条相邻自清；~~可清 −8 → 到底~~ 作废） |
      | b383 | 10 | 9 | 0 | 1,512 → 1,503 | `1,512 − 9 + 0 = 1,503` ✔（~~可清 −17~~ 是净值，不是干净条数；见 §6.2-24） |
      | b384 | 10 | 9 | 0 | 1,503 → 1,494 | `1,503 − 9 + 0 = 1,494` ✔（10 清 9；`conversationShareHttpClient` 留 2 行上游） |
      | b385 | 10 | 7 | 0 | 1,494 → 1,487 | `1,494 − 7 + 0 = 1,487` ✔（10 清 7；3 个文件各留 1 行上游） |
      | b386 | 10 | 10 | 0 | 1,487 → 1,477 | `1,487 − 10 + 0 = 1,477` ✔（10 清 10，无池外残留遗留） |
      | b387 | 10 | 5 | 0 | 1,477 → 1,472 | `1,477 − 5 + 0 = 1,472` ✔（5 个文件各留 1 行上游；表外差集 0/2） |
      | b388 | 10 | 7 | 0 | 1,472 → 1,465 | `1,472 − 7 + 0 = 1,465` ✔（3 个文件留 8 行上游；表外差集 0/2） |
      | b389 | 10 | 9 | 0 | 1,465 → 1,456 | `1,465 − 9 + 0 = 1,456` ✔（1 个文件留 1 行上游；表外差集 0/1） |
      | b390 | 10 | 8 | 0 | 1,456 → 1,448 | `1,456 − 8 + 0 = 1,448` ✔（2 个文件留 3 行上游；表外差集 0/0；1 条邻接自清） |
      | b391 | 20 | 15 | 0 | 1,448 → 1,433 | `1,448 − 15 + 0 = 1,433` ✔（表外差集 0/3；cap 20 首次） |
      | b392 | 20 | 14 | 0 | 1,433 → 1,419 | `1,433 − 14 + 0 = 1,419` ✔（表外差集 0/5；闸出 `removed=23`、`selfclear_batch=3`，收口侧与 `plan.tsv=20` 比对 → OK） |
      | b393 | 20 | 20 | 0 | 1,419 → 1,399 | `1,419 − 20 + 0 = 1,399` ✔（表外差集 0/13 全 `annotation`；首轮 `pool-diff n=0`、`removed−selfclear=20=plan`） |
      | b394 | 20 | 19 | 0 | 1,399 → 1,380 | `1,399 − 19 + 0 = 1,380` ✔（20 文件只清 19：`nodeApiClient` 还剩 1 行上游；表外差集 0/10 全 `annotation`） |
      | b395 | 20 | 15 | 0 | 1,380 → 1,365 | `1,380 − 15 + 0 = 1,365` ✔（4 个文件各剩 1 行上游；表外差集 0/11 全 `annotation`；行数侧 `3,352 − 20 = 3,332` 独立对上） |
      | b396 | 20 | 19 | 0 | 1,365 → 1,346 | `1,365 − 19 + 0 = 1,346` ✔（1 个文件剩 1 行上游；表外差集 0/9 全 `annotation`；行数侧 `3,332 − 20 = 3,312` 独立对上） |
      | b397 | 20 | 17 | 0 | 1,346 → 1,329 | `1,346 − 17 + 0 = 1,329` ✔（3 个文件各剩 1 行上游；表外差集 0/8 全 `annotation`；行数侧 `3,312 − 20 = 3,292` 独立对上） |
      | b398 | 20 | 18 | 0 | 1,329 → 1,311 | `1,329 − 18 + 0 = 1,311` ✔（2 个文件各剩 1 行上游；表外差集 0/10 全 `annotation`；行数侧 `3,292 − 20 = 3,272` 独立对上） |
      | b399 | 20 | 14 | 0 | 1,311 → 1,297 | `1,311 − 14 + 0 = 1,297` ✔（5 个文件各剩 1 行上游；表外差集 0/7 全 `annotation`；行数侧 `3,272 − 20 = 3,252` 独立对上） |
      | b400 | 19 | 14 | 0 | 1,297 → 1,283 | `1,297 − 14 + 0 = 1,283` ✔（19 行全部落笔；表外差集 0/8 全 `annotation`；行数侧 `3,252 − 20 = 3,232`；池内归零；**`CLOSEOUT_BATCH`**） |

      十九批的差额（3 / 5 / 2 / 2 / 2 / 1 / 1 / 5 / 2 / 3 / 0 / 5 / 7 / 9 / 2 / 5 / 5 / 1 / 5）都是「本批只清池内、文件里仍留池外上游残留」，**不是质量事故**。
      **清零要分两列（b392 起）**：`注解清零`=最后一行 weak 由本批改写清除；`归类清零`=无改写行、仅因块尾 `*/` 邻接位移离场。
      b390–b400 均为 `8/0`、`15/0`、`14/0`、`20/0`、`19/0`、`15/0`、`19/0`、`17/0`、`18/0`、`14/0`、`14/0`；`全仓清零` 不得被读成「整文件注干净」以外的含义。
      **恒等式不得计入校验通过项（b395 起）**：`ACTIVE + 表外 == 扫描文件数` 中 `表外` 是减法导出的残差，
      等式必然成立；台账里一律写「定义恒等，非校验」。独立校验只有四条：`ALIGNED OK`、1b（`plan == HEAD 新增行`）、
      pre/post 快照差集、全仓 weak 行数变化 vs 清理数。
      **表外差集加 `cause`（b392 起，b393 降到行级）**：`+` 行只允许 `new-weak` / `classification`；
      `-` 行按 `plan.tsv` 的行号集合判：移除的 weak 行**全部**落在计划行 → `annotation`，**一条都不在** → `classification`，
      **部分在** → `mixed(命中/总数)`。未知即未归因，不许两种成因共用一列。
      `mixed` 至今未观测到，规则按行级预置（b392 的 5 个表外文件各只有 1 行 weak 且正是计划行，是文件级与行级一致的巧合）。
    - **`可清` 退役（b384 起）**：~~`可清 = 集合末行 − 1,520`~~ 与 ~~`可清 = 集合末行 − 当前仍含 weak 的 NEVER-CLEAR 文件数`~~ 一并作废。
      实测（b383 扫描）：`NEVER-CLEAR.tsv` 1,520 条中 **108 条已彻底干净**，不是 17；同时 **91 个含 weak 的文件不在表内**，
      净值 `1,520 − 108 + 91 = 1,503` 才等于集合末行。`−17` 是这个净值，被当成「干净条数」会少算 91；
      两个数交叉抵消，所以「可清」既不等于干净条数，也不能用来判定到底。
    - **b384 起只报两列**：**池内可写行**（= `acct_remain`，b389 为 219）与 **池外残留行**（= 全仓 weak − 池内可写，b389 为 `3,456 − 219 = 3,237`），
      两列相加恒等于 `WEAK lines=`。文件侧同理只报「池内可写文件 209 / 池外残留文件」。
      `NEVER-CLEAR.tsv` 新增 `status` 列：`CLEARED`（b389 为 148，移出「仍在扫」）/ `ACTIVE`（1,372）。
    - **四个数每批同时给，恒等式差必须为 0（b385 定死）**：**`全仓含 weak 文件数 = ACTIVE + 表外`**。
      「表外」是「有 weak 但不在 1,520 快照里」的文件数——b360 建表时未采全的部分，
      不能用「新进 0」代替。回算（同一份 `NEVER-CLEAR.tsv` 对逐批 `*-repo-post.txt`）：

      | 批 | 集合 | ACTIVE | 表外 | 新进（文件集差） |
      | --- | ---: | ---: | ---: | ---: |
      | b376 | 1,555 | 1,456 | 99 | 0 |
      | b377 | 1,547 | 1,448 | 99 | 0 |
      | b378 | 1,538 | 1,441 | 97 | 0 |
      | b379 | 1,534 | 1,437 | 97 | 0 |
      | b380 | 1,529 | 1,434 | 95 | 0 |
      | b381 | 1,521 | 1,426 | 95 | 0 |
      | b382 | 1,512 | 1,418 | 94 | 0 |
      | b383 | 1,503 | 1,412 | 91 | 0 |
      | b384 | 1,494 | 1,405 | 89 | 0 |
      | b385 | 1,487 | 1,398 | 89 | 0 |
      | b386 | 1,477 | 1,388 | 89 | 0 |
      | b387 | 1,472 | 1,385 | 87 | 0 |
      | b388 | 1,465 | 1,380 | 85 | 0 |
      | b389 | 1,456 | 1,372 | 84 | 0 |

      **结论**：表外 `99 → 89` 单调下降，**没有一批表外上升**；但总量不变不足以证明无进出，
      b386 起以差集为准。b384→b385 差集为空（0/0），这十批的「新进 0」在总量上成立。
      但「新进 0」只证明「没有新文件进来」，**不能**证明「快照采全了」——表外始终有 89–99 个。
      此前把「新进 0」读成「无遗漏」是错的，b376–b385 的该列一律加注「表外 N」。
      b384 的 `1,405 + 89 = 1,494` 与 `1,520 − 115 + 89 = 1,494` 两条同时成立，差 0。
    - **表外差集每批落盘（b386 起）**：`ZC-deep-<batch>-outside-diff.tsv` 两列 `+` / `-` 文件名，空集也提交。
      理由：集合总量不变也可能是「走 1 进 1」，`表外 99 → 89` 单调不升**不足以**证明「新进 0」。
      b384→b385 实测 `新增 0 / 移除 0`，空表已落盘；从 b386 起每批必须给出这两列与名单。
    - **文件侧的 done/remain 只跟「池内清零」走**：b378 `683 → 693`、b380 `698 → 708`、b381 `708 → 718`
      （`remain 299 → 289`），而全仓集合两批各少 5 / 8。两个数每批都不同，禁止混用。
25. **`allowed` 是什么（b378 写死；b384 改现场计算）**
    六闸 `pool-diff` 的 `allow` 清单 = **本批 plan 行数 + 自清表既有数据行 + 本批自动登记**：
    `allowed = plan + selfclear_rows + auto`。**三项每批都写数，自清表行数不许当常数写死。**
    `POOL-SELF-CLEAR.tsv` **没有表头**；b384 实测：文件 20 行 = `#` 注释 6 + 空行 0 + 数据 **14**（手工 6 + 自动 8）。
    - b383：`24 + 14 + 0 = 38`。b382：`30 + 12 + 2 = 44`（gate 先读 12 行，自动登记 2 条后重算）。
      旧串 `42 / 22 / 27 / 28 / 44 / 38` 里的台阶全是 plan 变化 + 表增长，**没有一处是常数 12**。
    - `closeout.mjs` 的 `[1c allowed]` 行现场读表并打印这三项；台账照抄，不再手算。
    - **订正**：b378 版把自清行数写成常数 12；b382 起表已 14，该写法失效。b370–b377 台账的「数据 11 行」保留原文、按本条作废。
26. **池内可写行归零之前的执行规则（b381 写死；b384 按新口径改写）**
    现状：**池内可写 339 行 / 269 文件**，**池外残留 3,237 行**（全仓 `WEAK lines=3,576`）。
    ~~「可清」~~ 指标退役，「集合到底」也不再成立：集合 1,503 是 `1,520 − 108 CLEARED + 91 新进` 的净值。
    - **批次照跑**；停批的唯一条件是 **`pool_remain = 0`**，不是集合不动、也不是某个派生指标归 0。
    - 批报与台账的剩余行**固定拆两列**：`池内可写 339` / `池外残留 3,237`，两列相加必须等于 `WEAK lines=`。
    - 集合末行只作观测，随 `CLEARED` 与新进两边同时变动，**不作进度分母、不据此判到底**。
    - **「完成」的判据只有一个**：`ALIGNED acct_remain == pool_remain` 且 `pool_remain = 0`
      （行 7,421 全部处理完），**不要求**全仓 `weak = 0`、也不要求集合降到 0——
      `NEVER-CLEAR` 的 `ACTIVE` 条目按定义不清，它们会一直出现在全仓扫描里。
    - 收尾时对外只报两个数：**行侧 100%（7,421 ÷ 7,421）** 与 **池外残留行数**，
      并注明「残留不可写：上游 blame 或早于池基线 `8f7daaf0` 的本线提交」。

## 7. 口径事故（2026-11-10，b236）

b236 首跑（v4）报 `删上游注释 n=4`、退出码 1。逐行 blame 后确认这是**两类问题混在一起**，不是一条：

1. **3 行假阳性（判据缺口）**：`app-question-state.ts:57/282/325` 的 blame 是
   `a7af675d docs(注释): L2-B10b 覆盖补齐 tui 与 office-runtime`——本线注释提交，但标题以 `docs(` 开头，
   旧判据只认「注释」开头的标题，于是判成上游。处置：v5 把 `docs(注释)` 并入本线前缀。
   放宽方向只影响「删本线注释」这一类，历史批次的通过条件里没有这一项上限，因此历史结论不变。
2. **1 行真上游（定性错）**：`cuaDetails.tsx:86` 的 blame 是 `872ad960 feat: open source`（导入提交）。
   b234 判它「真水」是对的，但归属没核，按「下一批清」立项是错的。处置：原样还原，登记为
   「上游真水，不可清」（见 `ZC-deep-b236.md` §5）。

**由此新增两条使用约束**：

4. 判「真水/待清」时必须同时给 blame 归属；`feat: open source`（及任何不在白名单里的提交）的行一律先归「不可清」，不进待清队列。
5. 归属判据本身是尺子的一部分：改它就算换版（v4→v5→v6），必须归档 + 在本表记「首个使用批次」，不得就地改活文件后不归档。

## 8. 判据改根（2026-11-10，b237，v5 → v6）

§7 的处置（补 `docs(注释)` 前缀）只是补洞，洞还在：标题换写法（`注释(docs):`、`annot(b237)`、纯 `b237`）就
再错一次，而且**两个方向都可能错**——把本线判成上游只是多拒一次；把上游判成本线会放行改写上游注释，破 §2.6。

v6 把判据从「标题前缀」换成「blame sha ∈ 台账白名单」：

- 实现：[`own-commits.mjs`](own-commits.mjs) 从各批台账的 `提交 <sha>` / `git log` 证据块 / `安全快照 <sha>` 自动抽，
  再叠加 [`OWN-COMMITS.md`](OWN-COMMITS.md) 手工登记的 L2 覆盖提交；`zc-commit v6` 只问「这个 sha 在不在集合里」。
- 白名单是**可审计的增长物**：新增批次按惯例在台账写 `提交 <sha>` 即自动进表；漏写只会更严（本线行被判上游），不会放行。
- 回放验证：b236 那 4 行用 v6 重判为「3 本线 + 1 上游」，`exit=0`；b237 首跑又拦下 4 行 `feat: open source`
  的真上游（见 `ZC-deep-b237.md` §3），没有误放行。

## 9. 工具输出可信度缺陷（2026-11-10，b241 归纳）

共同形态：**工具退出码 0、输出看着对、结论是错的**。三次都不是崩溃，所以只能靠「拿另一条路径复算」发现。

| # | 批次 | 缺陷 | 错误假设 | 症状 | 处置 |
| --- | --- | --- | --- | --- | --- |
| 1 | b229 | 位置参数错位 | 以为 `git diff --numstat` 的列序固定为「增/删/路径」 | 重命名行的 `a/…` `b/…` 被当成两个路径，行数错位 | 改用 `^(\S+)\t(\S+)\t(.+)$` 正则匹配并按路径索引 |
| 2 | b240 | 漏传参数 | 以为 `--files` 可以省略、默认扫描工作区 | 统计范围混入其它会话的 14 个脏文件 | 一律显式传 `--files` / `--file-list` |
| 3 | **b241** | **读文件时假设「首行是表头」** | 以为 `weak-own-by-file.tsv` 有表头，`Select-Object -Skip 1` 跳过首行 | 分档表行数多 34、已清文件数少 2（b239 发现） | 改为「形状校验」：只跳过不匹配 `^\d+$` 的行，不按位置跳 |

**由此新增一条使用约束**：

6. 脚本从文件读数据必须做**形状校验**（正则/类型/列数），禁止用 `Skip 1` / `head -1` / `slice(1)` 按位置跳过首行；确实要跳首行时，必须同时写下「该文件首行是什么、为什么可跳」，并在台账留一行证据。

**b241 对 `_tools/` 的全量审计**（`slice(1)` / `-Skip 1` / `head`）：

- 真·表头假设：`vk-calib-ctx.mjs:18`、`vk-calib-stats.mjs:24`、`vk-calib-recheck.mjs:7`、`vk-calib-weak.mjs:5,7`、`uv-audit60-cross.mjs:10`、`tmp_r52_sample_csv.mjs:22`。逐个核对首行，`vk-calib.tsv` / `vk-calib-stats.tsv` / `audit60.csv` **确有表头**，写法正确。
- 首行是汇总横幅而非表头：`B69-debug-lua.mjs:514`、`B70-check-rdb.mjs:679`，输入首行是 `uncovered 382 branch 65`，`slice(1)` 正确。
- 其余 `slice(1)` 均为剥 diff 的 `+`/`-` 前缀，不是行数组跳过。
- 活工具（`zc-commit` v10 / `capacity-estimate` / `own-commits` / `deep-quality`）已是形状校验：`capacity-estimate` 基线逐行 `^\d+$`，`zc-commit` 对 numstat、blame 用正则匹配。

**第四例（b242）：新增注释行只收 `//` 行。** 门禁按 `t.startsWith('//')` 归档新增注释，JSDoc 的 `*` 行既不计数、也不过 W/L/POEM 判据（`isComment` 认它，所以也没进「新增非注释行」黑名单，直接蒸发）。b242 首跑 `新增注释行 n=7` 而 numstat `+9`，差值 2 正是两条 JSDoc 新行——查对不上才发现。v8 已改为 `//` 与 `*` 都计数，`*` 行剥掉前缀后同样过判据（空行与 `*/` 除外）。

**第五例（b243 回溯查出）：块注释起始行 `/*` 仍不计数。** v8 只补了 `*` 行，`/** x */` 这种单行 JSDoc 的正文全在起始行上，仍被跳过。b240 台账 `新增注释行 n=13` 而 numstat `+39`，差的 26 行全是单行 JSDoc；把 26 行交给 `judgeEntries` 后命中 3 条（W/W/L，均为 b240 本线改写的上游一行注释），已用 `1c54edbb` 逐条补修。v10 收 `/*` 起始行（剥 `/*` 与尾 `*/`）。**这条同时说明「n 与 numstat `+` 的差值必须逐项解释」**：b242 因差 2 抓住了洞，b240 差 26 却没人对，同一个信号漏了 26 倍。

**第六例（b244 归属审计查出）：门禁看不见「新增行是否被更高一层注释掉」。** `// // 正文` 被 `contentOf` 剥掉一层后仍是 `// 正文`，判据里 `ident()` 可能命中正文中的英文标识符，整行通过；双前缀本身没有判据。全仓 802 行双前缀（15 个代码文件）blame 后 **本线 802 / 上游 0**——由 `a8784b7e`（b1–b226 工作区快照）引入，父提交 `8f7daaf0` 里为 0 行。把 802 行各自再剥一层后交 `judgeEntries`，命中 **144 行**。与 valkey 宏续行、drizzle 参数列表插入同属「门禁只看新增行形状」缺陷族；**b245 已上线硬拒绝**（zc-gate v4 `isNestedComment` + zc-commit v11，802 行负例回放 802/802 拦住），802 行存量按 `ZC-deep-b245.md` §9 分类为 658 合格 / 144 仍水，尚未清理。

**判据互斥（b244 返工教训）：W 与 L 是同一条线的两端。** `CodingPlanUsageRemainingPanel.tsx:426` 先因 `L 无信息列举`（≥2 个分隔符且无谓词）被判，删掉标识符后变成 `W 单行无信息`（无标识符锚点）。合格行必须同时满足：有标识符锚点（避开 W）+ 有谓词或分隔符 < 2（避开 L）。逐行改水句时先按这两条自检，再跑门禁。

结论：存量无需改脚本（输入确有待跳过的首行），约束 6 只约束**新写的**脚本。

## 10. 同名文件版本陷阱（2026-11-10，b241；b242 已处置）

`docs/annotation/_tools/` 下同时存在 `zc-commit.mjs` 与 `zc-commit-v1…v10.mjs`。b242 起旧副本已改名，不再可执行：

| 路径 | blob sha1 | 版本 |
| --- | --- | --- |
| `_annot_baseline/zc-commit.mjs` | `066509a32c52` | **v10，当前活文件** |
| `_tools/zc-commit-v10.mjs` | `066509a32c52` | v10 归档，与活文件逐字节一致 |
| `_tools/zc-commit-v9.mjs` | `1542e4088fd2` | v9 归档（b243 本体实跑版本） |
| `_tools/zc-commit-pre-v6-DO-NOT-RUN.mjs` | `f2661d7008ee` | v4 内容，**已改名，当前不执行** |

b241 首跑门禁误用了 `_tools/zc-commit.mjs`（v4 判据），七行结果恰好与 v6 一致（12 行全是 `a8784b7e`，两种判据都认），
但**流程错了**：跑门禁一律用 `_annot_baseline/zc-commit.mjs`。v7 起门禁自己打印 `GATE self=<path> blob=<sha1>`，
报告里的 `ruler=` 直接抄这一行，不再靠人手填。

## 11. 注解分支 vs origin/main：三态门禁与禁合并约定（2026-11-11，b275 前）

**长期例外**：本线分支不跟 `sync ZCode source` 的 vendor 同步。同步提交动辄数千文件、数十万行，
而本线是 1→1 注释改写，两者混在一起没有任何自动办法区分「上游真改动」与「本线注解」。

**三态判据**（`scripts/check-workspace-freshness.mjs`，`SYNC_SUBJECT = /sync ZCode source/i`）：

| 状态 | 条件 | 门禁行为 | 必须打印 |
| --- | --- | --- | --- |
| `aligned` | `commits_behind == 0` | 通过 | 无 |
| `behind-clean` | `commits_ahead == 0` 且 `commits_behind > 0` | **红**（`exit 1`，同旧口径） | 落后提交数 |
| `diverged-expected` | `commits_ahead > 0` 且 `HEAD..origin/main` 的 subject **全部**匹配 `sync ZCode source` | **不红**（`exit 0`） | `commits_ahead` / `commits_behind` / 上游最后一次 sync 的 sha 与时间 |
| `diverged-unexpected` | `commits_ahead > 0` 但含非 sync 提交 | 警告不失败，逐条列非 sync subject | 同上 |

**禁令（写死，不是建议）**：本线**只允许 `commit`**，禁止 `merge` / `rebase` / `push --force`。
将来若真要同步，**先单独上报**，并给出两个数再议：

1. **注解提交数**（本线 ahead 的提交数，即要被「挪过去」的量）；
2. **上游触及文件数**（sync 提交 `--stat` 的文件数）。

理由是这两个数一旦倒挂（上游改动量 ≫ 注解量），任何自动合并都会**静默吞掉注解**：
注解行的 baseLine 与上下文全变，冲突不会以「冲突」出现，而是以「这行注释没了」出现。

**快照**：分叉现状（ahead / behind / merge-base / 上游 sync sha 与时间 / 触及文件数 / 净行数）见
[`../vendor-sync-divergence.md`](../vendor-sync-divergence.md)；以后有人问「为什么不同步」先读那份，
不必重跑 `git rev-list`。

## 12. 第 11 道门禁 POOL-DIFF（2026-11-11，b307 后）

**触发**：b307 落笔 36 行、全仓 weak 少 37 行；多出的 `workspaceConnectionRegistry.ts:184`（JSDoc `*/`）
是**句元合并**的连带效应，不是池成员漂移。

- **weak 判定对邻接敏感**：`deep-quality.mjs` 的 `sentenceUnit()` 把「不以句末标点收尾」的相邻注释行
  并成一句再判；`*/` 既非结构性标记（`^\*+$` 不匹配 `*/`）也不以句末标点结尾 → 与下一行同判。
  下一行从无标识符短句改成带 `acquireWorkspaceConnection / refCount / keepWarmTimer` 的强注释后，
  整句转强，`*/` 随之不再报 weak。
- **池成员资格**：`capacity-estimate.mjs` 的池 = `git diff -U0 8f7daaf0 <HEAD>` 的 `+` 行集合；
  blame 只用于三态与自清分类。全量对拍 `035e00bd → b12c9948`：`POOL-DELTA gone=0 add=209`
  （209 行全为 `docs/annotation/` 台账，不在扫描域），扫描域内**池成员变化 0 行**；
  `WEAK-DELTA gone=37 added=0`（36 计划行 + 1 池外行）。**漂移只有 1 行。**
- **门禁**：`gate-run.mjs` 在 `commit` 之后跑 `pool-diff`——预快照（上一批全仓 weak）vs
  后快照（本批文件重扫）；消失集合必须 ⊆ 本批 plan ∪ [`../POOL-SELF-CLEAR.tsv`](../POOL-SELF-CLEAR.tsv)
  已登记行，新增 weak 一律判红；未登记消失按 `classifySelfClear` 分流：**池内**打印
  `IN-POOL SELF-CLEAR <file:line>` 并 `exit 1`；**池外 + 本批未触碰 + blame 上游**打印
  `AUTO-SELF-CLEAR <file>:<line> reason=adjacent`、自动追加登记行（第 6 列 `auto`）后继续；
  其余（blame 未解析 / 本线 blame）打印 `UNREGISTERED SELF-CLEAR <file:line> (<原因>)` 并 `exit 1`。
  缺预快照同样判红（失败闭合）。细则与负例见 §12.4 与 `ZC-deep-b313.md` §0。
- **实测**：b307 `gate: PASS pool-diff n=0 removed=37 added=0 allowed=37`；
  负例（不喂登记表）→ `:184` 被拦、`exit=1`。b313 起闸行附 `auto_self_clear=N`（b313 = 0）。

## 12.1 句元合并的敏感度与口径定死（2026-11-11，b309 前）

**问题**：`sentenceUnit()` 把「不以句末标点收尾、非结构标记」的相邻注释行并成一句再判。
于是物理行的强弱可以继承邻居——自己没锚点的续行，被相邻行带成强；b307 的 `*/` 即此类。

**实测**（`4fb6b6f8`，`--root packages,apps,docs/knip`，v3/ast，干净工作树）：

| 口径 | weak 总数 | 文件 | 池内 `remain` | 备注 |
| --- | ---: | ---: | ---: | --- |
| 句元合并（现行） | **5,896** | 1,827 | **2,646** | 与 b308 账一致 |
| 逐行独立（关合并） | **7,983** | 2,284 | **3,692** | 差 +2,087 行 / 池内 +1,046 |

> `post-b318` 同域同口径复测：句子级 **5,514 行 / 1,798 文件 / 池内 2,268**（= 5,896 − 36 − 37 × 4 − 33 − 33 − 44 × 3），
> 与上表逐项平移一致；差值仍按 1,046 记（逐行口径非每批重测，时间平移不改变结论）。
> `post-b319` 同域复测：句子级 **5,470 行 / 1,798 文件 / 池内 2,224**（= 5,514 − 44），文件数不变。
> `post-b321` 同域复测：句子级 **5,426 行 / 1,794 文件 / 池内 2,180**（= 5,470 − 44，四个文件清零）。
> `post-b322` 同域复测：句子级 **5,384 行 / 1,790 文件 / 池内 2,138**（= 5,426 − 42，四个文件清零）。
> `post-b323` 同域复测：句子级 **5,344 行 / 1,786 文件 / 池内 2,098**（= 5,384 − 40，四个文件清零）。
> `post-b324` 同域复测：句子级 **5,302 行 / 1,784 文件 / 池内 2,056**（= 5,344 − 42，两个文件清零、两个各留 1 行池外）。
> `post-b325` 同域复测：句子级 **5,261 行 / 1,781 文件 / 池内 2,016**（= 5,302 − 40 − 1，40 落笔 + 1 池外自清）。
> `post-b326` 同域复测：句子级 **5,221 行 / 1,777 文件 / 池内 1,976**（= 5,261 − 40，四个文件清零）。
> `post-b327` 同域复测：句子级 **5,181 行 / 1,773 文件 / 池内 1,936**（= 5,221 − 40，四个文件清零）。
> `post-b328` 同域复测：句子级 **5,141 行 / 1,769 文件 / 池内 1,896**（= 5,181 − 40，四个文件清零）。
> `post-b329` 同域复测：句子级 **5,101 行 / 1,765 文件 / 池内 1,856**（= 5,141 − 40，四个文件清零）。
> `post-b330` 同域复测：句子级 **5,061 行 / 1,761 文件 / 池内 1,816**（= 5,101 − 40，四个文件清零）。
> `post-b331` 同域复测：句子级 **5,024 行 / 1,757 文件 / 池内 1,780**（−37：36 计划行 + 1 相邻自动自清）。
> `post-b332` 同域复测：句子级 **4,988 行 / 1,753 文件 / 池内 1,744**（= 5,024 − 36，四个文件清零）。
> `post-b333` 同域复测：句子级 **4,952 行 / 1,749 文件 / 池内 1,708**（= 4,988 − 36，四个文件清零）。
> `post-b334` 同域复测：句子级 **4,919 行 / 1,745 文件 / 池内 1,675**（= 4,952 − 33，四个文件清零）。
> `post-b335` 同域复测：句子级 **4,886 行 / 1,742 文件 / 池内 1,642**（= 4,919 − 33，四个文件池内清零）。
> `post-b336` 同域复测：句子级 **4,853 行 / 1,739 文件 / 池内 1,609**（= 4,886 − 33，三个文件清零，第四个留 1 行上游 weak）。
> `post-b337` 同域复测：句子级 **4,821 行 / 1,736 文件 / 池内 1,577**（= 4,853 − 32，三个文件清零，第四个留 1 行上游 weak）。
> `post-b338` 同域复测：句子级 **4,789 行 / 1,733 文件 / 池内 1,545**（= 4,821 − 32，三个文件清零，第四个留 1 行上游 weak）。
> `post-b339` 同域复测：句子级 **4,757 行 / 1,729 文件 / 池内 1,513**（= 4,789 − 32，四个文件池内清零）。
> `post-b340` 同域复测：句子级 **4,726 行 / 1,726 文件 / 池内 1,482**（= 4,757 − 31，三个文件清零，`types.ts` 留 2 行上游 weak）。
> `post-b341` 同域复测：句子级 **4,697 行 / 1,726 文件 / 池内 1,454**（−29：28 计划行 + 1 相邻自清，自清在池外；四个文件各留 1 行池外 weak）。
> `post-b342` 同域复测：句子级 **4,669 行 / 1,724 文件 / 池内 1,426**（= 4,697 − 28，两个 7/7 文件全清，另两个各留 1 行上游 weak）。
> `post-b343` 同域复测：句子级 **4,641 行 / 1,722 文件 / 池内 1,398**（= 4,669 − 28，两个 7/7 文件全清，另两个各留 2 行上游 weak）。
> `post-b344` 同域复测：句子级 **4,616 行 / 1,721 文件 / 池内 1,373**（= 4,641 − 25，`task-realtime.ts` 全清，另三个各留池外/上游 weak）。
> `post-b345` 同域复测：句子级 **4,592 行 / 1,720 文件 / 池内 1,350**（= 4,616 − 24，`wire-codec.ts` 全清，另三个各留上游 weak、1 行池外自清）。
> `post-b346` 同域复测：句子级 **4,564 行 / 1,716 文件 / 池内 1,322**（= 4,592 − 28，四个 `packages/ui` 文件全清）。
> `post-b347` 同域复测：句子级 **4,545 行 / 1,715 文件 / 池内 1,303**（= 4,564 − 19，`display.ts` 全清，另三个留上游 weak）。
> `post-b348` 同域复测：句子级 **4,517 行 / 1,711 文件 / 池内 1,275**（= 4,545 − 28，四个 `packages/ui` 文件全清）。
> `post-b349` 同域复测：句子级 **4,497 行 / 1,709 文件 / 池内 1,255**（= 4,517 − 20，四个文件全清）。
> `post-b350`（B 段首批）：句子级 **4,459 行 / 1,703 文件 / 池内 1,217**（= 4,497 − 38，六个文件全清）。
> `post-b351`（B 段第 2 批）：句子级 **4,423 行 / 1,697 文件 / 池内 1,181**（= 4,459 − 36，六个文件全清）。
> `post-b352`（B 段第 3 批）：句子级 **4,387 行 / 1,691 文件 / 池内 1,145**（= 4,423 − 36，六个文件全清）。
> `post-b353`（B 段第 4 批，方案 ①）：句子级 **4,352 行 / 1,686 文件 / 池内 1,110**（增量记账，未重跑产能）。
> `post-b354`（B 段第 5 批）：句子级 **4,321 行 / 1,683 文件 / 池内 1,080**（含 1 行自动自清，已按全量重算订正）。
> `post-b355`（B 段第 6 批，窗口收口 + 全量重算）：句子级 **4,287 行 / 1,677 文件 / 池内 1,046**（`ALIGNED diff=0`）。
> `post-b356`（B 段第 7 批）：句子级 **4,257 行 / 1,671 文件 / 池内 1,016**（增量记账）。
> `post-b357`（B 段第 8 批）：句子级 **4,234 行 / 1,668 文件 / 池内 993**（增量记账，`fix=2` 已停批）。
> `post-b358`（B 段第 9 批）：句子级 **4,204 行 / 1,662 文件 / 池内 963**（增量记账；6 文件全清，可清 376 / 含池外 1,286）。
> `post-b359`（B 段第 10 批）：句子级 **4,174 行 / 1,656 文件 / 池内 933**（增量记账；6 文件全清，可清 370 / 含池外 1,286；`fix=1`）。
> **以下 b360–b369 快照行里的「= 可写 N + 上游 495」整列作废（b371 订正）：`remain` 就是可写行，495 行上游不在 `remain` 内；只读「对基线」列。**
> `post-b360`（B 段第 11 批，窗口收口）：句子级 **4,150 行 / 1,650 文件 / 池内 909 = 可写 414 + 上游 495**；
> 全量 `ALIGNED diff=0`、探针 `onPlannedLine=0`；可清 130 / 不可清 1,520；`fix=2`、`hit_rate=12.5%`。
> `post-b361`（B 段第 12 批）：句子级 **4,125 行 / 1,644 文件 / 池内 884 = 可写 389 + 上游 495**；
> 对基线 **88.1%**、对可达上限 **94.4%**；可清 124；`fix=2`、`hit_rate=12%` → **触发语义抽检第二轮**。
> `post-b362`（B 段第 13 批）：句子级 **4,105 行 / 1,638 文件 / 池内 864 = 可写 369 + 上游 495**；
> 对基线 **88.4%**、可达上限 **94.7%**；可清 118；`fix=0`、`hit_rate=0%`（抽样通过后首批）。
> `post-b363`（B 段第 14 批）：句子级 **4,086 行 / 1,632 文件 / 池内 845 = 可写 350 + 上游 495**；
> 对基线 **88.6%**、可达上限 **94.9%**；可清 112；`fix=2`、`hit_rate=10.5%`。
> `post-b364`（B 段第 15 批）：句子级 **4,069 行 / 1,626 文件 / 池内 828 = 可写 333 + 上游 495**；
> 对基线 **88.8%**、可达上限 **95.2%**；可清 106；`fix=2`、`hit_rate=17.6%` → **连续两批 fix≥2，触发抽检**。
> `post-b365`（B 段第 16 批）：句子级 **4,056 行 / 1,620 文件 / 池内 815 = 可写 320 + 上游 495**；
> 对基线 **89.0%**、可达上限 **95.4%**；可清 100；`fix=1`、`hit_rate=0%`（precheck 首跑）。
> `post-b366`（B 段第 17 批）：句子级 **4,026 行 / 1,615 文件 / 池内 785 = 可写 290 + 上游 495**；
> 对基线 **89.4%**、可达上限 **95.8%**；可清 95；`fix=0`、`hit_rate=3.3%`（all-checks 口径首跑，分子含 1 处越界）。
> `post-b367`（B 段第 18 批）：句子级 **3,999 行 / 1,609 文件 / 池内 759 = 可写 264 + 上游 495**；
> 对基线 **89.8%**、可达上限 **96.2%**；可清 89；`fix=1`、`hit_rate=11.5%`（含池外自清 1 行，不进 remain）。
> `post-b368`（B 段第 19 批）：句子级 **3,975 行 / 1,605 文件 / 池内 735 = 可写 240 + 上游 495**；
> 对基线 **90.1%**、可达上限 **96.5%**；可清 85；`fix=0`、`hit_rate=0%`（一次过）。
> `post-b369`（B 段第 20 批）：句子级 **3,951 行 / 1,601 文件 / 池内 711 = 可写 216 + 上游 495**；
> 对基线 **90.4%**、可达上限 **96.9%**；可清 81；`fix=1`、`hit_rate=16.7%`（4 行缺谓词，judge 同报）。
> `post-b370`（B 段第 21 批）：句子级 **3,927 行 / 1,596 文件 / 池内 687（390 文件，全部可写）**；
> 对基线 **90.7%**；可清 76；`fix=1`、`hit_rate=4.2%`（1 行缺谓词；「对可达上限」口径见下方待复核条）。
> `post-b371`（B 段第 22 批）：句子级 **3,903 行 / 1,592 文件 / 池内 663（384 文件，全部可写）**；
> 对基线 **91.1%**（6,758 ÷ 7,421）；可清 72；`fix=1`、`hit_rate=4.2%`（1 行无信息列举）。
> `post-b372`（B 段第 23 批，cap 10 首批）：句子级 **3,863 行 / 1,584 文件 / 池内 623（374 文件，全部可写）**；
> 对基线 **91.6%**（6,798 ÷ 7,421）；可清 64；`fix=4`（两轮）、`hit_rate=10.0%`（4 行：2 缺谓词 + 2 数字锚点不足）。
> `post-b376`（B 段第 27 批）：句子级 **3,733 行 / 1,555 文件 / 池内 494（334 文件，全部可写）**；
> 对基线 **93.3%**（6,927 ÷ 7,421）；可清 35；`fix=0`、`hit_rate=0.0%`（首轮零命中，落笔前先过一遍文本级 lint）。
> `post-b377`（B 段第 28 批）：句子级 **3,703 行 / 1,547 文件 / 池内 464（324 文件，全部可写）**；
> 对基线 **93.7%**（6,957 ÷ 7,421）；可清 27；`fix=0`、`hit_rate=0.0%`。
> `post-b378`（B 段第 29 批，全 1 行文件测量批）：句子级 **3,693 行 / 1,538 文件 / 池内 454（314 文件，全部可写）**；
> 对基线 **93.9%**（6,967 ÷ 7,421）；可清 18；`fix=0`、判据类 0 / 格式类 0 / lint 0。
> 该批同时标定双参数估计器：`c_f = 5.5 s/文件`、`c_l = 3.6 s/行`（见 §6.2 第 23 条）。
> `post-b379`（B 段第 30 批，标定批 F=5）：句子级 **3,678 行 / 1,534 文件 / 池内 439（309 文件，全部可写）**；
> 对基线 **94.1%**（6,982 ÷ 7,421）；可清 14；`fix=0`、判据类 0 / 格式类 0 / lint 1。
> 该批**证伪**了 `c_f`：三点解出每文件成本 ≈ 0，成本结构改为「每批 73s + 每行 3.6s」。
> `post-b396`（B 段第 47 批，cap 20 第 6 批首轮全绿，连续三批；阈值换代后首批用 `173.25`）：句子级 **3,312 行 / 1,346 文件 / 池内 79（79 文件，全部可写）**；
> 对基线 **98.9%**（7,342 ÷ 7,421）；**池外残差 3,233 = 3,312 − 79**（减法结果，非实测）；判据类 0 / 格式类 0 / lint 首轮 5 → 修后 0。
> `allowed = 20 + 18 + 0 = 38`；`removed−selfclear=20=plan`；`controllable 82.0 ≤ 173.25`；集合 `1,346 = ACTIVE 1,313 + 表外 33`（定义恒等，非校验）；表外差集 0/9（全 `annotation`）。
> `post-b397`（B 段第 48 批，cap 20 第 7 批首轮全绿，连续四批）：句子级 **3,292 行 / 1,329 文件 / 池内 59（59 文件，全部可写）**；
> 对基线 **99.2%**（7,362 ÷ 7,421）；池外残差 `3,292 − 59 = 3,233`（未变，按异常字段不报）；判据类 0 / 格式类 0 / lint 首轮 1 → 修后 0。
> `allowed = 20 + 18 + 0 = 38`；`removed−selfclear=20=plan`；`controllable 128.0 ≤ 173.25`；集合 `1,329 = ACTIVE 1,304 + 表外 25`（定义恒等，非校验）；表外差集 0/8（全 `annotation`）。
> `post-b398`（B 段第 49 批，cap 20 第 8 批首轮全绿，连续五批）：句子级 **3,272 行 / 1,311 文件 / 池内 39（39 文件，全部可写）**；
> 对基线 **99.5%**（7,382 ÷ 7,421）；池外残差 `3,272 − 39 = 3,233`（未变，按异常字段不报）；判据类 0 / 格式类 0 / lint 首轮 3 → 修后 0。
> `allowed = 20 + 18 + 0 = 38`；`removed−selfclear=20=plan`；`controllable 102.0 ≤ 173.25`；集合 `1,311 = ACTIVE 1,296 + 表外 15`（定义恒等，非校验）；表外差集 0/10（全 `annotation`）。
> `post-b400`（B 段第 51 批，cap 20 收官批，`plan=19`，池内归零）：句子级 **3,232 行 / 1,283 文件 / 池内 0**；
> 对基线 **100%**（7,421 ÷ 7,421）；收口时刻实测池外残差 `3,232 − 0 = 3,232`（比 b399 少 1：`savedWorkflowArgsForm.ts:60` 相邻自清）；判据类 0 / 格式类 0 / lint 首轮 1 → 修后 0。
> `allowed = 19 + 18 + 1 = 38`；`removed−selfclear=20−1=19=plan`；`controllable 126.0 ≤ 173.25`；`pool_remain=0`、`ALIGNED OK`；集合 `1,283 = ACTIVE 1,283 + 表外 0`（定义恒等，非校验）；表外差集 0/8（全 `annotation`）。
> `post-b399`（B 段第 50 批，cap 20 第 9 批，EOL 返工 1 次）：句子级 **3,252 行 / 1,297 文件 / 池内 19（19 文件，全部可写）**；
> 对基线 **99.7%**（7,402 ÷ 7,421）；池外残差 `3,252 − 19 = 3,233`（未变，按异常字段不报）；判据类 0 / 格式类 0 / lint 首轮 2 → 修后 0。
> `allowed = 20 + 18 + 0 = 38`；`removed−selfclear=20=plan`；`controllable 167.0 ≤ 173.25`；集合 `1,297 = ACTIVE 1,289 + 表外 8`（定义恒等，非校验）；表外差集 0/7（全 `annotation`）。
> `post-b395`（B 段第 46 批，cap 20 第 5 批首轮全绿，连续两批 → **稳定**）：句子级 **3,332 行 / 1,365 文件 / 池内 99（99 文件，全部可写）**；
> 对基线 **98.7%**（7,322 ÷ 7,421）；池外残留 **3,233 行（本批未动）**；判据类 0 / 格式类 0 / lint 首轮 3 → 修后 0。
> `allowed = 20 + 18 + 0 = 38`；`removed−selfclear=20=plan`；`controllable 110.0 ≤ 冻结 181.5`；集合 `1,365 = ACTIVE 1,323 + 表外 42`（定义恒等，非校验）；表外差集 0/11（全 `annotation`）。
> `post-b394`（B 段第 45 批，cap 20 第 4 批首轮全绿）：句子级 **3,352 行 / 1,380 文件 / 池内 119（119 文件，全部可写）**；
> 对基线 **98.4%**（7,302 ÷ 7,421）；池外残留 **3,233 行（本批未动）**；判据类 0 / 格式类 0 / lint 首轮 3 → 修后 0。
> `allowed = 20 + 18 + 0 = 38`；`removed−selfclear=20=plan`；集合 `1,380 = ACTIVE 1,327 + 表外 53`（**表外由减法导出，此等式是定义、不是校验**）；表外差集 0/10（全 `annotation`）。
> `post-b393`（B 段第 44 批，cap 20 首轮全绿）：句子级 **3,372 行 / 1,399 文件 / 池内 139（139 文件，全部可写）**；
> 对基线 **98.1%**（7,282 ÷ 7,421）；池外残留 **3,233 行（本批未动）**；判据类 0 / 格式类 0 / lint 首轮 10 → 修后 0。
> 本批 `allowed = 20 + 18 + 0 = 38`、`selfclear_batch=0`、`removed−selfclear=20=plan`；集合 1,399 = ACTIVE 1,336 + 表外 63；表外差集 0/13（全 `annotation`）。
> `post-b392`（B 段第 43 批，cap 20 试验第 2 批：判据被邻接自清污染，修正后通过）：句子级 **3,392 行 / 1,419 文件 / 池内 159（159 文件，全部可写）**；
> 对基线 **97.9%**（7,262 ÷ 7,421）；池外残留 **3,233 行**；判据类 0 / 格式类 0 / lint 首轮 4 → 修后 0。
> 本批 `allowed = 20 + 15 + 3 = 38`（3 条块尾 `*/` 池外人工登记）；集合 1,419 = ACTIVE 1,343 + 表外 76（差 0）；表外差集 新增 0 / 移除 5。
> `post-b391`（B 段第 42 批，cap 20 试验）：句子级 **3,415 行 / 1,433 文件 / 池内 179（179 文件，全部可写）**；
> 对基线 **97.6%**（7,242 ÷ 7,421）；池外残留 **3,236 行**；`fix=0`、判据类 0 / 格式类 0 / lint 7（写盘前已改）。
> 本批 `allowed = 20 + 15 + 0 = 35`；集合 1,433 = ACTIVE 1,352 + 表外 81（差 0）；表外差集 新增 0 / 移除 3。
> `post-b390`（B 段第 41 批）：句子级 **3,435 行 / 1,448 文件 / 池内 199（199 文件，全部可写）**；
> 对基线 **97.3%**（7,222 ÷ 7,421）；池外残留 **3,236 行**；`fix=0`、判据类 0 / 格式类 0 / lint 8（写盘前已改）。
> 本批 `allowed = 20 + 14 + 1 = 35`（1 条邻接自清 `WorkspaceHeader:46`，池外上游 blame）；集合 1,448 = ACTIVE 1,364 + 表外 84（差 0）；表外差集 0/0。
> `post-b389`（B 段第 40 批）：句子级 **3,456 行 / 1,456 文件 / 池内 219（209 文件，全部可写）**；
> 对基线 **97.0%**（7,202 ÷ 7,421）；池外残留 **3,237 行**；`fix=0`、判据类 1（judge 补锚点后 0）/ 格式类 0 / lint 0。
> 本批 `allowed = 20 + 14 + 0 = 34`；集合 1,456 = ACTIVE 1,372 + 表外 84（差 0）；表外差集 0/1。
> `post-b388`（B 段第 39 批）：句子级 **3,476 行 / 1,465 文件 / 池内 239（219 文件，全部可写）**；
> 对基线 **96.8%**（7,182 ÷ 7,421）；池外残留 **3,237 行**；`fix=0`、判据类 2（judge 补锚点后 0）/ 格式类 0 / lint 0。
> 本批 `allowed = 20 + 14 + 0 = 34`；集合 1,465 = ACTIVE 1,380 + 表外 85（差 0）；表外差集 0/2。
> `post-b387`（B 段第 38 批）：句子级 **3,496 行 / 1,472 文件 / 池内 259（229 文件，全部可写）**；
> 对基线 **96.5%**（7,162 ÷ 7,421）；池外残留 **3,237 行**；`fix=0`、判据类 0 / 格式类 0 / lint 0。
> 本批 `allowed = 20 + 14 + 0 = 34`；集合 1,472 = ACTIVE 1,385 + 表外 87（差 0）；表外差集 0/2。
> `post-b386`（B 段第 37 批）：句子级 **3,516 行 / 1,477 文件 / 池内 279（239 文件，全部可写）**；
> 对基线 **96.2%**（7,142 ÷ 7,421）；池外残留 **3,237 行**；`fix=0`、判据类 0 / 格式类 0 / lint 2（写盘前已改）。
> 本批 `allowed = 20 + 14 + 0 = 34`；集合 1,477 = ACTIVE 1,388 + 表外 89（差 0）；表外差集 0/0。
> `post-b385`（B 段第 36 批）：句子级 **3,536 行 / 1,487 文件 / 池内 299（249 文件，全部可写）**；
> 对基线 **96.0%**（7,122 ÷ 7,421）；池外残留 **3,237 行**；`fix=0`、判据类 0 / 格式类 0 / lint 0。
> 本批 `allowed = 20 + 14 + 0 = 34`；集合 1,487 = ACTIVE 1,398 + 表外 89（差 0）。
> `post-b384`（B 段第 35 批）：句子级 **3,556 行 / 1,494 文件 / 池内 319（259 文件，全部可写）**；
> 对基线 **95.7%**（7,102 ÷ 7,421）；池外残留 **3,237 行**；`fix=0`、判据类 0 / 格式类 0 / lint 2（写盘前已改）。
> 本批 `allowed = 20 + 14 + 0 = 34`；`可清` 退役，改报「池内可写 319 / 池外残留 3,237」。
> `post-b383`（B 段第 34 批）：句子级 **3,576 行 / 1,503 文件 / 池内 339（269 文件，全部可写）**；
> 对基线 **95.4%**（7,082 ÷ 7,421）；集合仍在下穿 1,520 基线（1,503，可清 −17）；`fix=0`、判据类 0 / 格式类 0 / lint 1。
> `post-b382`（B 段第 33 批）：句子级 **3,600 行 / 1,512 文件 / 池内 363（279 文件，全部可写）**；
> 对基线 **95.1%**（7,058 ÷ 7,421）；**集合已到底（1,512 < 1,520 基线，8 条基线衰减）**；
> `fix=2`、判据类 2（judge，均为锚点粒度）/ 格式类 0 / lint 13；2 条相邻自清自动登记。
> `post-b381`（B 段第 32 批）：句子级 **3,632 行 / 1,521 文件 / 池内 393（289 文件，全部可写）**；
> 对基线 **94.7%**（7,028 ÷ 7,421）；可清 **1**；ix=1、判据类 1（同义重复）/ 格式类 0 / lint 10。
> `post-b380`（B 段第 31 批，反向对照批 F=10/L=16）：句子级 **3,662 行 / 1,529 文件 / 池内 423（299 文件，全部可写）**；
> 对基线 **94.3%**（6,998 ÷ 7,421）；可清 9；`fix=0`、判据类 0 / 格式类 0 / lint 1。
> 该批把 `c_f` 判死（`F=5/L=15` 与 `F=10/L=16` 同为 118s），参数换为过定拟合的 `a = 61.4s`、`c_l = 3.45 s/行`。
> **文件数一列自 b376 起取 `deep-quality` 末行 `files=`**；b371–b375 的 1,592/1,584/1,577/1,572/1,564 均为末行 +1，见 §6.2 第 24 条订正。
> **文件数口径自 b358 起拆两列**：可清 **64** / 含不可写残留 **1,520**（floor 1,520，见 §6.2 第 13/18 条、`NEVER-CLEAR.tsv`）。
> 句子级口径；逐行口径下另有约 1,046 行池内续行被判强、未排期。

- **剩余与批数（b389 后，只留一个结论）**：`REMAIN 209 文件 / 219 行`，**全部在池内且可写**。
  对 `219` 行做贪心装箱（cap **10 文件/批**、≤100 行/批，按文件可写行降序）→ **21 批**；
  行/批 `avg 10.4`；1 行文件 **199 个**。
  **批数由文件数决定**：209 ÷ 10 ≈ 21，**不能**用行数 ÷ 平均行/文件折算（折算把 1 行文件的空槽算丢了）。
  cap 由 6 提到 10 的理由与时长重算见 §6.2 第 23 条。
- **作废三个旧写法（b371 订正，保留错误原文以便对账）**：
  ① ~~「可写 192 + 上游 495」~~、~~「687 = 可写 192 + 495」~~——**两个分量都错**：
  `remain` 就是可写行本身（b370 末 687、b371 末 663），**495 行上游不在 `remain` 里**
  （`baseline=weak-own-by-file.tsv` 已是 own blame，`ALIGNED diff=0` 可复算）。
  `192` / `195` 是 `capacity` 里 `perBatch=2` 的**对照批数**，既不是可写行数，也不是含可写行的文件数
  （那个数是 390 → 384）；它们不得与批数并列。
  ② ~~「约还能跑 8 批」~~——按行数比例折算出来的错值。
  ③ ~~b358–b370 快照行里的「= 可写 N + 上游 495」与「对可达上限 x%」两列~~——整列作废，只保留「对基线」那一列。
  **今后排期只引用 21 批**（cap 6 口径 64 批、cap 10 早期的 39 / 38 / 34 / 33 / 32 / 31 / 30 / 29 / 28 / 27 / 26 / 25 / 24 / 23 / 22 批，仅作对照）。
- **`6,926` 待复核**：本轮 capacity 的 `REMAIN` 里没有「上游」分量，
  因此 `6,926 = 7,421 − 495` 这组数**无法从当前工具链复现**。在复核出 495 的出处前，
  **对外只报对基线的百分比**（`done ÷ 7,421`），不写「对可达上限」。
- **收尾判定（b371 写死，b372 起按 cap 10 执行）**：完成 = **池内可写行归零（b372 末 623 → 0）**
  且每批都有 `ASSERT PASS` 复算。`NEVER-CLEAR.tsv` 的 **1,520 文件**（其中池外残留 >0 的 **1,286**）
  与 `POOL-SELF-CLEAR.tsv` 的登记行**不计入完成度**：它们不进 `done/remain`，只要求「有行、有判据」，
  属**已交代的池外**，不是欠账。收工那天只做一次判据核对，不做逐文件改写。
- **文件侧四个数各是什么（详见 §6.2 第 22 条）**：进度分母 **1,007**（本线 weak 文件，b372 末 = 633 + 374）；
  **374** 含可写行（排期用）；**1,584** 当前有 weak（观测）；**1,286** 永不清零里池外残留 >0 的部分（⊂ 1,520）。

- **合并率**：注释行 329,700 行中 **140,750 行**（**42.7%**）落在多行句元里；多行句元 **54,730** 组。
  基线树（`8f7daaf0`）同测为 51.2%，即合并不是新注释造成的局部现象。
- **差异方向**：只在逐行口径判弱的 **2,468** 行（池内 1,046 / 池外 1,422）；只在合并口径判弱的
  **381** 行**全部在池外**。也就是说，合并口径在池内**只做减法**——单向遮蔽 1,046 行。
- 差异前 10 文件（`onlyLine(pool)` / `onlyMerge(pool)`）：

| 文件 | 逐行新增 | 其中池内 | 合并新增 | 其中池内 |
| --- | ---: | ---: | ---: | ---: |
| `apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts` | 30 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | 27 | 25 | 0 | 0 |
| `packages/services/src/bots/botsService.ts` | 27 | 27 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/tests/dynamic-workflow-run-service.test.ts` | 26 | 0 | 1 | 0 |
| `packages/shared/src/zcode-protocol/index.ts` | 22 | 19 | 0 | 0 |
| `packages/ui/src/settings/AutomationEditView.tsx` | 21 | 21 | 0 | 0 |
| `packages/services/src/bots/providers/feishuProvider.ts` | 20 | 20 | 0 | 0 |
| `packages/ui/src/v4/ConversationComposer.tsx` | 19 | 17 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/tests/workflow-driver-git-grep.test.ts` | 18 | 0 | 0 | 0 |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 18 | 18 | 0 | 0 |

**口径定死：维持句元合并（句子级）口径，不用逐行口径，两者不混用。** 理由：

1. **差异性质**：逐行新增的池内行抽读 10 条，10/10 是同一句的续行（如「…的工具集不一致，模型行为不可解释。」），
   锚点在前半句。weak 的判据是「这句话有没有给出标识符/前置/后果」，折行是版式而不是内容缺口；
   真正「自己什么都没写」的只有 `*/` 这类结构行，属结构性标记缺口，不构成换口径的理由。
2. **分母可复算性**：基线 `weak-own-by-file.tsv`（1,007 文件 / 7,421 行）只有结果文件，
   没有随批提交的生成命令与提交号，308 批的 `done` 全部建立在它上面。切逐行口径必须重造 7,421 的分母；
   重造值无法回放核对，等于用一个不可审计的新数替换唯一可审计的旧数。
3. **副作用已封住**：合并口径的非局部性（改写一行会翻转邻居）已被第 11 道 `POOL-DIFF` +
   `POOL-SELF-CLEAR.tsv` 登记兜住；b307–b309 实测未登记消失 0、新增 0。

**限制（写进台账，不隐藏）**：`weak` 判定含句式合并启发式，合并率 **42.7%**（基线树 `8f7daaf0` 为 51.2%）。
42.7% 意味着**近一半注释行的强弱判定继承自邻句**，所以这个量是「**句子级 weak**」，不是「行级 weak」。
逐行口径会把 `remain` 从 2,646 抬到 3,692（**+1,046**）。这 1,046 行在句子级口径下判强、**不排期**，
属于「续行无自有锚点」，不是「已清」；全仓按逐行口径观测为 7,983 行。
**成本区间（以后只按这个报）**：1,046 行补句按 `批墙钟` **3.6–12.6 s/行** 推算为 **1–4 小时**
（b318 3.59、b319 12.64，均含选行、读码、写作与收口）；不再用 `controllable` 折算。

**复算方式**：合并在活尺里的实现不变；本次用一个派生副本加 `--merge-stats` / `--no-sentence-merge`
两个开关跑同一棵树（副本与快照留在 `_annot_baseline/`，**不是尺子，不用于批次**），
逐行比对 `--list-weak` 的 `文件:行` 集合。活尺 `deep-quality.mjs` 字节未改（`5144fefd8888`）。

**分母可复算性已补**：基线 `weak-own-by-file.tsv` 的生成命令、运行时提交号（`611b24a5`）、
两份输出的 sha256 与实跑复现结果见 [`BASELINE-GEN.md`](./BASELINE-GEN.md)；
复现为逐字节一致（7,421 行 / 1,007 文件，逐行差异 0），旧文件未被覆盖。

## 12.2 句子级口径的用词与回报硬规则（b309 起）

以下三条是硬约束，不只写在台账里，**每次回报都要执行**：

1. **凡出现 `done / remain / 完成度 / 百分比`**（每批回报、阶段小结、最终结论），同一段必须带限定语：
   > 句子级口径；逐行口径下另有 **约 1,046 行**池内续行被判强、未排期。

   数字随批次变化时，写当批实测的「池内逐行余量 − 句子级余量」，不要机械复制 1,046。

2. **`remain = 0` 的结论措辞**：只能写「**句子级口径下已清零**」；
   禁止写「注释已全部覆盖」「全仓清零」这类无限定语。同一段必须附逐行口径的未排期数
   （如「逐行口径下仍有约 1,046 行池内续行判强、未排期」）。

3. **用词统一**：一律写「**句子级 weak**」或「句子级口径 weak」；
   独立观测值时写「全仓（句子级）weak = 5,896」并注明「观测值，不进入分母」。
   禁止把 `5,896` 简写成「全仓 weak」，也禁止把 `7,983` 与 `5,896` 混在同一句里比较而不标口径。

## 12.3 两个口径回答两个问题（b310 起对外报数的唯一允许方式）

| 口径 | `post-b309` 实测 | 回答的问题 | 定位 |
| --- | ---: | --- | --- |
| 句子级（现行主口径） | **64.8%**（`4,811 / 7,421`） | 这块代码**有没有解释** | **工程完成度** |
| 逐行（并列观测） | **约 50.7%**（约 `3,765 / 7,421`；`remain` 约 3,656 = 2,610 + 1,046） | 每一行注释**是否自足** | 自足性指标 |

- 注释的语义单位是句子，所以「有没有解释」只能用句子级口径回答——它才是**工程完成度**。
- 「每一行是否自足」是另一个问题，逐行口径只作**并列展示**，**不是完成度的另一个说法**。
- **两个都要给**，且每次都要写明哪个是工程完成度。
- **引用禁令**（写死，不得违反）：
  - 禁止单独拿 `50.7%` 说「才做了一半」——逐行口径低是因为续行不自足，不是内容缺失；
  - 禁止单独拿 `64.8%` 说「快做完了」而不带自足性——那会盖住「续行不自足」这个事实。
- **为什么不能把逐行口径丢掉**：那 1,046 行绝大多数是**同一句话的续行**、锚点在前半句
  （b309 抽读 10/10 均为此形态）；把它们单独判弱是**度量口径**造成的，不是内容缺失。
  但「续行不自足」**确实是事实**——单独看该行读不出完整语义，所以逐行口径必须并列保留。
- 本节的句式即以后所有回报、阶段小结、最终结论的统一句式；与 §12.2 的三条硬规则同时生效。

## 12.4 `SELF-CLEAR` 提前量、A4 三数闭合、`ALIGNED` 里自清的处置（b311 定稿）

**先把自清分两类**（`capacity-estimate` 已在输出里分桶：可写桶 / 池外 / 上游桶 / 未解析）：

| 类别 | 是否在 7,421 基线内 | 对 `done` 的影响 |
| --- | --- | --- |
| **池内自清**（基线 `+` 行 ∩ 本线 blame） | 在 | 减法 `done` 会把它算成「已清」，但**没落笔** → `done` 虚高 |
| **池外自清**（基线外，如块尾 `*/`） | 不在 | 不进 `done`、不进 `remain`，对闭合无影响 |

**实测（b318 核算，b318 批后更新）**：累计自清 **5 次**——b307 `workspaceConnectionRegistry.ts:184`、b310 `commands-command.ts:279`、
b311 `sourceServerManagementService.ts:354`、b312 `SavedWorkflowMoveDialog.tsx:72`（块尾 `*/`）、b313 `zip-source.ts:312`（块尾 `*/`），**五次都是池外**；b314–b318 均无自清。
b313 是首个「池外 + 本线 blame 但提交早于池基线 `8f7daaf0`」的形态（`522e851e`），按自动登记三条件里的②被拦，走**人工登记**，`auto_self_clear=0`。
证据不是分类标签，是数字：`commands-command.ts` 的基线 `weak-own-by-file.tsv` = **11**，而 `post-b309` 实测 weak = **12**，
多出的那行正是 279；它从来不在 7,421 里。所以 `post-b309 4,811 → post-b310 4,847` 恰好 `+36`（36 行落笔），不是 +37。
b311 同理：`post-b310 4,847 → post-b311 4,883` 仍恰好 `+36`，而该批 weak 集合少了 **37** 行（36 落笔 + 354 自清），
差额 1 行全部落在池外——若 354 在池内，这里会多算成 `+37`。
b312 第三次复现同一形态：`4,883 → 4,919` 恰好 `+36`，weak 集合少 **37** 行（72 块尾 `*/` 自清），差额仍全在池外。
b313 第四次复现：`4,919 → 4,955` 恰好 `+36`，weak 集合少 **37** 行（312 块尾 `*/` 自清），差额仍全在池外。
b314（33 行批）：`4,955 → 4,988` 恰好 `+33`，weak 集合少 **33** 行，无自清——`done` 增量与落笔逐一对应。
b315（33 行批）：`4,988 → 5,021` 恰好 `+33`，weak 集合少 **33** 行，无自清。
b316（44 行批）：`5,021 → 5,065` 恰好 `+44`，weak 集合少 **44** 行，无自清。
b317（44 行批）：`5,065 → 5,109` 恰好 `+44`，weak 集合少 **44** 行，无自清。
b318（44 行批）：`5,109 → 5,153` 恰好 `+44`，weak 集合少 **44** 行，无自清。
b319（44 行批）：`5,153 → 5,197` 恰好 `+44`，weak 集合少 **44** 行，无自清。
b321（44 行批，b320 为普查插点未落批）：`5,197 → 5,241` 恰好 `+44`，weak 集合少 **44** 行，无自清。
b322（42 行批）：`5,241 → 5,283` 恰好 `+42`，weak 集合少 **42** 行，无自清。
b323（40 行批）：`5,283 → 5,323` 恰好 `+40`，weak 集合少 **40** 行，无自清。
b324（42 行批）：`5,323 → 5,365` 恰好 `+42`，weak 集合少 **42** 行，无自清。
b325（40 行批）：`5,365 → 5,405` 恰好 `+40`，weak 集合少 **41** 行（40 落笔 + 1 池外自清），无池内自清。
b326（40 行批）：`5,405 → 5,445` 恰好 `+40`，weak 集合少 **40** 行，无自清。
b327（40 行批）：`5,445 → 5,485` 恰好 `+40`，weak 集合少 **40** 行，无自清。
b328（40 行批）：`5,485 → 5,525` 恰好 `+40`，weak 集合少 **40** 行，无自清。
b329（40 行批）：`5,525 → 5,565` 恰好 `+40`，weak 集合少 **40** 行，无自清。
b330（40 行批）：`5,565 → 5,605` 恰好 `+40`，weak 集合少 **40** 行，无自清。
b331（36 行批）：`5,605 → 5,641` 恰好 `+36`，weak 集合少 **37** 行（36 + 1 相邻自动自清），池内自清 0。
b332（36 行批）：`5,641 → 5,677` 恰好 `+36`，weak 集合少 **36** 行，无自清。
b333（36 行批）：`5,677 → 5,713` 恰好 `+36`，weak 集合少 **36** 行，无自清。
b334（33 行批）：`5,713 → 5,746` 恰好 `+33`，weak 集合少 **33** 行，无自清。
b335（33 行批）：`5,746 → 5,779` 恰好 `+33`，weak 集合少 **33** 行，无自清（1 行上游 weak 留在 `settingsSyncService.ts:3123`，不计入）。
b336（33 行批）：`5,779 → 5,812` 恰好 `+33`，weak 集合少 **33** 行，无自清（1 行上游 weak 留在 `RemoteSkillSyncDialog.tsx:163`，不计入）。
b337（32 行批）：`5,812 → 5,844` 恰好 `+32`，weak 集合少 **32** 行，无自清（1 行上游 weak 留在 `useWorkflowRunSave.ts:136`，不计入）。
b338（32 行批）：`5,844 → 5,876` 恰好 `+32`，weak 集合少 **32** 行，无自清（1 行上游 weak 留在 `webRemoteControlConnectionSheet.tsx:76`，不计入）。
b339（32 行批）：`5,876 → 5,908` 恰好 `+32`，weak 集合少 **32** 行，无自清。
b340（31 行批）：`5,908 → 5,939` 恰好 `+31`，weak 集合少 **31** 行，无自清（2 行上游 weak 留在 `app-shell/types.ts:101/183`，不计入）。
b341（28 行批）：`5,939 → 5,967` 恰好 `+28`，weak 集合少 **29** 行（1 行相邻自清落在池外 `transcript-hydration.ts:639`，只减 weak 不减 done）。
b342（28 行批）：`5,967 → 5,995` 恰好 `+28`，weak 集合少 **28** 行，无自清（2 行上游 weak 留在 `WorkspaceShellLayout.tsx:2816`、`PluginUiLauncherItems.tsx:61`，不计入）。
b343（28 行批）：`5,995 → 6,023` 恰好 `+28`，weak 集合少 **28** 行，无自清（4 行上游 weak 留在 `create-workflow.tsx:214/296`、`markdown-table.tsx:884/944`，不计入）。
b344（25 行批）：`6,023 → 6,048` 恰好 `+25`，weak 集合少 **25** 行，无自清（2 行本线池外留在 `analyzer.ts:513/1522`，3 行上游 weak 留在 `ModelConfigSelect.tsx:257/578`、`steering.ts:1331`，均不计入）。
b345（23 行批）：`6,048 → 6,071` 恰好 `+23`，weak 集合少 **24** 行（多出的 1 行是池外相邻自清），无人工自清（5 行上游 weak 留在 `RemoteConnectionFields.tsx:1`、`feishuProvider.ts:2`、`zcodeAgentService.ts:2`，不计入）。
b346（28 行批）：`6,071 → 6,099` 恰好 `+28`，weak 集合少 **28** 行，无自清（四个 `packages/ui` 文件全清）。
b347（19 行批）：`6,099 → 6,118` 恰好 `+19`，weak 集合少 **19** 行（补修后；本体提交时只少 18），无自清（`display.ts` 全清，另三个留上游 weak）。
b348（28 行批）：`6,118 → 6,146` 恰好 `+28`，weak 集合少 **28** 行，无自清（四个 `packages/ui` 文件全清）。
b349（20 行批）：`6,146 → 6,166` 恰好 `+20`，weak 集合少 **20** 行，无自清（四个文件全清）。

**结论一（A2 未被侵蚀）**：当前 `done 6,166` 就是**实际落笔**，`池内自清累计 = 0`，
`6,166 + 0 + 1,255 = 7,421` 三项全等；`remain = 0` 那天 `done` 仍应为 **7,421**，不存在「被自清偷走 60–80 行」。
**结论二（A4 防的是未来）**：只有**池内**自清才让 `done` 虚高，当前池内 **0 次**
（b325 首例 `auto_self_clear=1` 落在池外 + 上游 blame，只减 weak 不减 `done`，已登记 `POOL-SELF-CLEAR.tsv`）；一旦出现池内自清，
必须按 A4 写成 `done 实际落笔 + Σ 池内自清 + remain = 7,421`，差值逐行对到 `POOL-SELF-CLEAR.tsv`。

**`SELF-CLEAR 提前量` 区间**（按实测率外推，不是点估计）：
自清观测 **5 行 / 12 批**（b307、b310、b311、b312、b313 各 1；b314–b318 无），剩余 `2,268 / 36 ≈ 63` 批，
未来源于自清的行数约 **46–68 行**（按 0.67–1.0 行/批）；但**只有落在池内的部分才扣 `done`**，实测池内占比 0/5。
故：**`SELF-CLEAR 提前量` 预计 0–68 行；`remain` 归零时 `done 实际落笔` 预计 7,353–7,421（点估计 7,421）。**
差的来源是**邻接自清**（句元合并后邻行转强），**不是漏做**——这 46–68 行本来就不需要落笔。
（b310 交上来的「60–80 行 / 7,340–7,360」是按 1 行/批 推的；b311 起实测率是 0.67–1.0 行/批，且 5/5 全部落池外，故区间收紧并下探到 0。）
（b325 追加 1 行**池外** auto 自清，池内仍 0/6；上式区间只增不减，结论不变。）

**`ALIGNED diff=0` 里自清怎么处理（回答「迟早会不平吗」）**：
- `done` 是**减法定义**：`done = Σ(基线 weak − 现池内 weak)`，不给自清单独记账。
- 因此自清只要发生在**已登记文件**（在 `done` 集里），`done` 加、`remain` 减，**在同一次计算内两侧同步扣减**，
  `acct_remain` 与 `pool_remain` 仍由同一个 `cur` 得出，等式恒成立、不会突然不平。
- **真正会不平的情形**是**池内自清**发生在**没有任何 `rewrite.tsv` 登记的文件**里：此时 `acct_remain` 取基线值、`pool_remain` 取实测值，
  两者分叉 → 打印 `DRIFT` 并 **`exit 1`**。也就是说它不会「悄悄不平」，而是**立刻判红**；
  b310 那次是文件已登记、但行是池外，所以只触发 `pool-diff` 的未登记自清，不触发 `ALIGNED`；
  b311 的 `354`、b312 的 `72`、b313 的 `312` 同样落在池外、文件已登记，`ALIGNED acct_remain=2433 pool_remain=2433 diff=0` 照常成立。
- **b314 复核结论**：自清累计到 5 行仍未破坏等式，不是因为「每批即时扣配额」，而是因为
  `done`/`remain` 由**同一份批后 `cur`** 推出，自清在该批内同时改变两侧（`done` 加、`remain` 减）；
  只要自清行落在池内且文件已登记，这一步是**同批双侧扣减**，不存在「只改 pool_remain」的路径。

**自清分流上线（b313）与记数口径**：`gate-run.mjs` 的 `pool-diff` 把自清分三路，纯函数 `classifySelfClear` 同时供真实闸与
`--selftest-selfclear` 使用：

| 条件 | 处置 | 输出 |
| --- | --- | --- |
| 在本批 `plan` 或已登记 | 跳过（计划内不算自清） | — |
| **池内**（池 `+` 行 ∩ 本线 blame） | **硬失败**，不自动登记 | `IN-POOL SELF-CLEAR <file>:<line>` + `exit 1` |
| 池外 + 本批未触碰 + blame 为**上游** | **自动登记并继续** | `AUTO-SELF-CLEAR <file>:<line> reason=adjacent` |
| 池外 + 本批未触碰 + blame 未解析 | 硬失败 | `UNREGISTERED SELF-CLEAR <file>:<line> (blame unresolved)` + `exit 1` |
| 池外 + 本批未触碰 + blame 为**本线**（早于池基线） | 硬失败，走人工 | `UNREGISTERED SELF-CLEAR <file>:<line> (own blame)` + `exit 1` |

记数**两套分开**，不许合并：
- `auto_self_clear=N`：闸行直接打印，只统计自动分支（b313 起）；
- 人工登记行：`POOL-SELF-CLEAR.tsv` 的**第 6 列为空**；自动行第 6 列固定 `auto`、第 4 列固定 `auto-out-of-pool`、成因前缀 `AUTO reason=adjacent`。
复查自动那批：`awk -F'\t' '$6=="auto"' ../POOL-SELF-CLEAR.tsv`；人工那批：`awk -F'\t' '$6!="auto"' ../POOL-SELF-CLEAR.tsv`。
b313 首跑 `auto_self_clear=0`（唯一一条 312 是 own blame，被规则②拦），负例覆盖见 `ZC-deep-b313.md` §0。

## 12.5 `自足化候选`（逐行探针增量普查，2026-11-11，b320 插点）

**只测不修**：对象是 b309–b319 实际写过的 42 个文件（422 个登记行去重后 42 文件），
用关合并副本 `_tmp/deep-quality-lineonly.mjs --list-weak` 扫描，命令见 `ZC-deep-b319.md` §8 同款（换脚本与 `--file-list`）。

| 读法 | 数 | 说明 |
| --- | ---: | --- |
| 扫描文件 | 42 | 与登记行数 422 行去重一致 |
| 扫描代码单元 | 8,283 | `units` |
| 扫描注释行 | 4,659 | `comments` |
| **捞到 weak** | **47** | 占注释行 **1.0%**，分布在 18 个文件 |
| 其中落在本线改写行 | **0** | 47 行全部 `OTHER`：本线 422 行改写逐行自足 |

**按批次分布**：b309 1 / b310 1 / b311 4 / b312 17 / b313 10 / b314 4 / b315 2 / b316 0 / b317 0 / b318 0 / b319 8。

**按文件分布（前 8）**：

| 文件 | 命中 | 批次 |
| --- | ---: | --- |
| `packages/ui/src/components/workflow-timeline/timeline-model.ts` | 9 | b312 |
| `packages/ui/src/ElicitationDialog.tsx` | 5 | b319 |
| `packages/ui/src/side-pane-full-view/ConversationHost.tsx` | 5 | b313 |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts` | 4 | b313 |
| `packages/services/src/skills/skillsService.ts` | 3 | b314 |
| `packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx` | 3 | b312 |
| `packages/ui/src/v4/ConversationWorkflowDigests.tsx` | 3 | b312 |
| `apps/zcode-cli/packages/core/src/mcp/app-tools.ts` | 2 | b311 |

**计数约束**：这 47 行是 `自足化候选`，**不进 `done` / `remain`，不改句子级完成度**，
也不进 `rewrite.tsv`；只有决定「补一句让它自足」时才按正常批次（1→1、十一闸）处理。

**定档（b320 起固定动作）**：

- **每 40 批跑一次，下次 `b360`**；之后 `b400`、`b440`……只测不修。
- 每次只报三个数：**扫描注释行数 / 捞到行数 / `onPlannedLine`**，附按文件与按批次分布。
- **硬条件**：`onPlannedLine > 0` → **停批回报**。含义是本线自己写的行里有不逐行自足的，
  属新引入回归，必须当场改，不能等收口；`onPlannedLine = 0` 正常往下走。
- `b360` 若仍考虑动 1,046 行，先用当时的批次实测重算「5 批 / 约 50 分钟」占主队预算的比例，再决定。

**收口期 backlog（47 行）**：**存量、非本轮引入、已量化 1.0%**（47 / 4,659 注释行，18 文件）。
`remain = 0` 后由用户决定修不修；在那之前不排批、不进任何完成度读数。
成本量级：按 b319 实测 `controllable 4.86 s/行` 约 **4 分钟**，但 18 个文件按 4 文件/批要拆 **5 批**，
`批墙钟` 约 **50 分钟**；47 行没有一行落在本线已登记改写行上——其中 4 行正是 b319 四个文件各自留存的池外上游 weak
（`zcode-builtin-download.ts:106` / `model-config.ts:49` / `App.tsx:1187` / `ElicitationDialog.tsx:1055`），其余 43 行是句子级靠邻句撑强的续行。
b316–b318 三个 44 行批命中 0，说明现行写法本身已经逐行自足，这 47 行优先级低于 1,046 行补句。




## 12.6 碎尾批登记（b345 起）

口径见 §6.1 第 4 条：**正常批 ≥33 ｜ 尾部批 25–32 ｜ 碎尾批 15–24 ｜ <15 合批**。
碎尾批**计入 `done`**（行数照算），**不进**规模分布与计时中位数/极差；两件事分开记。

| 批号 | 文件数 | 行数 | 起草 s | 可控 s | 收口 s | 批墙钟 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| b345 | 4 | 23 | 9 | 120 | 129 | 258 |
| b347 | 4 | 19 | 9 | 123 | 61 | 193 |

**投影（b344 后，剩余 536 文件 / 1,373 行）**：按分档总量构造整数分布模拟「4 文件一批、合计 <15 时续加文件」，
得约 **80 批**，其中正常批 0–3（需 4×8=32 或 4×9=36，5–9 档里最多凑出 3 批）、尾部批 0–4、
**碎尾批约 75–80 批**（多为 4 文件 20–24 行；1–2 行档要攒到 5–15 个文件才够 15 行）。
模拟脚本口径写在 b345 台账 §0，属分档近似（`pick-generic` 按 `ownIn` 降序，此处按 weak 计数降序近似）。

**第二套读数（b345 起，强制）**：碎尾批**必须有自己的中位数与极差**，与主中位数并列，不能只写「不计入」：

| 读数 | 口径 | 当前值 |
| --- | --- | --- |
| 主中位数 | 正常批（≥33）的 `批墙钟` 中位数 | 样本 0–3，暂不足以给出 |
| 碎尾中位数 | 碎尾批（15–24）的 `批墙钟` 中位数 | 待首批碎尾批填 |
| 碎尾极差 | 碎尾批 `批墙钟` 的 min–max | 同上 |

- **占比规则**：当排除类（尾部批 + 碎尾批）占剩余批次 **>50%** 时，主中位数**不得单独引用**，
  必须与碎尾中位数并列出现，否则读者会把「形状好的批」误当成整体。
  按当前投影碎尾批约占 99%，即从 b345 起两套读数必须成对出现。
- 碎尾批的行数照常计入 `done`；这里排除的只是「计时统计」，不是工作量。

## 12.7 自清累计表（POOL-SELF-CLEAR.tsv 汇总，b346 起每批回报）

机器格式仍是 `POOL-SELF-CLEAR.tsv`（6 列，门禁按第 6 列 `auto` 分自动/人工两套计数，不合并）。
本表是它的可读汇总，**只加列不改 TSV**；「是否被读过」由人工维护，改动需在该批台账 §5 说明。

| 批号 | 行数 | 文件 | 路径 | 触发原因 | 是否被任何人读过 |
| --- | ---: | --- | --- | --- | --- |
| b307 | 1 | `workspaceConnectionRegistry.ts` | `packages/ui/src/v4/workspaceConnectionRegistry.ts:184` | 句元合并，`*/` 不以句末标点收尾 | 未读 |
| b310 | 1 | `commands-command.ts` | `apps/zcode-cli/packages/cli/src/commands-command.ts:279` | 邻接改写后短句堆叠组不再成立 | 未读 |
| b311 | 1 | `sourceServerManagementService.ts` | `packages/desktop/src/host/sourceServerManagementService.ts:354` | 邻接改写，锚点行成立 | 未读 |
| b312 | 1 | `SavedWorkflowMoveDialog.tsx` | `packages/ui/src/settings/saved-workflows/SavedWorkflowMoveDialog.tsx:72` | 块尾 `*/` 与下一行同判 | 未读 |
| b313 | 1 | `zip-source.ts` | `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts:312` | 块尾 `*/` 与下一行同判（本线旧提交） | 未读 |
| b325 | 1 | `pluginsMentionProvider.ts` | `packages/ui/src/mentions/providers/pluginsMentionProvider.ts:51` | auto（`auto-out-of-pool` + `reason=adjacent`）：与改写行直接相邻 | 未读 |
| b331 | 1 | `reminder.ts` | `apps/zcode-cli/packages/core/src/plugin-reference/reminder.ts:228` | auto（`auto-out-of-pool` + `reason=adjacent`）：与改写行直接相邻 | 未读 |
| b341 | 1 | `transcript-hydration.ts` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:639` | auto（`auto-out-of-pool` + `reason=adjacent`）：与改写行直接相邻 | 未读 |
| b345 | 1 | `wire-codec.ts` | `packages/shared/src/zcode-protocol-v4/wire-codec.ts:49` | auto（`auto-out-of-pool` + `reason=adjacent`）：与第 50 行改写行直接相邻 | 未读 |
| b354 | 1 | `toolbarShortcuts.ts` | `packages/ui/src/v4/composer/toolbarShortcuts.ts:218` | auto（`auto-out-of-pool` + `reason=adjacent`）：与 219 改写行同一句元，218 行随之转强 | 未读 |
| b390 | 1 | `WorkspaceHeader.tsx` | `packages/ui/src/WorkspaceHeader.tsx:46` | auto（`auto-out-of-pool` + `reason=adjacent`）：JSDoc 块尾 `*/`，与 47 改写行同一句元；blame `3c5b2276` 属上游 | 未读 |
| b392 | 1 | `bash-command-parser.ts` | `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts:144` | 人工：块尾 `*/`，与 145 改写行同一句元；blame `54f51bad` 属本线但早于池基线 `8f7daaf0`（池外） | 未读 |
| b392 | 1 | `shared.ts` | `apps/zcode-cli/packages/debug/src/shared.ts:319` | 人工：块尾 `*/`，与 320 改写行同一句元；blame `3ead6c6a` 同上 | 未读 |
| b392 | 1 | `agent-trace-runtime.ts` | `apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts:444` | 人工：块尾 `*/`，与 445 改写行同一句元；blame `b3cc6d24` 同上 | 未读 |

- **自动 6 条的触发口径**：全部是「与本批改写行直接相邻」，没有一条来自「同文件池外未清」；
  判定规则固定为 `auto-out-of-pool`（分类列）+ `reason=adjacent`（子原因），
  即「该行未被本批触碰 + blame 属上游 + 与改写行同一句元」，第 5 列已把这句话写进 TSV，不再只留枚举。
- **人工 8 条的判定者与依据**（回填重读时可直接接着判）：
  判定者＝执行该批的读者（本线）；依据＝逐行判据（锚点 / 短句堆叠 / 块尾 `*/`）+ 该行是否独立句元。
  - b307 `workspaceConnectionRegistry.ts:184`：块注释尾 `*/`，不与下一行组成独立句元，无信息可写。
  - b310 `commands-command.ts:279`：所在短句堆叠组因 280–282 改成带标识符整句而不再成立，本行本身是无锚点碎片。
  - b311 `sourceServerManagementService.ts:354`：355 补 `removeSourceServer` 后同组判定锚点成立，354 无需独立注释。
  - b312 `SavedWorkflowMoveDialog.tsx:72`：块尾 `*/`，与 73 行同判，73 补 `targetKey` 后整句转强。
  - b313 `zip-source.ts:312`：块尾 `*/`，313 补 `entry` 后整句转强；blame 属本线但早于池基线 `8f7daaf0`，故池外人工登记。
  - b392 `bash-command-parser.ts:144`：块尾 `*/`，145 改成带 `isBashCommandPermissionSafe` 的整句后转强；blame `54f51bad` 早于池基线，池外。
  - b392 `shared.ts:319`：块尾 `*/`，320 改成带 `NetworkRequestAttribution` 的整句后转强；blame `3ead6c6a` 早于池基线，池外。
  - b392 `agent-trace-runtime.ts:444`：块尾 `*/`，445 改成带 `linkedRoot` 与 `ROOT_CONTEXT` 的整句后转强；blame `b3cc6d24` 早于池基线，池外。
- **累计**：14 行 / 14 文件（自动 6、人工 8），全部未回读。b354 是 B 段第一条自动自清，按规则**当批停批回报**；b392 一次登记 3 条，触发点见下。
- **阈值**：累计 **>20 行** 或超过剩余行数 **2%**（当前 2% × 1,079 ≈ 22 行）时，触发**回填重读**：
  下一批把这些路径并入清单（不受「4 文件 / 形状 B」文件数限制），按正常判据 1→1 改写并登记「已读」；
  不许以「池外相邻」为由长期跳过。触发时该批 `pool-diff` 的 `removed` 会小于清单行数，属预期，需在 §5 写明。
- **每批回报**必须附累计值（当前 **14 行 / 14 文件**；7,421 的 2% ≈ 148 行，距 20 行阈值还剩 6 行）。

## 5.3 禁用句式（P-LIST，b348 起起草阶段自查；判据闸不变，仍作兜底）

b328–b347 的 20 批里 **12 批**发生回改（60%），其中 **9 批**主因是 L「无信息列举」。逐条原文与句式归类如下。

| 批 | 路径 | 行 | 原文 | L 命中原因 |
| --- | --- | ---: | --- | --- |
| b329 | `packages/ui/src/presentation/presentationPdfPrintExport.ts` | 405 | `含屏外承载与打印铺平，每页固定尺寸且末页不分页` | `与`/`，` 两处分隔，无谓词 |
| b334 | `apps/zcode-cli/packages/cli/src/plugins-command-format.ts` | 50 | `severity 原样输出，不做本地化，便于脚本匹配。` | 逗号 ×2，谓词缺 |
| b336 | `packages/ui/src/tool-call/execute-group.tsx` | 41–43 | `命令数与失败数分开成句。` / `单条与多条使用不同消息键。` / `停止与失败可同时出现。` | 连续三行「A 与 B」对称短句，互不衔接 |
| b336 | `packages/ui/src/plugin-ui/RemoteSkillSyncDialog.tsx` | 190 | `[契约] 阶段只接受三个已知字面量，其他值即使类型正确也不识别。` | 逗号 ×2，结论埋在从句 |
| b336 | 同上 | 538 | `[事务] 导入成功、宿主刷新、切完成态三步严格串行。` | 顿号 ×2，只有名词短语 |
| b336 | `packages/ui/src/plugin-ui/BotsDialog.tsx` | 1056 | `自动流程的总闸：新建态、无选中项、弹窗关闭时都不触发。` | 顿号 ×2，条件摊在名词列表里 |
| b341 | `packages/ui/src/conversation-share/conversationShareService.ts` | 1496 | `video/audio…不进上传清单` | 顿号串 + 无标识符 |
| b343 | `packages/ui/src/i18n.ts` | 273 | `选表只看语言前缀，中文、中文简化、中文繁体都归入中文，其余一律回落英文。` | 顿号 ×2 + 逗号 ×2，判断规则被列表淹没 |
| b343 | `packages/ui/src/create-workflow.tsx` | 184 | `[资源] 卡片模型每次渲染只建一份，入参不变时沿用，图到达时整份替换而非就地改。` | 逗号 ×2，三条事实并列无线索 |
| b343 | `packages/ui/src/create-workflow.tsx` | 304 | `[事务] 这一分支只产出行式反馈，不渲染时间线，也不接任何跳转回调。` | 逗号 ×2，只列「不做什么」 |
| b344 | `apps/zcode-cli/packages/core/src/steering.ts` | 115 | `hasSteerInput 同时看 input、attachments 与 conversationQuotes，任一为真即有效。` | 顿号 ×2，判定表达式被铺陈 |
| b344 | 同上 | 1781 | `输入非空或有附件时成立，不做内容校验。` | 逗号 ×2，无标识符 |
| b345 | `packages/ui/src/remote/RemoteConnectionFields.tsx` | 978 | `按来源分组：本地、远程、混合三类，组内保持原序。` | 顿号 ×2，只有名词分类 |
| b346 | `packages/ui/src/components/ai-elements/image-preview-dialog.tsx` | 9 | `- 不转码、不生成缩略图、不做断点续传。` | 顿号 ×2，三个否定并列无后果 |
| b346 | 同上 | 143 | `改错后果：缩小后图片停在角落，用户以为缩放按钮失灵。` | 逗号 ×2，后果在但无语义锚点主语 |
| b346 | `packages/ui/src/components/ui/pptx-preview-viewer.tsx` | 645 | `随后逐项复位页码、缩放、选择与编辑草稿。` | 顿号 ×2 + `与`，只有动作清单 |

- b342 的 2 hit **不属于 L**：一条是漏改（`PluginUiLauncherItems.tsx:80`）、一条是跨行缺锚点（`WorkspaceShellLayout.tsx:2945`）。
  按句形统计时 b342 计 0 条 L，不要把它算进 9 批。

**共同句式（3 类，起草阶段直接避开）**

1. **「A、B、C 三项并列 + 结论放句末」**（b336:538、b336:1056、b343:184、b346:645）：
   一行里三个名词/动作用顿号串起，谓词只在最后或干脆没有。读者看不出**哪一项决定结果**。
   替代：只留决定结果的那一项，写成「X 决定 Y，所以 Z」。例：`三步严格串行` → `先写 completedAt 再刷宿主缓存，最后切完成态；顺序反了会读到旧状态`。
2. **「A 与 B 分开 / 共用 / 不同」对称说明**（b336:41–43、b345:978）：
   两三个短句互相镜像，信息量被对称性稀释，且常连续三行出现（同时触发短句堆叠）。
   替代：合并成一条因果句，只讲为什么要分开：`单条与多条用不同消息键` → `多条走 summary 键，单条走 detail 键，否则计数会重复`。
3. **「只列不做什么」的否定清单**（b346:9、b343:304、b344:1781）：
   「不转码、不缩略、不断点续传」这类只描述边界，不说明偏离后的症状。
   替代：留一个最容易被误改的否定项 + 后果：`不转码` → `不转码，blob 直接进 createObjectURL；转码会破坏 Range 语义`。
4. **「因此 / 所以」引出的结论句**（b354:224、b354:283，两轮才过）：
   前半句铺两个逗号分句，后半句用「因此/所以/这样」收结论——**L 的 PREDICATE 表里没有「因此/所以」**，
   所以照样命中「无信息列举」。这不是闸的漏洞，是起草时误以为结论词等于谓词。
   替代：把结论句改成表内谓词（`由 … 决定` / `先 … 再 …` / `必须` / `返回`），
   例：`三个弹层都按 open 条件挂载，关闭时整棵子树不渲染，因此省掉渲染开销`
   → `三个弹层都由 open 决定挂载，关闭时整棵子树不渲染，省掉渲染开销`。

- **L 判据：结论选 ②（继续扩词，按「关系谓词」成批扩），不做结构判定**
  - **为什么不选 ①**：结构判定（并列结论句 / 对称说明 / 否定清单）要区分「名词并列」与「谓词分句」，
    没有中文句法解析器时，三种结构最终仍要靠分隔符 + 词表落地，等于把词表藏到结构名后面；
    更重要的是它引入的失败模式是**把真水句放行**——误报有闸兜底、可回改，漏判会直接进库。
  - **为什么 ② 可控**：加谓词是**单调**方向，只会把解释句从弱改判为强，不会让并列清单通过；
    每次扩表用固定语料回放，命中数可审计、可回退。
  - **本次扩表（b359 起草、b360 定稿）**：加 `不等 / 来自 / 控制 / 不需要`（比较、归属、控制、需求四类关系谓词）。
    回放件 `_annot_baseline/ruler17-replay-l.mjs`，清单 `ruler17-replay-l.txt`；语料 = 本线
    **129 批 rewrite.tsv 共 7,383 行**（是 RULER-17 所述 575 块 / 594 行的**超集**；该 575/594 样本
    在本仓没有独立可执行件，故取全量存量）。
    结果：L 命中 **133 → 131**，翻流行 **2 条**，两条都是 `// //` 重复斜杠行（另由嵌套闸拦），无并列清单被放行。
    命中数下降 = **撤销 2 条误报**，不是「少抓了」；方向单调——扩词只会把真解释句改判为通过。
  - **候选词「区分」被否**：回放显示它把 b232 `packages/ui/src/settings/model-provider-section/constants.ts:186`
    的**真并列清单**（「按类型区分预置、编码套餐、团队套餐、加载与自定义」）放行了，属漏判方向，故不纳入。
    这条也说明回放不只是走流程：它拦住了一次会放松判据的扩词。
  - **纪律**：一次只扩一类；同类 miss 至少复现 2 次才扩；每次记录前后 hit 数，扩完用
    `judge-generic` 复核最近两批仍为 0；不因为单个批次的返修就临时加词。

- **动笔前对照清单（b361 起，起草阶段自查，不靠闸报后返修）**
  b357–b360 的 L 命中**不是多种句式并存**，集中在同一类：
  **「两个以上逗号串联的解释句 + 中性动词（拆成 / 下传 / 分派 / 退回 / 符合），谓词表里没有它」**。
  原句（b358 5 条、b360 3 条；b357 只有 1 条 L，另 4 条是 W 无锚点）：
  1. `WorkflowArtifactSidePane:224`「version 与 artifact.version 不等时，正文据此提示还有更新，步进器只负责跳转。」
  2. `CodingPlanContextUsage:350`「[契约] 周额度按日期展示，与五小时的时分口径区分；format 取 "date"，因此重置时间带日不带时。」
  3. `jsx-preview:351`「error 为 null 时不渲染错误条，因此它不占位；错误来自 useJSXPreview 上下文，与内容组件同源。」
  4. `ProviderSettingsCard:365`「loading 只控制按钮禁用与图标，不控制二维码展示，因此两者状态互不牵连。」
  5. `stack-trace:435`「[资源] timeoutRef 初值取 0，清理时直接 clearTimeout(0) 即可，不需要额外的判空分支。」
  6. `ConversationUserInputContent:53`「match 结果拆成 leadingText、commandText、trailingText 三段，前后原文都保留。」
  7. `ConversationTurnRow:62`「row 原样下传给 ConversationRowView，不做拷贝，符合行数据只读契约。」
  8. `ConversationUserInputContent:113`「V4UserInputMention 按 part.type 分派渲染，命令块走独立分支，非权威命令退回纯文本。」
  （b357 `store/index.ts:323` 是唯一 L，原句未留存，台账只记「两逗号无谓词」，改写后含「由此刻定格」。）
  动笔时依次对照：
  1. **逗号 ≥2 就必须有谓词表里的关系词**（由 / 必须 / 只能 / 不能 / 返回 / 保持 / 不会 / 不需要 / 不等 / 来自 / 控制…），否则拆成两句或去掉一个逗号。
  2. **三类词分清楚**（b362 前订正，此前把「控制」误列为中性动词）：
     - **已扩入谓词表**：`不等 / 来自 / 控制 / 不需要`；**b364 起另加系词 `为 / 即 / 表示`**（`等于` 本就在表内）。
     - **决定不补、且有反例**：`区分` —— 它放行过 b232 `constants.ts:186` 的真并列清单。
     - **仍会命中、只能靠改写解决**：`拆成 / 下传 / 分派 / 退回 / 符合`。
     - **闸实跑确认**（不按推理写）：`ProviderSettingsCard:365` 原句
       「loading 只控制按钮禁用与图标，不控制二维码展示，因此两者状态互不牵连。」
       在扩表后 `isWeakContent` 返回 **false（判通过）**；b232 那句返回 **true（仍命中）**。
  2b. **系词「为 / 即 / 表示」的判定（b364 查证并扩表）**
     - 原状：`为 / 即 / 表示` **不在**表里（`等于` 在），所以 b363 `highspeedOutputFooter:104`
       「…三条同时成立才判完成」被 L 命中——不是被别的规则盖掉，就是缺词。
     - RULER-17 规范化回放（`ruler17-replay-v2.mjs`，与闸同源：分隔符 `[、,，]`、只算 L、不含 W；
       语料 **134 批 / 7,488 行 / sha `e0b58371`**）：P0 133 → P1 131（扩 `不等/来自/控制/不需要`）
       → **P2 116（扩 `为/即/表示`），翻流 15 条**，逐条核对全是定义式/失败路径/权衡句，无纯并列清单。
     - **两次回放口径差的交代（b364 订正，旧数留痕不作删）**：
       **原报 `233 → 196`、翻流 37 条**——**已作废**，原因是临时脚本把分隔符写成 `[，,；;、：:]`（多算了 `；`/`：`），
       闸与规范化脚本用的是 `[、,，]`。规范化后为 **`131 → 116`、翻流 15 条**。
       两个脚本的差异只有分隔符一处：`ruler17-copula.mjs`（作废）vs `ruler17-replay-v2.mjs`（唯一基准）。
       **唯一基准**：`ruler17-replay-v2.mjs` + 语料 sha `e4567efd9593344a`（**136 批 / 7,531 行**）；后续扩表只认这个输出。
       **语料哈希已重钉**（b366 后）：`7,531 = 7,488 + 13（b365）+ 30（b366）`；
       旧值 `e0b58371…` 对应 `7,501 = 7,488 + 13`，**已作废**，不能再挂在新语料上——
       语料加批后哈希必然变，挂旧值会让「对齐失败」被误读成语料被篡改。哈希写死在脚本的 `PINNED_SHA`，
       不一致时脚本自己报 `SHA MISMATCH`。
     - **词表已并为单一真源（b366 前，b365 的结构缺陷）**：`zc-vocab.mjs` 导出 `PREDICATE_WORDS` / `PREDICATE`，
       `zc-gate.mjs`（六闸 commit 用）与 `zc-gate-v4.mjs`（judge/precheck 用）都 `import` 它，不再各存一份。
       `sentence-precheck.mjs` 里那份第三拷贝也一并改成 `import`（合并前是 3 份，现为 1 份）。
     - **合并前的差异表**（`vocab-merge-audit.mjs`）：v1 **45 词**、v4 **52 词**；
       **只在一份里的：v4 独有 7 个 —— `不等 来自 控制 不需要 为 即 表示`；v1 独有 0 个**。
       这 7 个正是 b359/b364 两次扩表的结果，全部只落在 v4，所以六闸一直用旧表。
     - **合并安全的证明（先看这一句）**：`45 + 7 = 52` 且 **v1 独有 0 个 ⇒ v4 ⊇ v1**。
       合并取的是 v4（并集），因此**一个词都没丢**，合并只可能「少报」旧表的命中（撤销误报），
       不可能放行任何旧表已拦住的句子。整闸回放 `2,027 → 2,016` 就是这个方向的实测：
       命中只降 11 条，且逐条核对全是关系谓词句，无并列清单被放行。
       **以后有人问「合并没有风险吧」，答案是这一句，不是「三份变一份」。**
     - **整闸回放**（**136 批 / 7,531 行**，两版 `judgeEntries` 各跑一次）：
       合并前 v1(旧表) **2,027** 条、v4(新表) **2,016** 条；合并后两版同为 **2,016**（并入 b366 后仍 2,016，
       即新批 30 行没有新增整闸命中）。
       即**整闸前后差 11 条**，与 `isWeakContent` 单侧的 131→116（15 条）不是同一个口径。
     - **限定**：`131 → 116` 只是 `isWeakContent` 单侧读数；整闸读数是 **2,027 → 2,016**。
       以后报扩表效果必须写明是「单侧」还是「整闸」。
     - **三档边界判例**（补 §8 抽检暴露的「弱 vs 有」切分）：
       - **明确归「弱」**：`packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts:134`
         注释「// 宽或高 ≤ 0 时视为零尺寸直接返回，不写入 lastSizeRef。」
         源码：`if (nextSize.width <= 0 || nextSize.height <= 0) return;`（上一行 `};`，下一行即该 guard）
         理由：条件与 return 在代码里一字不差，「不写入 lastSizeRef」也由「提前 return」直接读出 → 只省一次回溯。
       - **明确归「有」**：`packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx:350`
         注释「// [契约] 周额度按日期展示，与五小时的时分口径区分；format 由 "time" 改为 "date"，重置时间因此只带日。」
         源码：上一行 `: undefined;`，下一行 `// weeklyTokenLimit 无重置时间时 weeklyResetTime 保持 undefined；…`
         理由：给出「为什么两处格式不同」的取舍与被否方案（沿用时分会让周额度显示带小时），代码只能看到 `"date"`。
       - 切分规则：**代码里能直接读出的 = 弱；必须知道取舍/被否方案/边界理由的 = 有**。
     - 实跑（不按推理写）：正例「expiresAt 已过、lastUnitIndex 为组尾、hasOutput 三条同时成立才判完成。」→
       **`false` 判通过**；反例「导航项按类型区分预置、编码套餐、团队套餐、加载与自定义。」→ **`true` 仍命中**；
       另一反例「工具栏：搜索、等级筛选、导出三组按钮。」→ **`true` 仍命中**。
     - 代价：`为` 是高频词，等于放宽了 12% 的 L 命中面；以「引出定义/状态语义」为理由接受，
       若后续出现「A、B、C 均为空」这类靠 `为` 蒙混的清单，按第 1 条处理并记反例。
  3. **每行一个锚点，但要分清两个锚点判据（b372 实测订正）**：
     - `precheck` 的 `ANCHOR` 认「反引号 / 数字 / ≥3 字符标识符」——数字够用；
     - **`W`（单行无信息）走 `ident()`，只认 ≥3 字符标识符与全大写缩写，数字与短词不算**。
       所以「3 条」「1–2 个」这种写法挡不住 W：b372 有 2 条就是只加了数字锚点、被 W 打回
       （`useCodingPlanProducts:105`、`RemoteConnectionSelection:245`）。
     - **尾段一律带反引号标识符**；只有纯计数句才可以只用数字，且必须先跑 `judge` 确认。
     - **分隔符统计穿透反引号（b373 实测，已写进 `sentence-precheck.mjs` 头部规则说明）**：
       `、` `,` `，` 不论是否在代码片段里都计入 `seps`。注释里写 `replace(/^\/+/, "")` 这种带参调用，
       代码里的逗号会让 `seps` 直接到 2 而命中 L。规避写法：拆成 `replace` 配 `/^\/+/`，或引用不带逗号的片段。
  4. 三段并列（`A、B、C`）首选「由三段组成：A、B、C」或加真实标识符，别写成裸并列。
  5. **同一结论只保留信息量最大的那一行，其余宁可留 S**（b365 起执行）。
     依据：`TaskGroupedView` 167/168/169 三行都在讲「内存草稿归属、不写 localStorage」，
     比单条复述更损耗读者——三行读完只得到一次信息，还让人怀疑是不是三种不同约定。
     起草时若发现相邻行在换说法讲同一契约，保留最具体的一条（带标识符/边界条件），其余删掉换普通占位。
  6. **一个巧合不许升格成规律（b372 反例，b370 结论作废）**：
     b370 台账写「补『因此』后 hits=0」，让人以为「因此」是谓词。事实：`PREDICATE_WORDS` 里
     **没有「因此」**，那行能过是因为它另含表内词（巧合）。b372 有一行照抄「因此」，
     `judge` 与 `precheck` 同时报 `L`，改「所以」才过——**反例就在本批台账里**。
     纪律：结论只从「闸实跑的正例 + 反例两跑」来；单批一次通过不算证据。
     上面第 4 条「因此/所以引出的结论句」早已写明这条，b370 的写法属回到旧错。
  7. **收口顺序：`ZC-deep-bXXX-rewrite.tsv` 必须先落盘，再跑 `capacity`（b377 实测）**：
     `capacity` 的「已排期」判定是「文件是否出现在任一 `ZC-deep-b*-rewrite.tsv`」，
     不是读台账正文。b377 先跑 `capacity` 后落 tsv，工具把本批 10 个文件算成未排期，
     报 `ALIGNED acct_remain=494 pool_remain=464 diff=30 MISMATCH` 并 exit 1——**这是假警报，但会让收口重跑一次**。
     固定顺序：扫描 → `plan-new` 复制成 rewrite.tsv → `own-commits-gen` → `capacity` → 台账 → 提交。
     **b382 起这段已封成单入口**：批次只调
     `node d:/code/_annot_baseline/closeout.mjs <batch> --pre <prevBatch> [--subject ...]`，
     顺序与参数都写死在脚本里（`--repo` / `--root` / `--weak` 批次侧不传）。
     理由：这条顺序**连犯两次**（b377 `32s`、b381 `40s`，两次都是先跑 capacity 后落 tsv/白名单）。
     把顺序错从「靠自觉」变成「做不到」；台账仍人工写，脚本在 `--subject` 前检查台账是否存在。
  8. **批次计时必须给 S0–S4 分段，且分段与总数同精度相加（b386 起）**：
     只报一个 `84.0s` 无法判断反弹是正常波动还是又一次小事故。**台账 §4 与批次回报（发给用户的消息）两处同列**，
     固定段 `S0 提交→closeout / S1 扫描 + 1b/1c / S2 rewrite+白名单+capacity / S3 台账 / S4 提交`，
     返修单独列 `S1′`，不计进正常分段。所有分段保留一位小数，**分段之和必须逐字等于收口**
     （b385：`3.0 + 7.3 + 1.3 + 8.4 + 63.0 + 1.0 = 84.0`）；加不上就是漏了一段，先找差再写台账。
     - **b386 首违记录**：台账 §4 有完整分段，但回报只写了 `收口 54.0s`。根因是上一版条文只写「台账 §4」，
       没把回报列进去——模板缺项，不是记账错。本条已改成两处同列，b387 起回报必须带分段行。
  9. **窗口滚动必须写出滚入/滚出（b387 起）**：批报固定一句
     「滚入 `bN（Xs）`、滚出 `bM（Ys）`，区间从 `A–B` 变为 `C–D`」。
     `closeout.mjs` 的 `[窗口滚动]` 行给出前两项，区间由同窗口 min/max 现算；只更新数字不说窗口动了哪一格，视为漏报。
  10. **两个同值计时不许互相印证（b388 定）**：`controllable` 与 `收口` 各由自己的端点独立算出；
     若两者恰好都读到同一个数（b388 的 `155.0`），**不许把「和值等于墙钟」当证据**，
     一律降级为 `±0.5s` 读数，并以实测端点重写 `批墙钟`（b388：`309.4`，不是 `155+155=310.0`）。
  11. **S3 拆 `S3a` / `S3b`（b389 起执行）**：`S3a` = 台账 + 白名单（稳态，进收口中位）；
     `S3b` = CLOSING / INDEX 填数（文档开销，单列）。b387/b388 的 `65.0s` 中位含文档成本，已在 CLOSING §5 标注。
  12. **参数写重是硬错误（b388）**：`gate-run.mjs` 的 `opt()` 在值以 `--` 开头时直接 `exit 2`。
     b388 多写一个裸 `--subject`，把 `--batch` 吃成前缀，提交标题退化成 `true`；该提交未推送，
     已用 `rebase --onto` 只换标题（`b217963d` → `bc24a2b7`），`OWN-COMMITS` 同步，旧链留 `b388-backup`。

  因为命中集中在这一类，**`hit_rate` 门槛维持 20%**，不下调；靠清单前置解决，闸只作兜底。

- 判据闸（L / W / 堆叠）**保留不动**，本节只用于起草阶段自查；命中仍以闸为准。
- **分工（b348 实测）**：§5.3 的 16 条 L 里 **16/16 都由判据闸首轮报出**，没有一条需要人工回读才发现。
  所以问题不在闸的覆盖面，而在**起草顺序**——写完没有先跑闸就往下走。规范管「怎么写」，闸管「写完是否合格」；
  规范用来降低回改率，闸用来兜底，二者不可互相替代。
- 起草时每行问一次「这行删掉，读者会不会改错？」——不会就删，不要用并列填充。
