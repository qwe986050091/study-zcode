# ZC-fix-string-literal-b2（bug 修复批次：字符串内注释清零）

> 性质：**运行时数据修复**，不是注释质量问题。`//` 在 JS / C# 字符串里语法合法，但它改写了 `executeJavaScript` 注入脚本与内嵌 C# 的文本，行为就不再等于 HEAD；GraphQL 与 SQL 更直接——查询 / 语句解析失败。
> 触发依据：`ZC-CROSSREPO-string-literal-audit.md` 的全仓扫描（按 AST / 词法定位字符串 token 区间，不靠正则）。
> 记账：独立批次，不计入任何 A / B 注释产出；只移出注释行，不改一个代码 token。

## 1. 范围与分类

| 类别 | 仓库 | 文件 | 行数 | 处置 |
| --- | --- | --- | ---: | --- |
| GraphQL | ZCode | `docs/knip/docs/scripts/get-monthly-sponsorships-github.ts` | 1 | 移到 `const { viewer } = await graphql(...)` 上方 |
| JS 注入（`executeJavaScript`） | ZCode | `packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts` | 8 | 移到两处 `await win.webContents.executeJavaScript(` 语句之前 |
| JS 注入（`executeJavaScript`） | ZCode | `packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts` | 4 | 移到 `const samples = await ui(...)` 之前 |
| 内嵌 C# | ZCode | `packages/desktop/src/main/windowsAumidIcon.ts` | 2 | 改写为常量上方的 TS 注释块 |
| `indoc!` 夹具 | uv | `crates/uv-requirements-txt/src/lib.rs` | 17 | 删除（撤回插入的夹具内容） |
| raw string 期望值 | uv | `crates/uv-requirements-txt/src/lib.rs` | 21 | 删除（撤回插入的期望文本） |
| Rust 普通串（`\` 续行） | uv | `crates/uv-cache/src/lib.rs` | 1 | 删除 |
| **合计** | | | **54** | ZCode 15 + uv 39 |

SQL 那 28 行已在上一批 `ZC-fix-sql-literal` 修复，不在本批范围内。

## 2. ZCode 15 行逐处明细

| 文件 | 修复前行号 | 现位置 | 字符串类型 | 内嵌语言 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `get-monthly-sponsorships-github.ts` | 58 | 54 | template | GraphQL | 查询内 `//` 会让 `graphql.parse` 直接失败；说明移到 `graphql(...)` 调用前 |
| `presentation-checks.ts` | 298–301 | 292–295 | template | JavaScript | 取点坐标说明（含 `[契约]` / 失败路径），移到 `const point = await ...executeJavaScript(` 前 |
| `presentation-checks.ts` | 331–334 | 328–331 | template | JavaScript | `requestAnimationFrame` 轮询说明，移到 `const dragged = await ...executeJavaScript(` 前 |
| `managed-checks.ts` | 213–216 | 212–215 | template | JavaScript | 包内滚动位移与 `checkModel` 登记顺序说明，移到 `const samples = await ui(...)` 前 |
| `windowsAumidIcon.ts` | 69 | 31 | template（`String.raw`） | C# | 失败即抛 HRESULT 的说明，改写为 `WINDOWS_AUMID_ICON_SCRIPT` 上方的 TS 注释 |
| `windowsAumidIcon.ts` | 74 | 32 | template（`String.raw`） | C# | 固定取 64x64 的原因，同上 |

注释移到字符串外后，模板内部只剩原始代码；`presentation-checks.ts` 与 `managed-checks.ts` 的注入脚本从第一条 `const` / `(() => {` 起与 HEAD 一致。

## 3. uv 39 行逐处明细

全部是**未入库的自有插入行**，`git diff HEAD` 中表现为纯新增（`uv-requirements-txt` +458 / `uv-cache` +466，0 删除），因此删除它们不会触碰任何上游内容。

### 3.1 `indoc!` 夹具（17 行）

`2026–2028`、`2139`、`2158`、`2174`、`2212`、`2249`、`2267`、`2321–2322`、`2338`、`2375`、`2421`、`3457–3459`

这类行落在测试用 `requirements.txt` 夹具里，会让解析器读到带 `//` 的假需求行，用例断言的输入已经不是 HEAD 的输入。

### 3.2 raw string 期望值（21 行）

`2450–2452`、`2463`、`2468`、`2524–2525`、`2551`、`2595–2596`、`2620`、`2722`、`2757`、`2799–2801`、`2978`、`3014–3016`、`3529`

这类行改动的是断言期望文本。测试仍会「通过」，但通过的是被我们改过的期望——比改生产代码更隐蔽。

### 3.3 Rust 普通串续行（1 行）

`crates/uv-cache/src/lib.rs:689`，位于 `warn!("... filesystem, \` 的 `\` 续行字符串内部。首次扫描按 `includes` 误判为 `in-head`，复扫确认不属于 HEAD 后删除。

## 4. 验收

### 4.1 以 HEAD 为基线：`codeTokenDiff=0`

批次快照 `_annot_baseline/ZC-fix-string-literal-b2/orig/` 由 `git show HEAD:<file>` 直接写出（`zc-snap-head.mjs`，不经 shell 重定向，避免编码转换）。

```text
node _annot_baseline/zc-verify.mjs --rewrite ZC-fix-string-literal-b2
SUMMARY files=4 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0
codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

`git diff --numstat` 也显示 4 个文件全部是纯新增注释、零删除：

```text
30  0  docs/knip/docs/scripts/get-monthly-sponsorships-github.ts
118 0  packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts
64  0  packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts
30  0  packages/desktop/src/main/windowsAumidIcon.ts
```

### 4.2 字符串内容逐字比对 HEAD（`===`，不是「看起来对」）

工具：`_annot_baseline/zc-tokeneq.mjs`。TS 用 AST 取 `StringLiteral` / `NoSubstitutionTemplateLiteral` 原文数组逐项比较；Rust 用自制词法取字符串 token 数组与「去注释去空白后的代码 token」数组逐项比较。两侧先统一 LF（`git show` 出 LF、工作树是 CRLF，不归一会把纯行尾差异误报成内容差异）。

```text
# ZCode
FILE docs/knip/docs/scripts/get-monthly-sponsorships-github.ts strings=9/9 stringsSame=true
FILE packages/desktop/src/main/windowsAumidIcon.ts strings=12/12 stringsSame=true
FILE packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts strings=99/99 stringsSame=true
FILE packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts strings=96/96 stringsSame=true
SUMMARY files=4 mismatched=0

# uv
FILE crates/uv-requirements-txt/src/lib.rs strings=324/324 stringsSame=true codeTokensSame=true
FILE crates/uv-cache/src/lib.rs strings=93/93 stringsSame=true codeTokensSame=true
SUMMARY files=2 mismatched=0
```

### 4.3 GraphQL 解析器实测

工具：`_annot_baseline/zc-graphql-check.mjs`，用 ZCode 自带的 `graphql` 16.13.2 解析源码里的 query（TS AST 抽取模板原文），并与 HEAD 的同一 query 比较。

```text
node _annot_baseline/zc-graphql-check.mjs d:\code\ZCode docs/knip/docs/scripts/get-monthly-sponsorships-github.ts
PARSE_OK index=0 definitions=1 chars=434
  operation=query selections=viewer
COUNT cur=1 head=1
SAME_AS_HEAD=true
```

### 4.4 复扫：本轮新增为 0

```text
node _annot_baseline/zc-stringscan.mjs d:\code\ZCode
SUMMARY repo=ZCode files=9818 hits=96 new=0 inHead=96 untracked=0

node _annot_baseline/zc-stringscan.mjs d:\code\opensource\uv
SUMMARY repo=uv files=858 hits=73 new=0 inHead=73 untracked=0
```

## 5. 为什么 `in-head` 那些不动

复扫剩余的 96（ZCode）/ 73（uv）行命中，逐行取 `git show HEAD:<file>` 做 `includes` 比对，全部在 HEAD 里已有：它们是上游自带的示例文本、docstring 代码样例与测试快照。判定依据：

1. **归属**：不是我们插入的，撤回它们等于删除上游内容，属于改代码而不是注释工程。
2. **等价性**：HEAD 本来就以这种形态运行，本批目标是让工作树字符串回到 HEAD，而不是让上游变得「更干净」。
3. **可验证**：`new=0` 且 `untracked=0`，说明工作树里已经不存在「本轮新增且落在字符串内」的注释行。

若后续要清理 `in-head`，应作为独立的上游改动评估（会改变示例文本或快照），不能混进注释批次。

## 6. gate 记录（如实登记）

```text
node _annot_baseline/zc-gate.mjs --scan _annot_baseline/ZC-fix-string-literal-b2/_files.txt
SUMMARY files=4 badFiles=4 addedCommentLines=242 waterLines=47 waterRate=19.42%
```

这 47 行**不是本批引入**：gate 用 `git diff HEAD` 统计所有以 `//` 开头的新增行，本批移出的注释在字符串内部时就已经被同样计入（只要行首 trim 后是 `//`）。本轮只是改位置，`addedCommentLines` 与命中内容都不变，属于基线前漂移（A / B 批次历史遗留），按既有约定只记录不改。

## 7. 不变量

- 字符串字面量内部不得出现注释行：GraphQL 会解析失败，JS / C# 会改写运行时数据，测试夹具与期望值会被静默篡改。
- 修复批次以 HEAD 为基线验收：`codeTokenDiff=0` 且字符串 token 数组逐项 `===`。
- `in-head` 上游内容不在本工程整改范围内。
- 后续任何注释批次落盘前必须跑 `zc-stringscan.mjs`；`zc-gate.mjs` 只看注释像不像注水，看不到注释是否落在字符串里。

## 8. 未执行

- 未执行 `git add` / `git commit`。
