# ZC-DEEP-B162（4 文件，+147 行）

> 范围：工作流脚本子进程宿主、OAuth 登录主流程、/login 选择器与 slash 命令类型（合计 697 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b162\orig`；清单：`ZC-deep-b162-files.txt`。
> 目标密度 31.4%，实际落点 31.13%~31.43%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/bootstrap/src/auth-login.ts: 5 blocks, 38 lines
[ok] apps/zcode-cli/packages/cli/src/command-center/login-flow.ts: 4 blocks, 36 lines
[ok] apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=147
TOTAL added=147 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.21% code=173 comment=54 apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts
31.43% code=245 comment=77 apps/zcode-cli/packages/bootstrap/src/auth-login.ts
31.13% code=151 comment=47 apps/zcode-cli/packages/cli/src/command-center/login-flow.ts
31.25% code=128 comment=40 apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts` | 在独立 Node 子进程中执行工作流脚本 | argv 载荷编码、cwd 语义、标准错误截尾、JSONL 分发、取消优先于退出码 | 37 |
| `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` | OAuth 轮询登录、BigModel 入口与手填密钥 | 超时与取消合并、服务端过期收紧、逐步复查取消、两类写失败归因、依赖注入 | 38 |
| `apps/zcode-cli/packages/cli/src/command-center/login-flow.ts` | /login 选择器与结果/参数格式化 | 四入口成对、密钥掩码、待定态文案、显示名回退链、浏览器失败只提示 | 36 |
| `apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts` | slash 命令解析结果的判别联合 | 两个判别值、命令名唯一分发、技能分支双字段、未知分支不带参数 | 36 |

## 3. 说明

- `script-workflow-process.ts` 的注释只落在接口与函数签名之前，未进入 spawn 选项对象与 Promise 执行器内部。
- `auth-login.ts` 首行为既有模块注释，文件头插在其上方；三个块均锚定局部常量或函数签名。
- `login-flow.ts` 的注释只落在导出函数签名前，未插入 items 数组元素内部，避免打断对象字面量。
- `slash-command-types.ts` 的两个块位于联合成员的类型字面量内，仅新增注释行，不改变成员集合。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2074 needLines=33067 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2070 needLines=28475
```

累计 1,154 文件 / 119,522 行。
