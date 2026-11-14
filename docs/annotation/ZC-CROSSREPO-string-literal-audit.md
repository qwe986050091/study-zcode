# 跨仓「注释落入字符串字面量」审计

> 触发原因：`offPeakTaskRepo.ts` / `source-server-schema-v5.ts` 的 28 行 `//` 落进 SQL 模板字符串，`node:sqlite` 实测 `prepare` 报 `near "/": syntax error`。这不是注释写法问题，是**把运行时数据改坏了**。
> 结论（2026-11-08 收口）：本轮新增命中已全部修复——ZCode 15 行 + uv 39 行（38 + 复扫新发现 1），复扫两仓 `new=0`；其余仓的命中全部在 HEAD 中（非本轮新增）。修复记录见 [ZC-fix-string-literal-b2.md](./ZC-fix-string-literal-b2.md)。
> 工具：`_annot_baseline/zc-stringscan.mjs`（按语言词法定位字符串 token 字符区间，逐行判断是否以该语言的注释前缀开头）。

## 1. 判定方法

1. 按语言取多行字符串 token 区间：
   - TS/JS：TypeScript AST 的 `StringLiteral` / `NoSubstitutionTemplateLiteral`；
   - Python：三引号字符串（自写词法，跳过 `#` 行注释与单行字符串）；
   - Rust：普通字符串、`r#"..."#` / `br#"..."#` 裸字符串（含嵌套块注释处理）；
   - Go：反引号裸字符串；
   - C/C++：普通字符串（含反斜杠续行）与 `R"delim(...)delim"` 裸字符串。
2. 字符串首行之后，若某行 `trim()` 后以该语言注释前缀开头（TS/Rust/Go/C 为 `//`，Python 为 `#`），记为命中。
3. 对命中文件取 `git show HEAD:<file>`，若同一行文本已在 HEAD 中出现，标记 `in-head`（既有内容，非本轮新增）；否则标记 `new`。
4. 不使用正则扫描源码文本，避免把行注释、URL、正则字面量误判为字符串区间。

## 2. 汇总

| 仓库 | 扫描文件 | 命中 | 其中 new（本轮新增） | in-head | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| ZCode | 9,818 | 96 | **0** | 96 | 28 行 SQL + 15 行字符串内注释均已修复 |
| gemini-cli | 2,328 | 64 | 0 | 64 | 干净 |
| claude-code | 1,902 | 0 | 0 | 0 | 干净 |
| uv | 858 | 73 | **0** | 73 | 39 行已修复（38 + 复扫新发现 1） |
| redb | 105 | 0 | 0 | 0 | 干净 |
| valkey | 932 | 23 | 0 | 23 | 干净 |
| mcp-typescript-sdk | 784 | 3 | 0 | 3 | 干净 |
| mcp-python-sdk | 876 | 79 | 0 | 79 | 干净 |
| mcp-server-go | 31 | 0 | 0 | 0 | 干净 |

> `in-head` 命中是仓库原有的示例文本（如 docstring 里的代码样例、测试快照），不属于本轮插入，不列入整改：撤回它们等于删除上游内容，属于改代码而不是注释工程。

## 3. 修复明细（54 行，已全部完成）

### 3.1 ZCode（15 行，均为字符串内嵌另一门语言）

| 文件 | 修复前行号 | 字符串类型 | 内嵌语言 | 处置 |
| --- | --- | --- | --- | --- |
| `docs/knip/docs/scripts/get-monthly-sponsorships-github.ts` | 58 | template | GraphQL | 移到 `graphql(...)` 调用前；`graphql.parse` 实测通过 |
| `packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts` | 298–301、331–334 | template | JavaScript（`executeJavaScript`） | 移到两处 `executeJavaScript` 语句之前 |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts` | 213–216 | template | JavaScript | 移到 `const samples = await ui(...)` 之前 |
| `packages/desktop/src/main/windowsAumidIcon.ts` | 69、74 | template | C# | 改写为 `WINDOWS_AUMID_ICON_SCRIPT` 上方的 TS 注释（第 74 行那条 `SIIGBF_*` 属 HEAD 既有，未动） |

### 3.2 uv（39 行，集中在 2 个文件）

| 文件 | 行号 | 字符串类型 | 内容性质 | 处置 |
| --- | --- | --- | --- | --- |
| `crates/uv-requirements-txt/src/lib.rs` | 2026–2028、2139、2158、2174、2212、2249、2267、2321–2322、2338、2375、2421、3457–3459（17 行） | rust-string | 测试用 `requirements.txt` 夹具（`indoc!`） | 删除，夹具内容回到 HEAD |
| 同上 | 2450–2452、2463、2468、2524–2525、2551、2595–2596、2620、2722、2757、2799–2801、2978、3014–3016、3529（21 行） | rust-raw | 测试期望值 / 内嵌 Rust 片段 | 删除，期望文本回到 HEAD |
| `crates/uv-cache/src/lib.rs` | 689（1 行） | rust-string | `warn!` 的 `\` 续行字符串 | 删除；首次扫描误判 `in-head`，复扫确认后修掉 |

两个文件在 `git diff HEAD` 中均为纯新增（`uv-requirements-txt` +458 / `uv-cache` +466，0 删除），确认是未入库的自有改动，不是上游内容。


## 4. 已修（28 行，ZCode，上一批）

| 文件 | 行数 | 字符串类型 | 处置 |
| --- | ---: | --- | --- |
| `packages/services/src/session/offPeakTaskRepo.ts` | 22 | SQL 模板字符串 | 移出字符串，改写到 `.prepare(` 上方 |
| `packages/services/src/session/tasksDatabase/source-server-schema-v5.ts` | 6 | SQL 模板字符串 | 同上 |

以 `HEAD` 为基线验收 `codeTokenDiff=0`；`node:sqlite` 实测 28/28 条语句 `prepare` 成功（修复前 16/16 失败）。详见 [ZC-fix-sql-literal.md](./ZC-fix-sql-literal.md)。

## 5. 复现命令

```text
node _annot_baseline/zc-stringscan.mjs d:\code\ZCode
node _annot_baseline/zc-stringscan.mjs d:\code\opensource\uv
node _annot_baseline/zc-stringscan.mjs d:\code\opensource\gemini-cli
node _annot_baseline/zc-stringscan.mjs d:\code\claude-code-main
node _annot_baseline/zc-stringscan.mjs d:\code\opensource\redb
node _annot_baseline/zc-stringscan.mjs d:\code\opensource\valkey
node _annot_baseline/zc-stringscan.mjs d:\code\opensource\mcp-typescript-sdk
node _annot_baseline/zc-stringscan.mjs d:\code\opensource\mcp-python-sdk
node _annot_baseline\zc-stringscan.mjs d:\code\mcp-server-go
```

原始输出：`_annot_baseline/scan-<repo>.tsv`。

## 6. 建议

1. 修复已完成，验收口径固定为三条：HEAD 基线 `codeTokenDiff=0`、字符串 token 数组逐项 `===`、GraphQL query 用 `graphql.parse` 实测。
2. 后续任何注释批次落盘前增加一步 `zc-stringscan`（或至少 `zc-sqlscan`）预检，不能只依赖 gate：gate 只看「注释像不像注水」，看不到「注释是否落在字符串里」。
3. `in-head` 若确需清理，单独立项并说明它改变的是上游示例或快照，不得混入注释批次。
