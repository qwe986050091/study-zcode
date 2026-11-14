// gen-ui-fixture/main.ts —— Gen UI 桌面端 E2E 驱动入口；只编排，不实现 Gen UI 业务。
//
// 职责边界：本文件负责拉起 Electron、装配插件沙箱宿主、把 Gen UI 服务挂到 IPC、
// 按 host.html 与 react.html 两段剧本驱动 UI 并断言结果；不持有 Gen UI 状态、不写生产数据、
// 不定义组件契约。调用方只有 desktop 的 gen-ui E2E 启动器，入参仅 argv[2]（夹具根目录）。
//
// 参数与输出：argv[2] 必填且应为绝对临时目录；脚本据此派生 profile（userData）、
// state / remote-state（服务状态根）以及 user-data/visualizations 与 remote-user-data/visualizations
// 两套产物根（由 output-files.ts 创建）。清理归启动器，本脚本只读现场、不递归删除。
//
// INV 表（每条不变量对应一处守卫，挪走或放宽守卫即故障）：
// INV-01 断言：argv[2] 缺失时立即失败，不得把未定义值传给 app.setPath —— 守住它的位置：文件顶部 root 取值处 —— 改错故障：userData 落到进程 cwd，污染工作树且并发运行互相踩。
// INV-02 断言：userData 必须钉在 join(root,「profile」) —— 守住它的位置：app.setPath 调用 —— 改错故障：Chromium 缓存写进仓库，重启读出旧 Service Worker 造成假绿。
// INV-03 断言：离线检查在 app ready 之前安装 —— 守住它的位置：installOfflineChecks() —— 改错故障：首屏请求真实出网，离线与隔离断言失真。
// INV-04 断言：特权 scheme 在 ready 前注册 —— 守住它的位置：registerSchemesAsPrivileged —— 改错故障：ready 后注册抛错，instance 页无法加载。
// INV-05 断言：window-all-closed 不得退出进程 —— 守住它的位置：空实现的 window-all-closed 监听 —— 改错故障：弹窗崩溃即退出，catch 里的 failure.png 与几何现场全部丢失。
// INV-06 断言：45 秒看门狗必须在成功退出前清除 —— 守住它的位置：收尾处 clearTimeout —— 改错故障：成功路径被补一刀 exit(1)，退出码随机器快慢抖动。
// INV-07 断言：沙箱准入失败必须阻断挂载 —— 守住它的位置：will-attach-webview 里的 preventDefault —— 改错故障：未加固 guest 仍挂载，隔离断言在裸页面上空转。
// INV-08 断言：pending 按 attach 顺序 FIFO 消费 —— 守住它的位置：did-attach 里的 shift —— 改错故障：并发挂载串号，guest 拿到别人的 sandboxId。
// INV-09 断言：本地与远端产物根必须是两个目录 —— 守住它的位置：prepareOutputFiles 的返回结构 —— 改错故障：远端读取被本地目录兜住，越权断言形同虚设。
// INV-10 断言：guest 内不得存在 window.require 与 window.openai —— 守住它的位置：两处 typeof 断言 —— 改错故障：preload 泄漏 node 能力，沙箱白盒隔离整体失效。
// INV-11 断言：切页与恢复不得重建 guest —— 守住它的位置：切换后比对 currentGuest 的 id —— 改错故障：每次切换重挂 webview，状态与生命周期断言全部失真。
// INV-12 断言：程序化 follow-up 必须走确认弹窗 —— 守住它的位置：fixture-gesture 恒 false —— 改错故障：确认链路被旁路，安全边界没被测到。
// INV-13 断言：产物被外部改写后 restore 必须读到新内容 —— 守住它的位置：写盘后再 restore 的标题断言 —— 改错故障：读到缓存旧 HTML，重放语义退化。
// INV-14 断言：失败也必须留证据 —— 守住它的位置：catch 里的 failure.png 与几何 JSON —— 改错故障：CI 只见非零码，无现场可查。
//
// 阅读顺序：先按 INV 表找守卫，再看各块 [失败路径] 分支；catch 是全文件唯一收尾路径。
// 反模式：为让断言通过而放宽匹配、给时间与随机留空、失败时顺手清理残留——
// 三者都会把夹具从“证明产品正确”退化成“证明夹具自洽”。
//
import { checkLoading } from "./preview-corner-checks.js";
import { app, BrowserWindow, ipcMain, protocol, webContents } from "electron";
import {
  checkCapture,
  checkStaleCapture,
  checkInlineLayout,
  checkCopyButton,
} from "./presentation-checks.js";
import { checkStandalone } from "./standalone-checks.js";
import { checkExternalLinks } from "./external-links-checks.js";
import { checkFileSummary } from "./file-summary-checks.js";
import {
  checkRuntimeWidgets,
  checkCalendarAndCarousel,
  checkTweakLifecycle,
} from "./runtime-checks.js";
import { checkInheritedOutput, checkRemoteOutput, prepareOutputFiles } from "./output-files.js";
import { installOfflineChecks } from "./offline-checks.js";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
import { createGenUiService } from "../../../services/src/gen-ui/node.js";
// [契约] 唯一入参是 argv[2] 夹具根目录；本文件不解析任何命令行开关，也不提供默认值。
// 缺失时该位置为未定义，非空断言会在设置 userData 处抛类型错误，脚本以未捕获异常退出。
// 这是有意的快速失败：宁可在入口炸掉，也不要把 profile 写进进程 cwd 再跑出一堆假绿。
// 后续路径全部由 join(root, ...) 派生：profile、state、remote-state 以及两套 visualizations 产物根。
// 因此调用方必须传绝对临时目录；传仓库内路径会把 userData 与产物一起写进工作树。
const root = process.argv[2]!;
// [资源] userData 钉死在 root/profile，让 Chromium 缓存、Service Worker、本地存储都落在夹具目录内。
// 启动器在拉起本脚本前清空该目录；本脚本不删、不清理 profile，避免把上一轮残留误当成本轮现场。
// 若与产物根 root/user-data 混用，清理产物时会连带删掉 Chromium 正在写的文件。
// 同机并行跑两份夹具时 root 必须不同，否则两个 Electron 进程争用同一 profile 锁。
// 失败时 profile 保留，配合 failure.png 一起复盘，不要顺手删掉。
app.setPath("userData", join(root, "profile"));
// [契约] 离线检查必须在 app ready 之前安装，早于任何 loadFile 与 webview 挂载。
// 它替换的是进程级网络出口；装晚了首屏请求已真实发出，之后的断言只是补录。
// 返回的 offline 句柄在收尾处 assertNoNetwork 复核；两处必须成对出现，缺一即静默失效。
// [失败路径] 若中间提前成功退出，assertNoNetwork 永不执行，离线保证会凭空消失。
// [契约] 本文件只安装一次；重复安装会叠加拦截层，两次运行的行为不再等价。
const offline = installOfflineChecks();
// [契约] 特权 scheme 只能在 ready 之前注册；这里紧随 userData 设置，位置不能下移。
// ready 之后调用会抛错；注册缺失则 instance 页面加载被浏览器直接拒绝。
// scheme 常量取自 pluginSandbox 公开入口，脚本内不重复字面量，避免协议名漂移。
// [权衡] 该注册是进程全局的，会影响本次运行的所有窗口；夹具进程只服务这一轮 E2E，可接受。
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app.on("web-contents-created", (_, contents) =>
  contents.on("console-message", (event) =>
    process.stderr.write(`[${contents.getType()}] ${event.message}\n`),
  ),
);
// [失败路径] 全局 45 秒看门狗：任何 await 卡死都会以非零码结束，不让 CI 无限挂起。
// 看门狗只兜底不清理：触发时窗口、服务、profile 都保持原状，靠退出进程回收。
// 成功路径必须在成功退出之前 clearTimeout，否则定时器可能补一刀，把 0 改写成 1。
// [并发] 定时器与主链共享进程，两个 exit 竞争时先到者生效，退出码会随机器速度抖动。
// 调整剧本长度时要同步评估 45_000 是否够用，不要只加断言不加预算。
const deadline = setTimeout(() => {
  process.stderr.write("Gen UI E2E deadline exceeded\n");
  app.exit(1);
}, 45_000);
void app
  .whenReady()
  .then(async () => {
    // [契约] 插件沙箱宿主在此装配：rendererDir 与 aliasDir 都指向 root，preload 用 root/guest.cjs。
    // 这三个路径必须与构建产物布局一致；任一错位，guest 页会空白加载而不报错。
    // 日志只把 warn 转发到 stderr，info 丢弃：避免逐条 info 淹没 E2E 的真实失败信息。
    // 宿主实例只在本进程复用，不落盘、不注册全局单例，进程退出即消失。
    // [失败路径] 装配失败会在就绪链里抛错，最终进入 catch 分支留下 failure.png。
    const sandbox = installPluginSandboxHost({
      rendererDir: root,
      aliasDir: root,
      preloadPath: join(root, "guest.cjs"),
      logger: { info() {}, warn: (...args) => process.stderr.write(JSON.stringify(args) + "\n") },
    });
    // [权衡] 窗口显示为 true 且固定 1100x820：截图断言与锚点几何都依赖这个视口。
    // backgroundThrottling 关闭，防止窗口失焦后动画帧停摆，把 waitHost 拖成超时。
    // webviewTag 必须开启，react.html 剧本强依赖 webview 的挂载与迁移语义。
    // preload 指向 root/preload.cjs，是宿主侧 IPC 通道的唯一来源；漏配则 harnessReady 永不就绪。
    // 远端用例会把窗口改成 390x780 并切移动视图，此处尺寸只代表桌面基线。
    const win = new BrowserWindow({
      show: true,
      width: 1100,
      height: 820,
      webPreferences: {
        preload: join(root, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    // [并发] pending 保存 attach 前签发的 sandboxId，按 attach 顺序供挂载回调取用。
    // [契约] 两个事件由同一主线程串行触发，FIFO 成立；一旦有人插入异步间隔，顺序假设即失效。
    // 空队列上取头会得到未定义，非空断言直接抛错，比静默传错 id 更可取。
    // 本数组不跨窗口共享；将来引入多窗口需改成按宿主 webContents 分桶。
    const pending: string[] = [];
    // [失败路径] 沙箱校验失败时必须阻断挂载，而不是先放行再事后补救。
    // 只有放行的 guest 才写入 pending；被拒的不进队列，避免挂载回调取到错位的 id。
    // configureGuest 同时改写 webPreferences 与 params，并把宿主窗口 id 一起绑定。
    // [契约] 这里的返回值是唯一准入判据，不要在别处再补一层宽松白名单。
    // 把阻断挪进 else 分支，隔离用例就会在未加固的页面上跑成空转。
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = sandbox.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!result.ok) event.preventDefault();
      else pending.push(result.sandboxId);
    });
    win.webContents.on("did-attach-webview", (_, guest) =>
      sandbox.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! }),
    );
    // [资源] prepareOutputFiles 在 root 下准备两套产物：本地 user-data/visualizations 与远端 remote-user-data/visualizations。
    // 两套目录必须不同；若指向同一路径，远端越权读取会被本地目录兜住，跨端断言失去意义。
    // helper 只做建目录与本地 demo.html 的复制，不删除已有文件，也不清理 root 下其它内容。
    // 清理责任在启动器：每轮 E2E 用新的临时 root，而不是让脚本递归删除，避免误删开发者数据。
    // [契约] 之后的配置注入、路径改写与远端读取，都只通过这里返回的 paths 取址。
    const output = await prepareOutputFiles(root);
    // [契约] 本地方案：stateRoot 钉在 root/state，outputRoot 用本地产物根，二者互不嵌套。
    // registerSandbox 把宿主能力注入服务，服务本身不依赖 Electron，保持可单测。
    // 服务实例不跨进程共享；每次运行重新创建，状态目录由本轮 root 决定。
    // [事务] 状态写入与产物写入是两条路径，不得用产物是否存在来推断状态已落盘。
    // 若 stateRoot 误指向产物根，清产物会连带清状态，让恢复类用例假失败。
    const service = createGenUiService({
      stateRoot: join(root, "state"),
      outputRoot: output.outputRoot,
      registerSandbox: async (input) => sandbox.registerFromHost(input),
    });
    // [契约] 远端方案只给状态根与产物根，刻意不注入宿主注册：远端没有本地沙箱。
    // stateRoot 用 root/remote-state，与本地 state 分开，才能断言两端状态互不可见。
    // [资源] 远端产物根与本地分离，保证本地服务读取远端路径时必须越权失败。
    // 两个服务的 dispose 都在收尾显式调用；漏掉会留下监听器，让进程迟迟不退出。
    // [权衡] 这里用同进程模拟双端，牺牲进程隔离换取可观测性，越权边界由路径与状态根兜住。
    const remoteService = createGenUiService({
      stateRoot: join(root, "remote-state"),
      outputRoot: output.remoteOutputRoot,
    });
    ipcMain.handle("fixture-remote-read", (_, input) => remoteService.readDocument(input));
    service.onStateChanged((value) => win.webContents.send("fixture-state", value));
    let latestHandle: any;
    // [契约] 通用反射通道：方法名由渲染层传入，只做类型约束，没有运行时白名单。
    // [权衡] 该通道只在夹具进程注册，不进入生产 IPC 表，放宽校验的代价被限定在 E2E 内。
    // 入参以 never 传入再转未知类型，说明此处不做参数校验，校验责任在具体服务方法。
    // prepareSandbox 的返回值记为 latestHandle，供后续截图断言复用，不参与其它分支。
    // [失败路径] 方法抛错会透传给渲染层，测试侧应在调用处断言被拒，而不是吞掉。
    ipcMain.handle("fixture-service", async (_, method: keyof typeof service, input: never) => {
      const result = await (service[method] as (input: unknown) => unknown)(input);
      if (method === "prepareSandbox") latestHandle = result;
      return result;
    });
    ipcMain.handle("fixture-config", (_, remote = false) => ({
      root: output.workspacePath,
      path: (remote ? output.remotePaths : output.paths).fixture,
      paths: remote ? output.remotePaths : output.paths,
    }));
    // [契约] fixture-gesture 恒返回 false：夹具不提供任何“原生手势已完成”的旁路。
    // 程序化 follow-up 必须走确认弹窗，渲染层拿不到特权真值，无法跳过用户确认。
    // [权衡] 若返回 true，确认链路会被短路，安全边界相关断言全部退化为自证。
    // 保留这条恒 false 的桩比删掉入口更安全：删了会让调用方回退到未定义行为。
    // 改这个返回值等于改产品语义，需要先有对应 spec，不能只为让某个用例通过。
    // No synthetic native gesture: programmatic follow-up must use confirmation.
    ipcMain.handle("fixture-gesture", () => false);
    await win.loadFile(join(root, "host.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    // [契约] guest 的定位方式是类型为 webview 的 webContents，不依赖 DOM 顺序。
    // 实例帧再按 URL 含 /instance/ 过滤，因为一个 guest 可能同时挂宿主框架与实例框架。
    // 断言放在取得之后、使用之前；帧为未定义时立即失败，避免后续求值抛出费解的错。
    // 求值闭包绑定当时的帧；窗口重挂后必须重新取 guest 与 frame，不能复用旧闭包。
    // [并发] 枚举是进程级快照，多 webview 场景下该函数不再唯一，需要按上下文收窄。
    const currentGuest = () =>
      webContents.getAllWebContents().find((contents) => contents.getType() === "webview")!;
    let guest = currentGuest();
    let frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.ok(frame);
    const read = (code: string) => frame.executeJavaScript(code);
    await read(
      "new Promise(resolve => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', resolve, {once:true}) : resolve())",
    );
    await read(
      "new Promise(resolve => globalThis.lucide ? resolve() : document.getElementById('zcode-visualization-lucide').addEventListener('load', resolve, {once:true}))",
    );
    assert.equal(await read("typeof window.openai"), "undefined");
    assert.equal(await read("typeof window.require"), "undefined");
    await read(
      "window.zcode.setWidgetState({modelContent:{count:7},privateContent:{secret:'local'}})",
    );
    for (let i = 0; i < 6; i++)
      await win.webContents.executeJavaScript(`window.switchPage(${i % 2 === 0})`);
    assert.equal(currentGuest().id, guest.id);
    assert.equal(await read("window.starts"), 1);
    assert.equal(await read("window.zcode.widgetState.modelContent.count"), 7);
    assert.equal(
      await read("getComputedStyle(document.querySelector('.card')).borderWidth"),
      "1px",
    );
    win.focus();
    await checkRuntimeWidgets(read);
    await checkCalendarAndCarousel(read);
    await checkTweakLifecycle(read, win);
    await offline.check(read);
    assert.equal(await read("fetch('https://example.invalid').then(()=>false,()=>true)"), true);
    assert.equal(
      await read(
        `new Promise(resolve=>{const listen=event=>{if(event.data?.id==='denied-tool'){window.removeEventListener('message',listen);resolve(event.data.error?.code)}};window.addEventListener('message',listen);window.parent.postMessage({jsonrpc:'2.0',id:'denied-tool',method:'tools/call',params:{name:'anything',arguments:{}}},'*')})`,
      ),
      -32601,
    );

    // [事务] checkCapture 依赖 latestHandle：只有本轮 prepareSandbox 成功才会进入截图断言。
    // 顺序不能颠倒：先准备再截图，句柄代表一次已完成的注册，而不是预测值。
    // 截图文件名由 helper 决定，本文件不直接指定路径，避免与 helper 的约定漂移。
    // [失败路径] 截图断言失败时窗口仍存活，catch 分支可再抓一次 failure.png 作对照。
    // 截图只是证据，通过与否由几何与内容断言决定，不要把它当成唯一产出。
    await checkCapture(win, guest, latestHandle, root);
    await win.webContents.executeJavaScript("window.adjust()");
    await read("new Promise(requestAnimationFrame)");
    assert.equal(await read("document.querySelector('#preview').style.padding"), "35px");
    assert.equal((await win.webContents.executeJavaScript("window.inspect()")).messages.length, 0);
    await read("window.zcode.sendFollowUpMessage({prompt:'Explain count',title:'Demo'})");
    const sent = await win.webContents.executeJavaScript("window.inspect()");
    assert.equal(sent.confirmations, 1);
    assert.equal(sent.messages.length, 1);
    assert.equal(sent.messages[0].source.kind, "genUi");
    await win.webContents.executeJavaScript("window.submit()");
    assert.equal((await win.webContents.executeJavaScript("window.inspect()")).messages.length, 2);
    await win.webContents.executeJavaScript("document.documentElement.classList.add('dark')");
    await read("new Promise(requestAnimationFrame)");
    assert.equal(await read("document.documentElement.dataset.theme"), "dark");
    await writeFile(join(root, "view.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("window.restore()");
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.deepEqual(await read("window.initial"), {
      modelContent: { count: 7 },
      privateContent: { secret: "local" },
    });
    await win.webContents.executeJavaScript("window.unbind()");
    assert.match(
      await read(
        "window.zcode.sendFollowUpMessage({prompt:'stale'}).then(()=>'',error=>String(error))",
      ),
      /read-only|disconnected/,
    );
    // [事务] 读取的是已落盘的本地产物 HTML，用于在磁盘层改写标题。
    // 随后同时改写本地与远端两份产物，确保两个方案的恢复都看到新内容。
    // 改写用字符串替换 Original heading；命中不到时等于原样写回，后续断言会立刻暴露。
    // [契约] 这一步验证的是重新读盘，不是内存缓存更新；实现若改为缓存，此用例应失败。
    // 两次写入都用 await 串行完成，避免恢复与写盘竞争读到半份文件。
    const html = await readFile(output.paths.fixture!, "utf8");
    await writeFile(output.paths.fixture!, html.replace("Original heading", "Updated heading"));
    await writeFile(
      output.remotePaths.fixture,
      html.replace("Original heading", "Updated heading"),
    );
    await win.webContents.executeJavaScript("window.restore()");
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.equal(await read("document.querySelector('h1').textContent"), "Updated heading");
    await checkStaleCapture(win, guest);
    await win.loadFile(join(root, "react.html"));
    // [失败路径] 轮询宿主条件，每帧一次，8 秒后拒绝并把谓词原文带进错误信息。
    // 超时信息包含谓词字符串，失败日志能直接定位是哪一步条件没有满足。
    // [契约] 谓词在页面上下文求值，只能使用宿主页面已有的全局变量，不能注入辅助函数。
    // 超时预算小于全局 45 秒看门狗，保证定位信息先于进程退出输出。
    // 不要用固定等待替代轮询：轮询失败会说话，固定等待只会把偶发问题变成偶发超时。
    const waitHost = async (predicate: string) =>
      win.webContents.executeJavaScript(
        `new Promise((resolve,reject)=>{const end=Date.now()+8000;const tick=()=>{if(${predicate})resolve(true);else if(Date.now()>end)reject(new Error(${JSON.stringify(`React fixture condition timed out: ${predicate}`)}));else requestAnimationFrame(tick)};tick()})`,
      );
    const clickHost = async (text: string) =>
      win.webContents.executeJavaScript(
        `(() => { const button = [...document.querySelectorAll('button')].find(node => (node.textContent === ${JSON.stringify(text)} || node.getAttribute("aria-label") === ${JSON.stringify(text)})); if(!button) throw new Error('button not found'); button.click(); })()`,
      );
    await waitHost(`window.showReply`);
    const streaming = await win.webContents.executeJavaScript("window.inspectReact()");
    assert.equal(streaming.reads, 0);
    assert.equal(streaming.preparations, 0);
    assert.equal(
      await win.webContents.executeJavaScript("document.querySelectorAll('webview').length"),
      0,
    );
    await checkLoading(win, waitHost);
    await waitHost(`document.querySelector('[data-gen-ui-phase="ready"]')`);
    assert.equal(
      await win.webContents.executeJavaScript("document.body.textContent.includes('::visualize')"),
      false,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.body.textContent.includes('Before view') && document.body.textContent.includes('After view')",
      ),
      true,
    );
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    const guestId = guest.id;
    await checkExternalLinks(win, guest, read);
    await checkFileSummary(win, root, waitHost);
    await checkInlineLayout(win, read, root);
    await checkCopyButton(win);
    const inlineHeight = await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=gen-ui-anchor]').style.height",
    );
    await clickHost("Expand");
    await waitHost(`document.querySelector('[role="dialog"]')`);
    await checkCopyButton(win, true);
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('[data-testid=gen-ui-anchor]').style.height",
      ),
      inlineHeight,
    );
    assert.equal(currentGuest().id, guestId);
    assert.ok(
      await win.webContents.executeJavaScript(
        "document.querySelector('[data-sandbox-page-root]:popover-open')",
      ),
    );
    await read(
      "window.modalFollow = window.zcode.sendFollowUpMessage({prompt:'Expanded confirmation'}).then(()=>true,()=>false); 'pending'",
    );
    await waitHost(`document.querySelector('[role="dialog"] textarea')`);
    assert.equal(
      await win.webContents.executeJavaScript(
        "Boolean(document.querySelector('[data-sandbox-page-root]:popover-open'))",
      ),
      false,
    );
    await clickHost("Cancel");
    await waitHost(`document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await clickHost("Collapse");
    await waitHost(`!document.querySelector('[role="dialog"]')`);
    assert.equal(currentGuest().id, guestId);
    await clickHost("Expand");
    await waitHost(`document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await read("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitHost(`!document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await clickHost("Expand");
    await waitHost(`document.querySelector('[data-testid="gen-ui-backdrop"]')`);
    await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=gen-ui-backdrop]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))",
    );
    await waitHost(`!document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await clickHost("Adjust design");
    await waitHost(`document.querySelector('[data-testid="gen-ui-tweaks"] input[type="range"]')`);
    await waitHost(
      `(() => { const anchor=document.querySelector('[data-testid="gen-ui-anchor"]'); const view=document.querySelector('webview'); return anchor && view && Math.abs(anchor.getBoundingClientRect().top-view.getBoundingClientRect().top)<1; })()`,
    );
    await writeFile(join(root, "react-tweaks.png"), (await win.webContents.capturePage()).toPNG());

    await win.webContents.executeJavaScript(`(() => {
      const range = document.querySelector('[data-testid=gen-ui-tweaks] input[type=range]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '21');
      range.dispatchEvent(new Event('input', {bubbles:true}));
      range.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    const waitPreview = (value: string) =>
      read(
        `new Promise(resolve=>{const check=()=>{if(document.querySelector('#preview').style.padding===${JSON.stringify(value)}){observer.disconnect();resolve(true)}};const observer=new MutationObserver(check);observer.observe(document.querySelector('#preview'),{attributes:true});check()})`,
      );
    await waitPreview("21px");
    await clickHost("Preview original");
    await waitPreview("20px");
    await clickHost("Preview original");
    await waitPreview("21px");
    await clickHost("Adjust design");
    await waitHost(`!document.querySelector('[data-testid="gen-ui-tweaks"]')`);
    await clickHost("Adjust design");
    await waitHost(
      `document.querySelector('[data-testid="gen-ui-tweaks"] input[type="range"]')?.value === '21'`,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelectorAll('[data-testid=gen-ui-tweaks] fieldset').length",
      ),
      2,
    );
    await clickHost("Reset");
    await waitPreview("20px");
    await clickHost("Submit design changes");
    await waitHost(`window.inspectReact().messages.length === 1`);
    await read(
      "window.followResult=window.zcode.sendFollowUpMessage({prompt:'React confirmation'}).then(()=>true); 'pending'",
    );
    await waitHost(
      `document.querySelector('[role="dialog"] textarea')?.value === "React confirmation"`,
    );
    await clickHost("Send");
    assert.equal(await read("window.followResult"), true);
    const actual = await win.webContents.executeJavaScript("window.inspectReact()");
    assert.equal(actual.reads, 1);
    assert.equal(actual.preparations, 1);
    assert.equal(actual.messages.length, 2);
    assert.equal(actual.ports, 1);
    assert.equal(actual.states, 1);
    await read(
      "window.staleResult=window.zcode.sendFollowUpMessage({prompt:'stale confirmation'}).then(()=>'',error=>String(error)); 'pending'",
    );
    await waitHost(
      `document.querySelector('[role="dialog"] textarea')?.value === "stale confirmation"`,
    );
    await win.webContents.executeJavaScript("window.disableSession()");
    await clickHost("Send");
    assert.match(await read("window.staleResult"), /binding changed/);
    assert.equal(
      (await win.webContents.executeJavaScript("window.inspectReact()")).messages.length,
      2,
    );
    await writeFile(join(root, "react-view.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("window.showReply('hidden')");
    await waitHost(`document.querySelector('[data-sandbox-page-parking] webview')`);
    assert.equal(currentGuest().id, guestId);
    await win.webContents.executeJavaScript("window.showReply('complete')");
    await waitHost(`document.querySelector('[data-gen-ui-phase="ready"]')`);
    assert.equal(
      await win.webContents.executeJavaScript("document.querySelectorAll('webview').length"),
      1,
    );
    assert.equal((await win.webContents.executeJavaScript("window.inspectReact()")).reads, 1);
    assert.equal(
      (await win.webContents.executeJavaScript("window.inspectReact()")).preparations,
      1,
    );
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.equal(await read("document.querySelector('h1').textContent"), "Updated heading");
    await writeFile(
      join(root, "react-replayed.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    assert.equal(currentGuest().id, guestId);
    assert.equal(await read("window.starts"), 1);
    await win.webContents.executeJavaScript("window.showTask('second-task')");
    await waitHost(
      `document.querySelector('[data-gen-ui-phase="ready"]') && window.inspectReact().preparations === 2`,
    );
    await checkInheritedOutput(win);
    assert.equal(
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").length,
      2,
    );
    await win.webContents.executeJavaScript("window.showTask('fixture')");
    await waitHost(`document.querySelector('[data-gen-ui-phase="ready"]')`);
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('[data-testid=gen-ui-anchor] webview').getWebContentsId()",
      ),
      guestId,
    );
    assert.equal((await win.webContents.executeJavaScript("window.inspectReact()")).reads, 2);
    await win.webContents.executeJavaScript(
      "document.querySelector('#gen-ui-scroll').scrollTop=800",
    );
    await win.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await win.webContents.executeJavaScript("window.expireOffscreen()");
    await waitHost(`!document.querySelector('webview')`);
    await win.webContents.executeJavaScript("document.querySelector('#gen-ui-scroll').scrollTop=0");
    await waitHost(
      `document.querySelector('[data-gen-ui-phase="ready"]') && window.inspectReact().preparations === 3`,
    );
    assert.notEqual(
      await win.webContents.executeJavaScript(
        "document.querySelector('webview').getWebContentsId()",
      ),
      guestId,
    );
    await win.webContents.executeJavaScript(
      "window.showReply('hidden'); window.deleteTask('fixture'); window.deleteTask('second-task')",
    );
    await waitHost(
      `window.inspectReact().ports === 0 && window.inspectReact().states === 0 && !document.querySelector('webview')`,
    );
    // [资源] 远端用例在收尾前执行：先断言本地服务读远端路径必须被拒，再验证远端可读。
    // 两端目录不同是这条断言成立的前提，路径一旦重合就退化为同目录自读。
    // 用例会临时把窗口改成 390x780 并切移动视图，之后不恢复，属于本剧本末尾的有意副作用。
    // [事务] 远端写入的状态不应出现在本地服务视图；两端状态根分离保证了这一点。
    // 失败时窗口仍在，catch 里的 failure.png 记录的是移动视口，读图时需注意。
    await checkRemoteOutput(win, service, remoteService, output, root, waitHost);
    remoteService.dispose();
    service.dispose();
    win.destroy();
    await checkStandalone(root);
    offline.assertNoNetwork();
    clearTimeout(deadline);
    process.stdout.write(
      "Gen UI Electron E2E passed: isolation, state, anchors, external links, styles, tooltip, tabs, icons, calendar, carousel, Tweak lifecycle, follow-up, theme, replay, reload, standalone and historical remount\n",
    );
    app.exit(0);
  })
  // [失败路径] 唯一收尾：把错误栈写到 stderr，尽力截 failure.png，再输出锚点与 webview 几何。
  // [资源] 失败现场只读不写：除了一张截图与一次几何打印，不删除 root 下任何文件。
  // 半成品处理原则：保留半成品供复盘，由启动器用新 root 隔离下一轮，而不是在脚本里清理。
  // 没有窗口时不截图，仍以非零码退出；保证 CI 拿到失败信号，不出现无现场即通过。
  // [失败路径] catch 块必须接住就绪链抛出的任何异常：内部只写 stderr 并截 failure.png 然后 app.exit(1)，不得再抛新错覆盖原始栈。
  .catch(async (error) => {
    process.stderr.write(String(error.stack ?? error));
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      await writeFile(join(root, "failure.png"), (await win.webContents.capturePage()).toPNG());
      process.stderr.write(
        await win.webContents.executeJavaScript(
          `JSON.stringify({scrollY, anchors:[...document.querySelectorAll('[data-testid="gen-ui-anchor"]')].map(node=>node.getBoundingClientRect().toJSON()), views:[...document.querySelectorAll('webview')].map(node=>({rect:node.getBoundingClientRect().toJSON(),style:node.getAttribute('style')}))})`,
        ),
      );
    }
    app.exit(1);
  });
