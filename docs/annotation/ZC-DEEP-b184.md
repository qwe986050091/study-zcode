# ZC-DEEP-B184（4 文件，+139 行）

> 范围：进程 Provider Registry 装配、MCP UI 应用工具注册表、协议存储启动、内置搜索前缀（合计 867 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b184\orig`；清单：`ZC-deep-b184-files.txt`。
> 目标密度 31.4%，实际落点 31.16%~31.65%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts: 5 blocks, 35 lines
[ok] apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appTools.ts: 5 blocks, 36 lines
[ok] apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts: 5 blocks, 34 lines
[ok] apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts: 5 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=139
TOTAL added=139 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.36% code=220 comment=69 apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts
31.39% code=309 comment=97 apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appTools.ts
31.65% code=139 comment=44 apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts
31.16% code=199 comment=62 apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../bootstrap/src/app/process-provider-registry-runtime.ts` | 进程 Provider Registry 装配 | 路径缺失即抛、装配顺序即契约、独立态才建凭据、快照解析本轮捕获、失败逆序释放 | 35 |
| `.../bootstrap/src/zcode-protocol/mcp-ui/appTools.ts` | MCP UI 应用工具注册表 | 新代际替换旧代际、同服务只暴露最新、两段计时、认领幂等、失败路径统一结算 | 36 |
| `.../bootstrap/src/zcode-protocol/storage-startup.ts` | 协议存储启动 | 启动标识唯一、数据库只存哈希、失败帧只补一次、握手先发后等、清理不掩盖原错 | 34 |
| `.../adapters/src/exec/embedded-search-prelude.ts` | 内置搜索 Bash 前缀 | 非内置不注入、非函数方言不注入、Git Bash 保留 find、后端缺失退回系统命令、rg 仅缺失时定义 | 34 |

## 3. 说明

- `process-provider-registry-runtime.ts` 首行 `import {` 与后续多处重复，header 用 `firstNth: 1`；块落在选项接口、装配主体、注册表构造与信封解析前。
- `appTools.ts` 的块落在宿主接口、注册表类、`register` 与 `claim` 前；`resolve`、`execute`、`sync` 的既有长注释保持原样。
- `storage-startup.ts` 的块落在打开函数、上报函数、准备函数与确认承诺前；三处「传输已断开」空捕获原样保留。
- `embedded-search-prelude.ts` 首行与第 7 行同为横幅，header 用 `firstNth: 1`；块落在两个导出入口、find shim 与函数工厂前。
- 本批四份 check 一次通过，无锚点失败。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1986 needLines=30105 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1982 needLines=25513
```

累计 1,242 文件 / 122,673 行。
