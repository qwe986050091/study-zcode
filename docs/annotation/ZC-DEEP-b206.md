# ZC-DEEP-B206（4 文件，+123 行）

> 范围：TUI 通用选区键盘分发、Browser 虚拟粘贴页内脚本、Linux AppImage 图标安装、Windows AUMID 图标读取（合计 602 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b206\orig`；清单：`ZC-deep-b206-files.txt`。
> 目标密度 31.4%，实际落点 31.13%~31.63%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/tui/src/app-selection-keyboard.ts: 8 blocks, 33 lines
[ok] packages/desktop/src/main/browserView/browserVirtualClipboardPageScript.ts: 8 blocks, 30 lines
[ok] packages/desktop/src/main/desktopLinuxAppImageIcon.ts: 7 blocks, 30 lines
[ok] packages/desktop/src/main/windowsAumidIcon.ts: 9 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=123
[apps/zcode-cli/packages/tui/src/app-selection-keyboard.ts] added=33 nonComment=0 starSlash=0 suspicious=0
[packages/desktop/src/main/browserView/browserVirtualClipboardPageScript.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/desktop/src/main/desktopLinuxAppImageIcon.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/desktop/src/main/windowsAumidIcon.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=123 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.13% code=106 comment=33 packages/desktop/src/main/windowsAumidIcon.ts
31.38% code=290 comment=91 apps/zcode-cli/packages/tui/src/app-selection-keyboard.ts
31.48% code=108 comment=34 packages/desktop/src/main/desktopLinuxAppImageIcon.ts
31.63% code=98 comment=31 packages/desktop/src/main/browserView/browserVirtualClipboardPageScript.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `tui/src/app-selection-keyboard.ts` | 选区弹层键盘分发 | 三态互斥分发、Escape 分级退出、过滤变更下标归零、clampIndex 唯一入口、不可过滤不消费字符、提交三路径、即发即忘、窗口跟随 | 33 |
| `desktop/.../browserVirtualClipboardPageScript.ts` | 页面侧虚拟粘贴 | 深度活跃元素定位、输入目标令牌校验、原生 paste 优先与取消才回退、只读禁用拒绝、原型 setter、选区替换、input 事件派发 | 30 |
| `desktop/src/main/desktopLinuxAppImageIcon.ts` | AppImage 用户级图标 | 可降级增强、APPIMAGE 双条件、源缺失只告警、固定 hicolor 路径、内容相同不复制、未变更不刷缓存、刷新失败三级告警、命令可注入 | 30 |
| `desktop/src/main/windowsAumidIcon.ts` | AUMID 应用图标 | AUMID 两段式白名单、必须走 Shell 接口、取图标志、GDI 与 COM 必释放、失败返回 null、编码参数防注入、输出 base64 三重校验、超时上限 | 30 |

## 3. 说明

- `app-selection-keyboard.ts` 原 20.00%，块锚定 clampIndex、可见窗口、过滤、可打印字符、遮罩展示、输入态与提交三分支；
  把「过滤串一改就必须把 selectedIndex 归零」和「不可过滤集合不消费字符键」写成不变量，避免后续加功能时只改一处。
- `browserVirtualClipboardPageScript.ts` 原 1.02%，注释全部落在模板字符串内部，因此不含反引号与 `${`，
  避免截断脚本；块锚定 asElement、deepestActiveElement、fallbackPaste、textForMime、令牌校验、DataTransfer 循环与派发返回值。
- `desktopLinuxAppImageIcon.ts` 原 3.70%，块锚定路径解析、内容比较、前置判断、主安装函数、缓存告警与 best-effort 包装；
  强调 `installed=true / changed=false` 是「已就位但无需刷新」，不是失败。
- `windowsAumidIcon.ts` 原 2.83%，块锚定 SAFE_AUMID、Powershell 脚本、GetImage 标志、HRESULT 抛出、依赖接口、默认依赖、AUMID 早退与 data URL 返回；
  C# 段内的 `//` 注释随脚本一起传入，不改变 P/Invoke 行为。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1898 needLines=27402 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1894 needLines=22810
```

累计 1,330 文件 / 125,526 行。
