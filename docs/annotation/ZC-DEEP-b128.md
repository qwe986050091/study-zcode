# ZC-DEEP-B128（4 文件，+173 行）

> 范围：Gen UI 夹具渲染器、设置服务 hook、会话库迁移执行器与 TUI 提问状态机。
> 快照：`d:\code\_annot_baseline\ZC-deep-b128\orig`；清单：`ZC-deep-b128-files.txt`。
> 目标密度 31.4%，实际落点 31.32%~31.64%。

## 1. 验收输出

```text
[ok] packages/desktop/scripts/gen-ui-fixture/renderer.ts: 5 blocks, 42 lines
[ok] packages/ui/src/hooks/useSettingService.ts: 5 blocks, 42 lines
[ok] apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts: 5 blocks, 44 lines
[ok] apps/zcode-cli/packages/tui/src/app-question-state.ts: 5 blocks, 45 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=173
TOTAL added=173 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.58% code=133 comment=42 packages/desktop/scripts/gen-ui-fixture/renderer.ts
31.64% code=177 comment=56 packages/ui/src/hooks/useSettingService.ts
31.32% code=281 comment=88 apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts
31.52% code=330 comment=104 apps/zcode-cli/packages/tui/src/app-question-state.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/scripts/gen-ui-fixture/renderer.ts` | Gen UI 桌面夹具的页面引导与测试接口 | 消息桥代理、就绪判定、容器绑定与销毁顺序 | 42 |
| `packages/ui/src/hooks/useSettingService.ts` | 设置共享快照缓存与跨进程同步 | 缓存键隔离、刷新去重、监听广播与条件更新 | 42 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` | 会话库启动迁移执行与失败归一 | WAL 校验、忙锁退避、单事务与校验和不可变 | 44 |
| `apps/zcode-cli/packages/tui/src/app-question-state.ts` | 交互式提问弹窗的键盘状态机 | 不可变替换、复核分流、其他输入与答案汇总 | 45 |

## 3. 说明

- `migration-runner.ts` 与 `app-question-state.ts` 首行本身是注释，文件头 `//` 块插在其上方。
- `migration-runner.ts` 文件头锚点按 `nth=1` 命中首个块注释，避免与两处 JSDoc 冲突。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
