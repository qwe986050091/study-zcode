# ZC-DEEP-sshAuth（一档 A 组 · 凭据/令牌文件）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md` v2.4（§2.6 归属判据、§5.3.1 取小者与抽样规则、§5.3.7 分母口径、§2.4 双写、§2.5 不整段替换）。
> 范围：单文件 `packages/server/src/remote/sshAuth.ts`（落盘后 170 行，58 个可注单元；HEAD 快照 118 行）。
> 判据：按「改错或删掉会不会被发现」写，接口字段行、对象字面量属性行、分支行照写。

## 1. 预登记（动手前）

| 项 | 值 |
| --- | --- |
| 抽样框 | `d:\code\_annot_baseline\SSHAUTH-deep-b01\_uncovered.txt`（`deep-quality --uncovered` 生成） |
| 起始状态 | units 58 / covered 6 / **10.3%** / `R = 52`（branch 14.3%、field 0.0%） |
| 阈值判定 | `R = 52 ≤ 120`，按 §5.3.1 直接全读，**无需抽样** |
| 停止规则 | 末轮 `UNCOVERED units=0` |
| 归属判据 | 改写任何一行前先查 `SSHAUTH-deep-b01/orig/`；快照中存在即上游，只许新增（§2.6） |
| 批次前状态 | 工作区干净，无批次前注释；上游原有 13 行注释 |

## 2. 实际执行（**从文件尾部向头部**倒序分批，5 批）

| 批次 | 区域（自尾向头） | 新增整行 `//` | 落盘后 covered |
| --- | --- | ---: | ---: |
| b1 | `authenticationError`、`normalizeSSHConnectError` 尾段 | 12 | 18（31.0%） |
| b2 | `createKeyboardInteractiveResponder`、`normalizeSSHConnectError` 头段 | 11 | 29（50.0%） |
| b3 | `buildSSHConnectConfig` 返回对象 | 13 | 42（72.4%） |
| b4 | 常量、`SSHConnectConfigInput` 字段、两个私钥文案判据 | 15 | 57（98.3%） |
| b5 | 补 `_instructions` 形参 1 处（b2 漏锚） | 1 | 58（100.0%） |
| **合计** | — | **52** | — |

起点 10.3% → 终点 **100.0%**；`git diff HEAD --numstat` = **+52 / −0**。

## 3. 定格表述

**`R = 0`（58/58 全读收口）**，形式记为 `read-all`。

## 4. 数量对账

| 口径 | 值 | 来源 / 校验 |
| --- | ---: | --- |
| 可注单元 | 58 | `deep-quality --metric-version v3` |
| 文件内注释行（`//` 开头，当前） | 65 | 直接计数 |
| 相对基线新增行 | 52 | `git diff HEAD --numstat` = `+52 / −0` = `zc-verify added` |
| 上游原有 `//` 行 | 13 | orig 中直接计数；65 − 52 = 13；`check-upstream-comments` 亦为 13 |

闭合：**13（上游） + 52（新增） = 65（现状）**。

## 5. 门禁（末轮实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 覆盖 | `deep-quality.mjs --metric-version v3` | units 58 / coverage **100.0%** / branch 100%（7/7）/ field 100%（7/7）/ substance 98.5% / explain 100.0% / filler 0.0% / weak 0.0% / **UNCOVERED units=0** |
| 映射 | 同上 `MAP` | mappedStrict 58 / mappedBlock 65 / unmapped 0（import 0、structural 0、continuation 0） |
| 代码与上游 | `zc-verify.mjs SSHAUTH-deep-b01` | deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0 / added 52 |
| 注水 | `zc-gate.mjs --file packages/server/src/remote/sshAuth.ts` | badFiles **0** / waterLines **0** / waterRate 0.00% |
| 近重复 | `deep-boilerplate.mjs --diff --baseline SSHAUTH-deep-b01\orig` | groups 0 / lines 0 / files 0 / dups 0 / dupLines 0 / singles 0 |
| 上游反向 | `check-upstream-comments.mjs d:\code\ZCode … HEAD` | missing **0**（upstreamComments 13） |

## 6. 清理与记账

1. **注水清零**：共 3 行告警，全部原位置改写，不增删行：
   - b2 后第 67 行 `W`（「空密码与零提问同处理」无标识符）→ 改为「空 password 与 prompts.length===0 同处理」。
   - b3 后第 46 行 `W`（「口令原样透传」）→ 前置 `passphrase` 标识符。
   - b3 后第 58 行 `W`（「连续 3 次无响应」）→ 改为 `keepaliveCountMax 为 3`。
   - 末轮 `waterLines=0`、`weakRate=0`。
2. **漏锚与补救（必须记）**：b2 的锚点表漏了 `_instructions` 形参，导致首轮末覆盖停在 57/58。发现后按「补 1 行」新建 b5，锚点取当前文件行号（87），不影响上方已处理区域。**教训：倒序分批只保证行号不漂，不保证锚点齐全；每批落盘后必须看 `UNCOVERED units` 是否按预期下降，而不是只看 covered 增加。**
3. **行号策略**：从尾（第 116 行）向头（第 4 行）倒序，b1–b4 依次覆盖 113–116、55–79、26–56、4–23，b5 单点补 87。
4. **§2.6 归属判据**：上游 13 行未碰（`missing=0`）。
5. **双写规避**：`buildSSHConnectConfig` 上方已有三段「为什么这样配」的块注释，本批按单元补的是字段默认值与失败后果，未复述块注释原话。
6. **未做**：只做 TS 解析级语法校验（`syntaxErrorFiles=0`），**未跑** `tsc --noEmit` 与单元测试。

## 7. 遗留

- 批次目录 `SSHAUTH-deep-b01/` 保留 `_uncovered.txt`（末轮为空）、`_quality.json`、`orig/` 与 b1–b5 锚点 JSON。
- 下一个 A 组文件：`create-backend.ts`（23/23）。C 组判据定稿前不动。
