// 重建 B22 desktopMainIpcRemote 的 spec：补 27 行头注（职责边界 + 18 条 INV），
// 同时剔除 19 条低信息量正文注释，使总密度落在 31%~33%。
import fs from 'node:fs';

const target = 'packages/desktop/src/main/desktopMainIpcRemote.ts';
const merged = JSON.parse(fs.readFileSync('D:/code/_annot_baseline/spec-b22-b4-merged.json', 'utf8'));
const body = merged.files[0].items;

const drop = new Set([
  'result: "success",',
  'requestId,',
  'sessionId,',
  'code: normalizedError.code,',
  'stack: error instanceof Error ? error.stack : undefined,',
  'message: normalizedError.message,',
  'formatZodError(result.error),',
  'normalizeUnknownError(error).message,',
  'finalArmsCustomEventE2E.clear();',
  'return { success: true, result };',
  'const { url } = request;',
  'const request = parseOpenExternalRequest(payload);',
  'options.logger.warn("[is-docker-available] detect failed:", error);',
  'const win = BrowserWindow.fromWebContents(event.sender);',
  'remoteUsageTelemetryEligible: true,',
  '...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),',
  'if (!sourceServerId) throw new Error("sourceServerId is required");',
  'options.logger.warn("[oauth-register-state] invalid payload", payload);',
  'options.logger.warn("[open-external] 外部 URL 打开失败", {',
]);

const kept = body.filter((it) => !(it.raw ? false : drop.has(String(it.anchor).trim())));
const dropped = body.length - kept.length;
const keptLines = kept.reduce((n, it) => n + (it.raw ? it.raw.length : it.lines.length), 0);

const header = [
  '// ============================================================================',
  '// desktop/main/desktopMainIpcRemote.ts —— 主进程远程连接与平台 IPC 注册',
  '// ============================================================================',
  '//',
  '// 职责边界：本文件只注册主进程 IPC handler —— 远程连接、OAuth 回调、遥测与通知，',
  '// 把渲染进程请求转成窗口级 Host 调用；不做连接状态机（在 window host 与',
  '// connection registry），不持有会话事实，不渲染 UI。',
  '//',
  '// 不变量（INV）表：断言 —— 守住它的位置 —— 改错后的故障',
  '// INV-01 所有通道只在 registerRemoteIpcHandlers 一处注册 —— 该函数体 —— 改错：重复注册导致同一请求被处理两次。',
  '// INV-02 openExternal 必须先过协议白名单再交给 shell —— isAllowedExternalOpenUrl —— 改错：任意协议（含自定义 scheme）被系统处理器执行。',
  '// INV-03 内嵌导航的信任集是「受信 origin + coding-plan 路径 + embedded=app」三者同时成立 —— isCodingPlanWebviewUrl —— 改错：缺一项即可被外部页面套壳。',
  '// INV-04 PayPal 只允许 https 且 host 在受信集合内 —— isCodingPlanPaypalNavigationUrl —— 改错：明文支付上下文或仿冒域名被当作内嵌页。',
  '// INV-05 支付回调必须同源且 returnTo 仍解析为合法 webview —— isCodingPlanPaymentCallbackUrl —— 改错：开放重定向把回调引到任意外站。',
  '// INV-06 非内嵌目标一律走系统浏览器 —— shouldKeepCodingPlanOpenExternalInWebview —— 改错：普通外链被困在应用内，用户无法回到原页面。',
  '// INV-07 file: 协议走默认应用而不是 loadURL —— OpenExternal 分支 —— 改错：本地文件被 webview 加载并执行。',
  '// INV-08 IPC 返回值必须可结构化克隆，失败也返回普通对象 —— toBindIpcFailure —— 改错：抛出后渲染层只拿到泛化错误，拿不到 reasonCode。',
  '// INV-09 只透出公开错误码，retryable 仅在存在公开码时才带 —— isPublicZCodeErrorCode / readRetryable —— 改错：内部错误语义泄露，前端按错码提示。',
  '// INV-10 入站 payload 必须经 schema safeParse，失败不抛到渲染层 —— 各 ipcMain.on/handle 入口 —— 改错：畸形输入打断主进程事件循环。',
  '// INV-11 connect-remote 必须绑定当前 BrowserWindow —— BrowserWindow.fromWebContents 校验 —— 改错：找不到窗口仍继续建 session，泄漏无主连接。',
  '// INV-12 连接失败路径必须先取消窗口内 pending session —— connect-remote catch —— 改错：失败后残留 pending，重试命中死 flight。',
  '// INV-13 bind workspace context 必须校验 remoteSessionId 与非空路径 —— BindRemoteWorkspaceSessionContext —— 改错：空身份绑定到错误 workspace。',
  '// INV-14 dispose 必须带 grace，且与创建使用同一个 sessionId —— DisposeRemoteSession —— 改错：立即销毁正在收尾的会话，产物写一半。',
  '// INV-15 OAuth state 的登记与回调清理必须成对 —— OAuthRegisterState / OAuthCallbackHandled —— 改错：窗口复用后旧 state 仍可被兑换。',
  '// INV-16 窗口 closed 时必须清理该窗口的 OAuth 路由与远程会话 —— browser-window-created 的 closed 监听 —— 改错：关窗后 handler 仍持有已销毁 webContents。',
  '// INV-17 遥测上报失败不得影响主流程 —— reportRemoteUsageEvent / ARMS 上报的 catch —— 改错：遥测异常把成功的连接变成失败。',
  '// INV-18 E2E 遥测桥只在显式开关下生效 —— ConfigureFinalArmsCustomEventsE2E —— 改错：生产环境暴露事件读写通道。',
];

const items = [
  { anchor: 'import { normalizeRemoteConnectionError } from "@zcode/shared";', raw: header },
  ...kept,
];

const out = { files: [{ file: target, items }] };
fs.writeFileSync('D:/code/_annot_baseline/spec-b22-b4-final.json', JSON.stringify(out, null, 2), 'utf8');
console.log(`bodyItems=${kept.length} dropped=${dropped} bodyLines=${keptLines} header=${header.length} total=${keptLines + header.length}`);
