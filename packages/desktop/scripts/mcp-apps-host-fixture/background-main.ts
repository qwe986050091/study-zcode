// MCP Apps host 背景保活 fixture 入口（Electron main 进程，仅测试用）。
// 做：启动 Electron、注册 privileged scheme、拉起 managed environment，并在多种窗口状态下
//     验证 MCP guest 的存活语义：冷启动、后台隐藏、最小化、过期、删除、同窗多实例。
// 不做：不实现插件沙箱与保活策略本身；本文件只做可见性/帧/状态保留的端到端断言。
// 依赖：managed-environment（Agent 与窗口工厂）、guest-evaluation（跨 frame 求值）、
//       pointer-input（真实坐标点击）、pluginSandbox 的 privileged scheme 常量。
// 边界：断言失败必须让进程以非零码退出；不把失败写成结果 JSON。
// 运行：argv 依次为 root/profile/node/cli，结果写入 background-results.json。
//
// INV-01 断言：guest 注册与「有卡片/订阅」必须解耦 —— 守住它的位置：admission 组的两处 guests.has(false) —— 改错故障：测试会因 UI 恰好有卡片而假通过。
// INV-02 断言：真实 tool 结果也能在没有卡片的窗口里开 guest —— 守住它的位置：model.plans 的 toolName=open_editor —— 改错故障：改用手工 registerFromHost 就不再验证生产链路。
// INV-03 断言：guests.has 在 release 之前必须为 false、之后才为 true —— 守住它的位置：release 前后的两次断言 —— 改错故障：只断言一次会漏掉提前注册的回归。
// INV-04 断言：隐藏窗口的 managedState().visible 必须为 false —— 守住它的位置：admission 与 background 两处 —— 改错故障：改成 true 会让整个后台帧用例失去意义。
// INV-05 断言：隐藏/最小化期间 requestAnimationFrame 必须继续推进 —— 守住它的位置：double-rAF 与 5s 超时 —— 改错故障：缩短超时会把偶发慢帧误判成停帧。
// INV-06 断言：off-screen 过期不得销毁 guest —— 守住它的位置：expireOffscreen 之后的 isDestroyed() —— 改错故障：删掉断言后「过期即回收」的回归无人发现。
// INV-07 断言：未保存文档必须跨过期保留 —— 守住它的位置：unsavedDocument 的 deepEqual —— 改错故障：只断言存活不断言内容，会放过「重建式恢复」。
// INV-08 断言：同一插件实例可并存两份 —— 守住它的位置：admitted 数组与 countGuests()=2 —— 改错故障：把两个 source 串行化会掩盖互相关闭的问题。
// INV-09 断言：第二份实例创建不得关闭第一份 —— 守住它的位置：countGuests 与逐个 isDestroyed —— 改错故障：只数总数会漏掉「新开旧关」。
// INV-10 断言：运行中的 session 不得被回收 —— 守住它的位置：suspendManaged() 必须返回 false —— 改错故障：返回 true 被忽略即保活策略退化。
// INV-11 断言：空闲 MCP 页面也不得自动回收 —— 守住它的位置：stop 之后的 suspendManaged 断言 —— 改错故障：把空闲等同于可回收会静默丢弃用户草稿。
// INV-12 断言：session stop 不得冻结插件内部帧 —— 守住它的位置：backgroundTicks 前后比较 —— 改错故障：用单次 rAF 采样会因节流误判。
// INV-13 断言：隐藏 guest 不得拦截点击 —— 守住它的位置：elementFromPoint 与 inert 断言 —— 改错故障：只看 display 不看 inert 会漏掉可交互性回归。
// INV-14 断言：目标执行不得唤醒同窗空闲 guest —— 守住它的位置：sibling ticks 前后相等 —— 改错故障：去掉该断言后误唤醒回归不可见。
// INV-15 断言：stale initId 必须被拒绝 —— 守住它的位置：setExecutionActive(initId+1) 的 rejects —— 改错故障：放宽为不抛错会让过期句柄仍可写。
// INV-16 断言：其他 window 的句柄必须被拒绝 —— 守住它的位置：foreign window 的 rejects —— 改错故障：跨窗校验失效会破坏 owner 隔离。
// INV-17 断言：下一轮对话必须唤醒同一个 guest —— 守住它的位置：background-reopen 的 guests.get 断言 —— 改错故障：允许重建会让「恢复编辑状态」结论失真。
// INV-18 断言：隐藏页执行后仍返回同一 guest 并展示新图层 —— 守住它的位置：PhotoCraft hidden page 段 —— 改错故障：只断言调用成功不校验内容会放过被丢弃的结果。
// INV-19 断言：删除任务后所有 guest 必须归零 —— 守住它的位置：removeTask 后的 countGuests() —— 改错故障：漏掉该断言会留下泄漏。
// INV-20 断言：失败必须以非零码退出且错误写 stderr —— 守住它的位置：末尾的 .catch —— 改错故障：改成 exit(0) 会让 CI 永远绿。
//
// 阅读顺序：先看 admission 组（tool 结果 → guest 注册），再看 cold/minimized 组，最后看
// background-workspace 段的保活与释放；PhotoCraft 段是可选的第二组真实插件验证。
// 常见误改：把 assert 换成 log、把 release 提前、缩短 rAF 超时、删除 countGuests 断言、
// 用 registerFromHost 手工建 guest 代替真实 tool 链路。每一处都会让回归悄悄消失。
// 时序注意：rAF 轮询用 double-requestAnimationFrame，单帧可能被合成器合并。
// 时序注意：guest 帧加载先 check 一次再监听 did-frame-finish-load，避免错过已触发事件。
// 状态注意：env.guests 是「当前 owner 的 guest 表」，测试中途会被改写，销毁前要核对。
// 平台注意：最小化/恢复在 CI 上可能被窗口管理器降级，超时只兜底、不作为断言。
// 失败诊断：错误走 stderr 加 exit(1)，stdout 只输出 PASS 行，便于日志比对。
// 维护提示：新增场景时同步覆盖两种语义（continuous 实时链路与 replayable 恢复链路）。
import { app, protocol, type BrowserWindow, type WebContents } from "electron";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { evaluateGuest } from "./guest-evaluation.js";
import { clickHostPoint } from "./pointer-input.js";

// [契约] argv 顺序固定为 root/profile/node/cli，由 runner 传入，缺一个就会在后续 join 处炸。
// 不要给缺省值：默认路径会让测试静默跑在错误的工作区上。
// profile 是独立 userData 目录，保证 fixture 不污染真实客户端配置。
// root 是本轮临时工作区，所有 session 与截图都落在其下。
// 类型断言只是形状声明，运行期仍需 runner 保证参数个数。
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
if (process.env.ZCODE_FIXTURE_CDP_PORT)
  app.commandLine.appendSwitch("remote-debugging-port", process.env.ZCODE_FIXTURE_CDP_PORT);
// [契约] userData 必须在 ready 之前设置，ready 之后再改会留下半个已初始化的状态。
// 必须在 registerSchemesAsPrivileged 之前完成，scheme 注册会读 userData 下的缓存。
// 不要在测试中途切换 userData：会话与缓存的归属会前后不一致。
// profile 目录由 runner 创建，这里不负责 mkdir。
// 调试端口只在环境变量存在时开启，避免默认暴露 CDP。
app.setPath("userData", profile);
// [契约] privileged scheme 注册必须发生在 app ready 之前，且早于任何窗口创建。
// 常量来自生产 pluginSandbox 入口，不要在 fixture 里重写 scheme 名。
// 漏注册会让 guest 的 fetch/module 加载失败，表现为白屏而不是显式报错。
// 这里只注册不实现 handler，具体协议由 managed environment 接管。
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // [契约] managed environment 是本文件唯一的运行期依赖，窗口、Agent、模型桩都从它来。
    // 创建失败直接抛错，不做降级：fixture 不能用假环境跑，否则结论无效。
    // env 必须在 finally 里关闭，否则 Electron 进程不会退出。
    // 不要在这里并行建窗口：createWindow 内部依赖已完成的 session 注册顺序。
    // [权衡] 把窗口工厂放在 env 上而不是本文件，是为了让同一套断言复用到其他 fixture。
    const env = await managedEnvironment(root, node, cli);
    // [契约] results 只在断言全部通过后写入，异常路径不会落盘。
    // 值类型允许 boolean 与 string（如 frames 的字符串结果），不要统一转成布尔。
    // 写入时机在最后一行，保证「有结果文件」等价于「跑到结尾」。
    // 不要用 results 记录中间态，它是结论而不是日志。
    const results: Record<string, boolean | string> = {};
    try {
      if (!process.env.ZCODE_PHOTOCRAFT_ONLY) {
        // [并发] 两份实例必须并行保留，串行创建会掩盖「新开旧关」的回归。
        // 每项同时保存 win 与 guest：释放时要按窗口销毁并核对 guest 身份。
        // 数组顺序即创建顺序，用于证明第二份没有关闭第一份。
        // 不要在循环里提前释放，释放统一放到 Promise.all 中并行等待。
        // 这里保存的是引用而不是 id：id 相同但对象可能已被替换。
        const admitted: Array<{ win: BrowserWindow; guest: WebContents }> = [];
        // 先打开外壳但没有任何会话卡片/订阅，再让真实模型调用返回 UI 工具结果。
        // [契约] 两个 source 名既是工作区目录名，也是 model plan 的 key 与事件过滤条件。
        // 名字必须唯一：复用会让 events.wait 等待到上一轮的旧事件。
        // 顺序敏感：先建第一份再建第二份，才能验证并存而不是互相覆盖。
        // 循环内不释放，循环外统一释放，这是 INV-08 的实现前提。
        // 新增第三个 source 前先确认 countGuests 的期望值也要同步。
        for (const source of ["admission-first", "admission-second"]) {
          const scope = await env.agent.uiSession(join(root, source), source);
          const win = await env.createWindow(scope, "background-admission");
          const ui = (code: string) => win.webContents.executeJavaScript(code);
          assert.equal(env.guests.has(win.webContents.id), false);
          assert.equal(
            env.events.history.some(
              (e) => e.type === "subscribed" && e.owner === win.webContents.id,
            ),
            false,
          );
          // [契约] delayed=true 让 tool 结果晚于命令返回，才能观察「先有结果、后注册」的时序。
          // toolName 必须与真实插件声明的工具同名，否则走不到生产 UI 工具路径。
          // plan 必须在 sendText 之前入队，否则模型桩可能先回默认响应。
          // 不要改成 delayed=false：会在断言 guests.has(false) 之前就注册。
          // [契约] key 与 source 一致，events.wait 依赖它过滤本轮事件。
          env.model.plans.push({ key: source, delayed: true, toolName: "open_editor" });
          await env.agent.call("v4/command", {
            commandId: randomUUID(),
            clientId: "admission-fixture",
            sessionId: scope.sessionId,
            type: "sendText",
            issuedAt: Date.now(),
            payload: {
              text: "Open fixture editor",
              mode: "yolo",
              modelSelection: env.model.selection,
            },
          });
          // [契约] 等待条件是 source + type=executed + key 三者同时匹配，缺一都会命中别的轮次。
          // 超时由 env 统一控制，这里不额外加 sleep。
          // 事件是「已执行」而不是「已完成」：之后的 release 才是注册时机。
          // 若等待抛超时，说明 model plan 未生效，不要在这里重试掩盖。
          await env.agent.events.wait(
            (e) => e.source === source && e.type === "executed" && e.key === source,
          );
          assert.equal(env.guests.has(win.webContents.id), false);
          // [契约] release 是 guest 注册的触发点，注册发生在 release 之后而不是 tool 执行时。
          // 两个参数分别是 tool 结果的 key 与来源，顺序不能对调。
          // release 前必须已断言 guests.has 为 false，否则观察不到真正的时序。
          // 随后要等待 registered 事件再继续，不能只靠 rAF 轮询。
          // [契约] 释放只影响本轮 tool 结果，不销毁窗口也不停止 session。
          env.agent.release(source, source);
          await env.events.wait((e) => e.type === "registered" && e.owner === win.webContents.id);
          await ui("window.waitManagedPhase('running')");
          await env.evalPage(win, "window.fixtureReady");
          const guest = env.guests.get(win.webContents.id)!;
          assert.equal((await ui("window.managedState()")).visible, false);
          await env.evalPage(
            win,
            "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{window.unsavedDocument={layers:[1,2,3]};resolve(true)})))",
          );
          await ui("window.expireOffscreen()");
          assert.equal(guest.isDestroyed(), false);
          await ui("window.revealBackgroundPage()");
          assert.equal(env.guests.get(win.webContents.id), guest);
          assert.deepEqual(await env.evalPage(win, "window.unsavedDocument"), {
            layers: [1, 2, 3],
          });
          assert.equal(
            env.events.history.filter(
              (e) => e.type === "registered" && e.owner === win.webContents.id,
            ).length,
            1,
          );
          // 保留两份同插件实例，确认第二份创建不会关闭第一份。
          // [契约] 此处 guest 引用取自 env.guests，是后续「同一对象」断言的比较基准。
          // 必须在断言 countGuests 之前 push，保证两份都被登记。
          // 不要在这里顺手释放上个窗口，会在下一轮断言里表现为数量不足。
          // `admitted` 存 `win` / `guest` 引用而非 id，才能识别「销毁后重建」这种假恢复。
          admitted.push({ win, guest });
          process.stdout.write(
            `PASS ${source}: real tool result with no card/subscription, background frames, retention and reveal\n`,
          );
        }
        // [契约] 循环结束后必须恰好两份 guest，多一份或少一份都说明并存语义被破坏。
        // countGuests 统计当前 owner 表，与窗口数不必然相等，不要混用两个计数。
        // 该断言是 INV-09 的前置条件，删除它后续逐个断言就失去基准。
        // 失败时输出的是数字差异，先看是否某一侧被提前 release。
        // 不要在这里先销毁再把数字当结论：销毁后计数恒为 0。
        assert.equal(env.countGuests(), 2);
        // 两个窗口独立释放；并行等待生产 keep-warm 到期，不串行增加测试时限。
        await Promise.all(
          admitted.map(async ({ win, guest }) => {
            assert.equal(guest.isDestroyed(), false);
            assert.deepEqual(await env.evalPage(win, "window.unsavedDocument"), {
              layers: [1, 2, 3],
            });
            await win.webContents.executeJavaScript(
              "window.stopBackgroundReceiver(); window.removeTask()",
            );
            await win.webContents.executeJavaScript("window.waitConnectionsReleased()");
            assert.equal(guest.isDestroyed(), true);
            win.destroy();
          }),
        );
        assert.equal(env.countGuests(), 0);
        results.toolResultAdmissionWithoutCardOrSubscription = true;
        results.independentSessionsRetainedAndReleased = true;

        // [契约] `mode` 的三种取值分别对应纯后台冷启 / 侧栏锚点隐藏 / 最小化冷启，顺序固定。
        // mode 同时用作目录名与 createWindow 的模式，复用会让两次用例互相污染。
        // 顺序无依赖，但每个 mode 内部必须独立完成创建、断言、释放。
        // 新增模式时目录需预先存在，否则 fixtureReady 不会触发。
        // 循环体里不允许 continue 跳过释放，否则下一个 mode 会继承脏状态。
        for (const mode of ["background-cold", "background-hidden", "background-cold-minimized"]) {
          // [契约] 每个 mode 使用独立 workspace 目录，避免 session 文件互相覆盖。
          // 第二个参数是 session 标签，只用于命名，不参与身份判断。
          // session 必须先创建再 createWindow，窗口工厂依赖它注册 owner。
          // [权衡] 用真实 session 而不是 uiSession，是为了覆盖「无 UI 工具结果」的冷启动。
          // 创建失败直接抛错，不要回落到 uiSession：那会改变被测语义。
          const coldScope = await env.agent.session(join(root, mode), "background");
          const cold = await env.createWindow(coldScope, mode);
          const coldUi = (code: string) => cold.webContents.executeJavaScript(code);
          const coldPage = (code: string) => env.evalPage(cold, code);
          await coldPage("window.fixtureReady");
          const guest = env.guests.get(cold.webContents.id)!;
          const dimensions = await coldPage(`new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(new Error('post-handshake frames stopped without a running session')),5000);
            requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve({width:innerWidth,height:innerHeight})}));
          })`);
          // [契约] 隐藏窗口也必须有非零尺寸，否则 WebContents 不会产帧。
          // 尺寸取自 innerWidth/innerHeight，是布局结果而不是窗口 API 的缓存值。
          // 这条断言同时证明「冷启动后 rAF 已跑过至少两帧」。
          // 失败信息写明模式，便于区分是合成器降级还是真的停帧。
          // 不要用 screen 尺寸替代：那只能证明窗口存在，不能证明页面有布局。
          assert.ok(dimensions.width > 0 && dimensions.height > 0, "隐藏冷启动必须有尺寸和帧");
          process.stdout.write(`PASS ${mode}: initialized with nonzero background surface\n`);
          await coldPage(
            "window.unsavedDocument={layers:[1,2,3]}; window.ticks=0; (function tick(){window.ticks++;requestAnimationFrame(tick)})(); true",
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
          const idle = await coldPage("window.ticks");
          await new Promise((resolve) => setTimeout(resolve, 400));
          assert.ok((await coldPage("window.ticks")) > idle, "插件内部工作不能因 session 空闲停帧");
          process.stdout.write(`PASS ${mode}: internal frames continue without session activity\n`);
          if (mode === "background-hidden") {
            await coldUi(`document.querySelector('#sidebar-anchor').style.display='block';
            new Promise(resolve=>{const check=()=>window.managedState().visible?resolve():setTimeout(check,20);check()})`);
            assert.equal(env.guests.get(cold.webContents.id), guest);
          }
          // [契约] minimize 之后必须等到 document.hidden，不能只靠固定 sleep。
          // 等待用 visibilitychange 监听并自解绑，避免重复触发。
          // 恢复时用 restore() 而不是 show()，否则窗口状态不会回到前台。
          // 最小化期间仍要求 double-rAF 完成，这是本组最关键的断言。
          cold.minimize();
          await coldUi(`document.hidden || new Promise(resolve=>document.addEventListener('visibilitychange',function changed(){
          if(document.hidden){document.removeEventListener('visibilitychange',changed);resolve()}
        }))`);
          process.stdout.write(`PASS ${mode}: owner document hidden\n`);
          assert.equal(
            await coldPage(
              "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
            ),
            true,
          );
          process.stdout.write(`PASS ${mode}: minimized execution completed\n`);
          await coldUi("window.expireOffscreen()");
          assert.equal(guest.isDestroyed(), false);
          assert.deepEqual(await coldPage("window.unsavedDocument"), { layers: [1, 2, 3] });
          cold.restore();
          await coldUi("window.removeTask()");
          await coldUi("window.waitConnectionsReleased()");
          assert.equal(guest.isDestroyed(), true);
          cold.destroy();
          process.stdout.write(
            `PASS ${mode}: cold boot, post-handshake frames, minimized execution, retention and deletion\n`,
          );
        }
        const scope = await env.agent.session(join(root, "background-workspace"), "background");
        const win = await env.createWindow(scope, "background");
        const ui = (code: string) => win.webContents.executeJavaScript(code);
        const page = (code: string) => env.evalPage(win, code);
        await page("window.fixtureReady");
        await ui(
          "document.querySelector('#inline-scroll').scrollTop=900; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        assert.equal((await ui("window.managedState()")).visible, false);
        await page(
          "new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('offscreen inline frames stopped')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve(true)}))})",
        );
        await ui(
          "document.querySelector('#inline-scroll').scrollTop=0; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        // [契约] 每个命令都新生成 commandId，复用会被 Agent 当成重复命令丢弃。
        // clientId 固定为 background-fixture，用于区分其他 fixture 的并发连接。
        // sessionId 绑定本次 scope，不要用全局默认 session。
        // issuedAt 取当前时间，顺序判断由 Agent 侧负责。
        // 该 helper 不 await 响应状态，需要确认时另用 notifications.wait。
        const command = (type: string, payload: unknown) =>
          env.agent.call("v4/command", {
            commandId: randomUUID(),
            clientId: "background-fixture",
            sessionId: scope.sessionId,
            type,
            payload,
            issuedAt: Date.now(),
          });
        // [契约] start 会 holdStream=true，让 turn 停在流式阶段以便观察运行中状态。
        // 入队 plan 后才能 sendText，顺序反了会拿到默认桩响应。
        // sendText 的 mode 固定 build，避免 yolo 绕过权限链路。
        // 最后等待 model.requests 命中本 key，确保请求真的发出去了。
        // [契约] start 不做 stop，调用方负责成对关闭，避免把 turn 留在 running。
        const start = async (key: string) => {
          env.model.plans.push({ key, delayed: false, holdStream: true });
          await command("sendText", {
            text: `fixture ${key}`,
            modelSelection: env.model.selection,
            mode: "build",
          });
          await env.model.requests.wait((r) => r.plan?.key === key);
        };
        // [契约] stop 前先记下 notifications 长度，wait 用它作为起始偏移。
        // 等待条件是 turn.terminal + 本 sessionId，不能只匹配 kind。
        // 不匹配 session 会把别的窗口的终止事件当成自己的。
        // stop 之后仍要断言 guest 存活，这是「停止不等于回收」的核心。
        // 若 wait 超时，优先怀疑 holdStream 的 plan 未被消费。
        const stop = async () => {
          const after = env.agent.notifications.history.length;
          await command("stop", {});
          await env.agent.notifications.wait(
            (e) =>
              e.method === "v4/telemetry/event" &&
              e.params.kind === "turn.terminal" &&
              e.params.sessionId === scope.sessionId,
            after,
          );
        };
        // [契约] original 是后续所有「同一 guest」断言的比较基准，不能重新 get 覆盖它。
        // 非空断言是安全的：前面已等到 registered 事件。
        // 不要用 sandboxId 比较替代对象比较：同一 sandbox 可能对应新 WebContents。
        // 该引用在 sibling 场景中会被 env.guests.set 改写，改写后要显式还原。
        // 销毁断言前先判 isDestroyed，避免读已销毁对象的属性抛错。
        const original = env.guests.get(win.webContents.id)!;
        // [契约] handle 携带 sandboxId 与 initId，是授权校验的两个维度。
        // initId+1 用来构造 stale 句柄，验证版本号参与校验而不是只校验 sandboxId。
        // 不要在这里解构后传参：整体传对象才能保证两者同源。
        // foreign 窗口测试复用同一 handle，验证的是 owner 维度而不是句柄维度。
        const handle = env.handles.get(win.webContents.id);
        await assert.rejects(
          ui(
            `window.zcodePluginSandbox.setExecutionActive(${JSON.stringify(handle.sandboxId)}, ${handle.initId + 1}, true)`,
          ),
          /no longer available/,
        );
        const foreign = await env.createWindow(scope, "web");
        await assert.rejects(
          foreign.webContents.executeJavaScript(
            `window.zcodePluginSandbox.setExecutionActive(${JSON.stringify(handle.sandboxId)}, ${handle.initId}, true)`,
          ),
          /no longer available/,
        );
        foreign.destroy();

        // [契约] sibling 是唯一允许手工注册的场景，用来制造同窗空闲 guest。
        // ownerWebContentsId 必须指向同一个窗口，否则测不到「同窗」唤醒。
        // scopeId 取 idle-sibling，避免与真实 task 的 scope 冲突。
        // html 内嵌自增 rAF 计数，是测量「是否被唤醒」的唯一观测量。
        // 手工注册的 guest 只用于负向断言，不参与产品状态同步。
        const siblingHandle = env.native.registerFromHost({
          instance: { ...handle.instance, token: randomUUID() },
          ownerWebContentsId: win.webContents.id,
          sessionId: scope.sessionId,
          pluginId: scope.pluginId,
          serverName: scope.serverName,
          scopeId: "idle-sibling",
          html: "<html><body><script>window.ticks=0;function tick(){window.ticks++;requestAnimationFrame(tick)}tick()</script></body></html>",
        });
        const attached = new Promise<WebContents>((resolve) =>
          win.webContents.once("did-attach-webview", (_event, guest) => resolve(guest)),
        );
        await ui(
          `(() => { const guest = document.createElement('webview'); guest.id='idle-sibling'; guest.src=${JSON.stringify(siblingHandle.shellUrl)}; guest.partition=${JSON.stringify(siblingHandle.partition)}; guest.style.cssText='display:flex;width:200px;height:100px'; document.body.append(guest); })()`,
        );
        const sibling = await attached;
        // [契约] sibling 挂载会覆盖 env.guests 中该窗口的记录，这里必须显式还原。
        // 还原发生在新 guest 的 did-frame-finish-load 之后，顺序反了会读到 stale 记录。
        // 不要依赖 set 的幂等性：覆盖发生在前，还原是独立动作。
        // `env.guests.set` 还原之后，后续同一性断言才成立。
        env.guests.set(win.webContents.id, original);
        await new Promise<void>((resolve) => {
          const check = () => {
            if (!sibling.mainFrame.frames.some((frame) => frame.url.includes("/instance/"))) return;
            sibling.removeListener("did-frame-finish-load", check);
            resolve();
          };
          sibling.on("did-frame-finish-load", check);
          check();
        });
        await evaluateGuest(
          sibling,
          "new Promise(resolve => requestAnimationFrame(() => resolve(window.ticks)))",
        );
        await ui("document.querySelector('#idle-sibling').style.display='none'");
        // 此处测量隐藏 guest 是否跑帧，观察窗口是测试本身的负向断言，不承担产品状态同步。
        await new Promise((resolve) => setTimeout(resolve, 400));
        const siblingBefore = await evaluateGuest(sibling, "window.ticks");
        await start("background-first");
        await ui("window.setAnchors(false, false)");
        assert.equal(await ui("window.suspendManaged()"), false, "运行中的 session 不得回收");
        const frames = await page(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('frames-completed'))))",
        );
        assert.equal(frames, "frames-completed");
        assert.equal(env.guests.get(win.webContents.id), original);
        assert.equal(
          await ui(
            "Boolean(document.elementFromPoint(25,25)?.closest('[data-sandbox-page-root]'))",
          ),
          false,
        );
        const hidden = await ui(
          "({display:getComputedStyle(document.querySelector('[data-sandbox-page-root]')).display,inert:document.querySelector('[data-sandbox-page-root]').inert})",
        );
        assert.equal(hidden.inert, true);
        assert.equal(
          await evaluateGuest(sibling, "window.ticks"),
          siblingBefore,
          "目标执行不能唤醒同窗空闲 guest",
        );
        await ui(
          `window.zcodePluginSandbox.disposeSandbox(${JSON.stringify(siblingHandle.sandboxId)}, ${siblingHandle.initId})`,
        );
        await ui("document.querySelector('#idle-sibling').remove()");
        await writeFile(
          join(root, "background-hidden.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        process.stdout.write(
          "PASS hidden running guest keeps frames and does not intercept clicks\n",
        );
        await page(
          "window.unsavedDocument={name:'retained draft',layers:[1,2,3]}; window.backgroundTicks=0; (function tick(){window.backgroundTicks++;requestAnimationFrame(tick)})(); true",
        );
        await stop();
        const stoppedTicks = await page("window.backgroundTicks");
        await page(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
        );
        assert.ok(
          (await page("window.backgroundTicks")) > stoppedTicks,
          "session 停止不能冻结插件内部工作",
        );
        assert.equal(original.isDestroyed(), false);
        await ui("window.expireOffscreen()");
        assert.equal(await ui("window.suspendManaged()"), false, "空闲 MCP 页面也不得自动回收");
        assert.equal(original.isDestroyed(), false);
        assert.deepEqual(await page("window.unsavedDocument"), {
          name: "retained draft",
          layers: [1, 2, 3],
        });
        process.stdout.write(
          "PASS MCP guest keeps internal frames and retains unsaved state past deadline\n",
        );
        await start("background-expiry");
        await page("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
        await ui("window.expireOffscreen()");
        assert.equal(await ui("window.suspendManaged()"), false);
        await stop();
        assert.equal(await ui("window.suspendManaged()"), false);
        assert.equal(original.isDestroyed(), false);

        // 卡片仍未挂载；下一轮必须唤醒同一 guest，不能靠重建恢复编辑状态。
        await start("background-reopen");
        assert.equal(env.guests.get(win.webContents.id), original);
        assert.equal(env.countGuests(), 1);
        assert.equal(
          await page(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
          ),
          true,
        );
        assert.deepEqual(await page("window.unsavedDocument"), {
          name: "retained draft",
          layers: [1, 2, 3],
        });
        process.stdout.write("PASS next turn wakes the same MCP guest without a mounted card\n");
        await stop();
        await ui("window.removeTask()");
        await ui("window.waitConnectionsReleased()");
        assert.equal(env.countGuests(), 0);
        Object.assign(results, {
          coldBootWithoutAnchor: true,
          retainedHiddenTabBoot: true,
          minimizedVisibleOwner: true,
          coldBootWhileMinimized: true,
          retainedDuringRun: true,
          hiddenFrames: frames,
          independentOfSessionActivity: true,
          retainedAfterIdleDeadline: true,
          unsavedStatePreserved: true,
          idleSiblingPreserved: true,
          staleAndForeignRequestsRejected: true,
          resumedWithoutAnchor: true,
          removed: true,
        });
      }
      if (process.env.ZCODE_PHOTOCRAFT_SERVER) {
        // 仅此隔离 workspace 内的真实插件测试批准工具，仍经过生产 Agent 权限链路。
        env.agent.client.onRequest((request) => {
          if (request.method === "interaction/requestPermission")
            void env.agent.respond(request, "allow");
        });
        const craftScope = await env.agent.uiSession(
          join(root, "photocraft-workspace"),
          "photocraft",
          {
            serverScript: process.env.ZCODE_PHOTOCRAFT_SERVER,
            resourceUri: "ui://photocraft/panel.html",
            surface: "editor",
          },
        );
        const craft = await env.createWindow(craftScope, "background-admission-minimized");
        const craftUi = (code: string) => craft.webContents.executeJavaScript(code);
        const craftPage = (code: string) => env.evalPage(craft, code);
        assert.equal(env.guests.has(craft.webContents.id), false);
        env.model.plans.push({
          key: "photocraft-open",
          delayed: false,
          toolName: "open_editor",
          arguments: {},
        });
        await env.agent.call("v4/command", {
          commandId: randomUUID(),
          clientId: "photocraft-admission",
          sessionId: craftScope.sessionId,
          type: "sendText",
          issuedAt: Date.now(),
          payload: {
            text: "Open the image editor",
            mode: "yolo",
            modelSelection: env.model.selection,
          },
        });
        await env.events.wait((e) => e.type === "registered" && e.owner === craft.webContents.id);
        await craftUi("window.waitManagedPhase('running')");
        const boot = await craftPage(`new Promise((resolve,reject)=>{
          const check=()=>{const state=window.__craftPlugin;
            if(state?.error)reject(new Error(state.error));
            else if(state?.automationReady)resolve(state);
            else setTimeout(check,100);
          };check();
        })`);
        assert.equal(boot.loaded, true);
        process.stdout.write(
          "PASS real PhotoCraft: WASM initialized from a real tool result while minimized, without a card\n",
        );
        const craftGuest = env.guests.get(craft.webContents.id)!;
        const craftHandle = env.handles.get(craft.webContents.id);
        const call = async (toolName: string, args: Record<string, unknown> = {}) => {
          const result = await env.agent.call("mcp/uiCallTool", {
            workspace: craftScope.workspace,
            sessionId: craftScope.sessionId,
            pluginId: craftScope.pluginId,
            serverName: craftScope.serverName,
            instance: craftHandle.instance,
            callId: randomUUID(),
            toolName,
            arguments: args,
          });
          assert.ok(!result.isError, JSON.stringify(result));
          return result;
        };
        await call("doc_new", {
          width: 64,
          height: 48,
          name: "Background retained draft",
          background: "white",
        });
        craft.minimize();
        await call("command_run", { id: "layer.new.layer", params: { name: "Background layer" } });
        const document = await call("doc_inspect");
        assert.match(JSON.stringify(document), /Background layer/);
        process.stdout.write("PASS real PhotoCraft: minimized document and layer operations\n");
        await craftUi("window.expireOffscreen()");
        assert.equal(craftGuest.isDestroyed(), false);
        assert.deepEqual(await call("doc_inspect"), document);
        assert.equal(env.guests.get(craft.webContents.id), craftGuest);
        craft.restore();
        craft.show();
        await craftUi("window.revealBackgroundPage()");
        await craftPage(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
        );
        const canvas = await craftPage(
          "(()=>{const canvas=document.querySelector('#craft-stage canvas');return {width:canvas.width,height:canvas.height}})()",
        );
        assert.ok(canvas.width > 0 && canvas.height > 0);
        assert.equal(env.guests.get(craft.webContents.id), craftGuest);
        const switchMainPage = async () => {
          const point = await craftUi(`(() => {
            const r = document.querySelector('#switch-main-page').getBoundingClientRect();
            return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
          })()`);
          await clickHostPoint(craft, point);
        };
        await switchMainPage();
        const hidden = await craftUi(`(() => {
          const root = document.querySelector('[data-sandbox-page-root]');
          return {visible: window.managedState().visible, inert: root.inert,
            opacity: getComputedStyle(root).opacity, hit: document.elementFromPoint(600, 200)?.tagName};
        })()`);
        assert.equal(hidden.visible, false, JSON.stringify(hidden));
        assert.equal(hidden.inert, true);
        assert.ok(Number(hidden.opacity) <= 0.001);
        assert.notEqual(hidden.hit, "WEBVIEW");
        await writeFile(
          join(root, "photocraft-page-hidden.png"),
          (await craft.webContents.capturePage()).toPNG(),
        );
        // 原始插件不做任何适配：切主页面后仍执行编辑，返回同一 guest 显示新图层。
        await call("command_run", { id: "layer.new.layer", params: { name: "Hidden page layer" } });
        const hiddenDocument = await call("doc_inspect");
        assert.match(JSON.stringify(hiddenDocument), /Hidden page layer/);
        await switchMainPage();
        assert.equal((await craftUi("window.managedState()")).visible, true);
        assert.equal(env.guests.get(craft.webContents.id), craftGuest);
        assert.deepEqual(await call("doc_inspect"), hiddenDocument);
        await craftPage(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        results.photocraftHiddenPageExecution = true;
        await writeFile(
          join(root, "photocraft-restored.png"),
          (await craftGuest.capturePage()).toPNG(),
        );
        process.stdout.write(
          "PASS real PhotoCraft: restored the same guest to a visible canvas; captured photocraft-restored.png\n",
        );
        await craftUi("window.stopBackgroundReceiver(); window.removeTask()");
        await craftUi("window.waitConnectionsReleased()");
        assert.equal(craftGuest.isDestroyed(), true);
        assert.equal(env.countGuests(), 0);
        craft.destroy();
        results.photoCraft = true;
        process.stdout.write(
          "PASS real PhotoCraft: background WASM boot, minimized document/layer operations, retained draft and deletion\n",
        );
      }
      await writeFile(join(root, "background-results.json"), JSON.stringify(results));
      process.stdout.write(
        "PASS MCP page survives idle deadlines, executes in background and releases on deletion\n",
      );
    } finally {
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
