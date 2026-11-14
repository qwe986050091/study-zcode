# ZC-DEEP：packages/desktop/src/main/windowsAumidIcon.ts

> 状态：**可注部分已完成**（b1 落盘 16 行 + b2 补 3 行块说明，23/23 可注单元清零；**38 单元位于 `String.raw` 内，按 §7.4 只可外部说明、不可逐行注**）
> 文件规模：原始 150 行 + 已插入 19 行 = 当前 169 行 / **61 单元，其中可注 23** / 起始 7 covered（11.5%）/ 可注部分 100%，全文件 37.7%
> 风险档：A（不可逆证据：命令执行边界——`execFile` 启动 `powershell.exe`，AUMID 直接进入脚本参数；R1.11）
> 口径：`deep-quality.mjs --metric-version v3`；批次目录 `_annot_baseline/WAI-deep-b01/`

## 1. 批次清单

起始未覆盖 54，其中 **38 行落在 `String.raw` 模板内部**（当前第 37–95 行，PowerShell + C# 脚本正文；b2 插入前为 34–92。声明行 37、闭合反引号 95，两者之间 38–94 是脚本内容）。按 §7.4「注释不得插入字符串内部」，这 38 单元是**结构性不可逐行注**，不进本批锚点；且本文件多数单元属于该脚本，故本批只覆盖脚本外的 16 行，与 DEEP-SPEC §2.9「可注分母」口径一致（同 b228 §4.20：注入脚本内的单元不计入可注分母）。

「不可逐行注」不等于「不可注」：b2 在脚本**外部**（声明处 34–36 行）补了三行块说明，交代这段脚本干什么、有几个函数、调用顺序与失败语义。这 38 行因此是**已说明但未逐行加注释**，不是没有解释的代码；边界见 §5 的逐行登记表。

| 批次 | 区域（原行号） | 插入行数 | 落盘后 UNCOVERED | 提交 |
| --- | --- | ---: | ---: | --- |
| b1 | 全文 25–150（脚本外逐条） | 16 | 38（全部为脚本内行） | `7ea473bb` |
| b2 | 原 33 后（`WINDOWS_AUMID_ICON_SCRIPT` 定义处） | 3 | 38（不变） | `6a8cc6c9` |

**合计插入 19 行**；`Δuncovered = 54 → 38`，恰为 −16，§2.7 不变量成立（b2 的 3 行落在已覆盖的声明处，不新增单元）。

**W 前置门禁拦下 1 行、零落盘**：anchor 97 原句「执行器与系统根目录两项」缺 ASCII 标识符，`exit 1` 后改写为「签名只有 `command` 与 `args` 与 `timeoutMs` 三项」。`zc-gate --scan` 另判 1 行 L（§4）。

**未做并说明理由的地方**：`Add-Type`、`SHCreateItemInKnownFolder`、`GetImage`、`DeleteObject` 等 C# 行全部在脚本字符串内，只在字符串**外**的 `WINDOWS_AUMID_ICON_SCRIPT` 声明处有块注释交代用途；没有向脚本里塞 `//`，否则 PowerShell 段会直接语法失败。

## 2. 单元最终归属分布

| 归属 | 数量 | 占比 | 说明 |
| --- | ---: | ---: | --- |
| 已写注释（新增） | 16 | 26.2% | b1 插入 16 行 |
| 起始已是上游注释 | 7 | 11.5% | orig 快照内已有 |
| **结构性不可注（`String.raw` 内）** | **38** | **62.3%** | §7.4：插入即改动运行时脚本 |
| 未覆盖（可注） | 0 | 0% | 可注分母 23 已全部覆盖 |
| **合计** | 61 | 100% | `covered=23`，全文件覆盖率 37.7% |

`mappedStrict=23` 等于可注分母：脚本外的 23 个单元全部由整行注释严格映射。b2 的 3 行块说明落在已覆盖的 `WINDOWS_AUMID_ICON_SCRIPT` 声明区（当前 34–36 行），**不新增单元**，因此归属分布不变。

**这 38 个单元不得再由后来者「补注」**：在 `String.raw` 里插 `//` 会改变 `WINDOWS_AUMID_ICON_SCRIPT` 的字节内容，属于改源码；HEAD 里已有一行这样的历史注释（下方 PRE-EXISTING 违规），是反例而非范例。边界不是「整个字符串」这种模糊说法，而是 §5 那张逐行登记表——后来者若要判断某一行能不能加注释，先查表里的区间。

## 3. 文件分段表

行号为插入完成后的当前值（150 + 19 = 169 行）。

| 行号（当前） | 段 | 内容 |
| --- | --- | --- |
| 1–13 | 模块头 | **INV-01…INV-13 不变量表**（AUMID 只接受 Shell 标识、必走 `SHCreateItemInKnownFolder`、GDI/COM 必释放、失败一律 null…） |
| 15–16 | 模块头 | 模块职责、阅读顺序 |
| 17–20 | 依赖 | `execFile`、`win32`、`ApplicationIconInfo`、`createEncodedPowerShellArgs` |
| 22–26 | 常量 | `SAFE_AUMID` 两段式正则、`MAX_ICON_BASE64_CHARS`（1 MiB） |
| 28–33 | 脚本声明 | 意图注释：不能当路径交给 `app.getFileIcon`，必须走 Shell namespace；EncodedCommand 传参 |
| 34–36 | 脚本声明 | **b2 块说明**：脚本干什么（一个静态方法 `Read`）、调用顺序（Add-Type → Read → base64）、失败语义（HRESULT 非零即抛，stdout 为空） |
| 37 | 脚本声明 | `const WINDOWS_AUMID_ICON_SCRIPT = String.raw\`` |
| 38–94 | **脚本正文** | `String.raw` 内的 PowerShell + C#（**结构性不可逐行注**，37 单元；区间见 §5） |
| 95 | 脚本闭合 | `` `; ``——闭合反引号本身也是该模板字面量的最后一个单元（38 单元中的第 38 个） |
| 97–104 | 类型 | `WindowsAumidIconDependencies`：`execute` + `systemRoot` |
| 106–124 | 默认依赖 | `execFile` + `windowsHide` + `timeout`；`SystemRoot` 兜底 `C:\Windows` |
| 126–166 | **读取器** | `createWindowsAumidIconReader`：trim → 正则 → 拼 powershell 路径 → EncodedCommand → 非空/长度/字符集三重校验 → `data:` URL |
| 168–169 | 导出 | `readWindowsAumidIcon` 单例 |

## 4. 门禁记录

五道门禁：`zc-gate`、`zc-verify`、`deep-boilerplate --diff`、`check-upstream-comments`、`check-comments-in-strings`（后两道对本文件尤其重要——脚本内不能出现新注释）。

- **`zc-gate --scan` 首次判 1 行 L**：anchor 97 原句含 2 个顿号且无谓词词；改写为「签名只有 `command` 与 `args` 与 `timeoutMs` 三项，测试替换时无需启动真实进程」后 `waterLines=0`。
- `check-comments-in-strings`：`violations=1` 但 **`addedViolations=0`**——那 1 条是 HEAD 里既有的 `// SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY…`（模板内整行注释），**不是本批引入**，按 §2.6 不改写、不删除。b2 后行号由 `:75` 变为 `:78`。
- 终态：`waterLines 0`、`deletedNonZero 0`、`nonCommentAdded 0`、`starSlash 0`、`syntaxErrorFiles 0`、`dups 0`、`upstream missing 0`、`addedViolations 0`、`codeTokenDiff 0`。

**收口原始输出（b2 提交后复跑，直接粘贴，不转述）**

```text
$ node _annot_baseline/deep-quality.mjs d:\code\ZCode --files packages/desktop/src/main/windowsAumidIcon.ts --metric-version v3 --field-mode ast --quiet --json ... --uncovered ...
UNCOVERED units=38 out=d:\code\_annot_baseline\WAI-deep-b01\_uncovered_v3.txt
SUMMARY metric=v3 files=1 units=61 coverage=37.7% branch=40.0% field=100.0% comments=52 substance=98.1% explain=100.0% filler=0.0% weak=0.0%
MAP comments=52 mappedStrict=23 mappedBlock=36 unmapped=16 reasons=import:16,structural:0,continuation:0,gap:0,eof:0,other:0
```

```text
$ node _annot_baseline/_ssh-insert.mjs ...\b1.json ...\windowsAumidIcon.ts
inserted 16 lines at 16 anchors
$ git log --oneline -1 7ea473bb
7ea473bb 注释(desktop): windowsAumidIcon.ts b1 — 依赖注入与输出校验（+16 行）
$ git cat-file -t 7ea473bb
commit
$ git log --oneline -1 6a8cc6c9
6a8cc6c9 注释(desktop): windowsAumidIcon.ts b2 — 脚本定义处补三行结构说明（+3 行）
$ git cat-file -t 6a8cc6c9
commit
```

```text
$ node _annot_baseline/zc-gate.mjs --scan ...\WAI-deep-b01\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=0 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs WAI-deep-b01
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=19
$ node _annot_baseline/deep-boilerplate.mjs d:\code\ZCode --diff --files packages/desktop/src/main/windowsAumidIcon.ts
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs d:\code\ZCode ...\WAI-deep-b01\_files.txt HEAD
SUMMARY files=1 checked=1 upstreamComments=51 missing=0
$ node _annot_baseline/check-comments-in-strings.mjs d:\code\ZCode ...\WAI-deep-b01\_files.txt
SUMMARY files=1 scanned=1 stringRanges=13 violations=1 addedViolations=0
PRE-EXISTING	whole-line	NoSubstitutionTemplateLiteral	packages/desktop/src/main/windowsAumidIcon.ts:78	// SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY，避免退化成宿主 exe 缩略图。
$ node _annot_baseline/check-code-tokens.mjs d:\code\ZCode ...\WAI-deep-b01\_files.txt ...\WAI-deep-b01\orig
SUMMARY files=1 codeTokenDiff=0
```

> `zc-gate` 为**两次提交后**复跑，`addedCommentLines` 归零是 diff 基准为 HEAD 所致；提交前同一命令 b1 为 `addedCommentLines=16`、b2 为 `addedCommentLines=3`，两次 `waterLines` 均为 0。`added=19` 是 16 + 3 的累计。

**起始基线（存档，用于复核 `Δ = −16`）**

```text
UNCOVERED units=54 out=d:\code\_annot_baseline\WAI-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=61 coverage=11.5% branch=20.0% field=0.0% comments=33 substance=97.0% explain=100.0% filler=0.0% weak=0.0%
MAP comments=33 mappedStrict=7 mappedBlock=17 unmapped=16 reasons=import:16,structural:0,continuation:0,gap:0,eof:0,other:0
```

## 5. `String.raw` 内 38 行逐行登记（豁免类：字符串内部）

来源：`_annot_baseline/WAI-deep-b01/_uncovered_v3.txt`（逐行抄录，不按语句类型筛选，§2.9.1）。行号为 b2 落盘后的当前行号；`B` 表示该行带分支单元。

| 区间 | 行数 | 内容 | 备注 |
| --- | ---: | --- | --- |
| 38–44 | 7 | `Add-Type -AssemblyName System.Drawing`、`Add-Type -TypeDefinition @'` 与六条 `using` | 脚本入口 |
| 46–48 | 3 | `ZCodeAumidIcon` 类头、`SIZE` 结构与其 `StructLayout` | — |
| 50–55 | 6 | `IShellItemImageFactory` 的 `ComImport` / `Guid` / `InterfaceType` 与 `GetImage` 声明 | COM 接口绑定 |
| 58–59 | 2 | `SHCreateItemInKnownFolder` 的 `DllImport` 与签名头 | P/Invoke |
| 66–67 | 2 | `DeleteObject` 的 `DllImport` 与签名 | P/Invoke |
| 69–73 | 5 | `Read` 方法头、两个 `Guid` 局部变量、`IShellItemImageFactory` 局部变量、`created` 赋值起始 | 取图主路径 |
| 75 | 1 | `if (created != 0 …) Marshal.ThrowExceptionForHR` | **B**：创建失败分支 |
| 76 | 1 | `IntPtr bitmap = IntPtr.Zero` | 句柄初值 |
| 80–84 | 5 | `GetImage` 调用与 `loaded` 判空（80）、`Bitmap`/`MemoryStream` 两个 `using`（81–82）、`PNG` 保存（83）、`ToArray`（84） | 80 为 **B**：取图失败分支 |
| 87–88 | 2 | `finally` 内 `DeleteObject` 与 `ReleaseComObject` | 87 为 **B**：位图非空判断 |
| 92–95 | 4 | `'@;` 结束内联 C#（92）、`$zcodeIconBytes` 调用 `Read`（93）、`[Console]::Out.Write` 输出 base64（94）、闭合反引号（95） | PowerShell 侧 |
| **合计** | **38** | — | 与 `UNCOVERED units=38` 相等 |

这 38 行**永久留在未覆盖**，按豁免类「字符串内部」登记，不再列入待做（后续统计请用「可注 23」而不是「61」）。说明责任由 §3 的 34–36 行块说明承担；后来者不得在这 38 行内追加任何 `//`。

## 6. 遗留项

1. 只做语法 fail-closed 校验，未执行 `tsc --noEmit` 与单元测试。
2. 若要提高本文件可读性，正确做法是把 C# 脚本拆到独立文件并在那里注释，而不是在模板字符串里插注释——属于重构，不在本轮范围。
