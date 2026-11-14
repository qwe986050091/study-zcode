// chain-main.ts —— MCP Apps Host fixture 的消息链串联脚本（Electron main 进程入口）
// 职责边界：只做「真实 Electron + 真实 Agent + 真实 MCP 子进程」的端到端串联校验，不实现生产逻辑。
//   Host 安装、bridge 服务、guest 求值全部来自生产代码；脚本自身只负责窗口生命周期、身份维度切换与断言收集。
// 输入钉死：argv 依次为 root（fixture 资源目录）、profile（userData）、node、cli；解构顺序即 startAgent 实参顺序。
// 输出钉死：stdout 逐条 PASS；成功写 chain-results.json 并退出 0，失败把栈打到 stderr 并退出 1。
//
// INV 表（任一不变量被破坏，对应断言即失败；动代码前先看这里）
// INV-01 断言：同一逻辑页面并发 prepareSandbox 只产生一次 MCP read 与一次 Main register —— 守住它的位置：fixture-bridge 的 Promise.all 分支与首个 check —— 改错故障：guest 注册两次，分区与 instance token 重复，后续断言全错。
// INV-02 断言：app-only 工具结果不截断，仍为 40000 字符原始文本 —— 守住它的位置：raw check 内 content[0].text.length —— 改错故障：UI 拿到的结果与 MCP 原始返回不一致。
// INV-03 断言：审批通过不产生对话轮次，session 消息数保持 0 —— 守住它的位置：raw check 末尾 session/read 的 messages.length —— 改错故障：审批被误建模成 assistant turn，会话历史被污染。
// INV-04 断言：拒绝审批的调用永不触达 MCP 工具 —— 守住它的位置：denied check 的 error 与 executed 计数为 0 —— 改错故障：拒绝退化为延迟执行，权限闸门失效。
// INV-05 断言：admission 之前与成功之后的取消都不重放调用 —— 守住它的位置：cancellation check 的两次 cancel 与 executed('raw') 计数 —— 改错故障：取消被当成重试信号，副作用重复执行。
// INV-06 断言：SDK 取消必须穿透到真实 MCP 进程，晚到结果被拒绝 —— 守住它的位置：cancelled check 的 executed→cancelled→released 序列 —— 改错故障：只断 UI 不断进程的假取消。
// INV-07 断言：重复 callId 只执行一次，取消幂等 —— 守住它的位置：duplicate check 的两次 cancel 断言 —— 改错故障：第二次 cancel 返回 true，状态机出现二义。
// INV-08 断言：审批挂起期间实例被钉住，晚到审批不能作用于已关闭代际 —— 守住它的位置：late-approval check 的 recycle 返回 false —— 改错故障：旧代际被复活，guest 在已 dispose 的页面上执行。
// INV-09 断言：旧 dispose 到达新登记之后不得拆除替换页面 —— 守住它的位置：harness.dispose(old.sandboxId, old.initId) 之后的新调用 —— 改错故障：迟到的清理关掉刚重建的 guest。
// INV-10 断言：同一 surface 在不同窗口拥有独立 guest 与 widget 快照 —— 守住它的位置：second window check 的 id/token/storage 断言 —— 改错故障：跨窗口串页，widget 数据泄漏。
// INV-11 断言：跨 server 与 workspace 身份时浏览器存储必须隔离 —— 守住它的位置：身份矩阵循环中的 partition 与 storageRoundTrip —— 改错故障：不同工作区共用分区，localStorage 互相可见。
// INV-12 断言：审批期间连接被撤销后，晚到 allow 不得执行 —— 守住它的位置：disconnect check 的 executed 计数为 0 —— 改错故障：断链后仍有副作用落地。
// INV-13 断言：所有窗口关闭后不残留 webview —— 守住它的位置：收尾处 getAllWebContents 过滤计数为 0 —— 改错故障：进程挂住不退出，或下次运行污染计数。
// INV-14 断言：清理与退出路径总会关闭窗口与 agent —— 守住它的位置：try/finally 与 finally 内 closeWindow、agent.close —— 改错故障：断言中途抛错时子进程泄漏，CI 超时。
// INV-15 断言：fixture-config 的 presentation 固定 ui://fixture —— 守住它的位置：fixture-config handler 返回值 —— 改错故障：资源 URI 漂移，bridge 校验失败。
// INV-16 断言：argv 顺序与 startAgent 参数一致 —— 守住它的位置：首行解构与 startAgent 调用 —— 改错故障：跑错目录，profile 被写进源码树。
// INV-17 断言：will-attach 被拒时不得调用 attachGuest —— 守住它的位置：pending 队列与 did-attach 回调 —— 改错故障：未 configure 的 guest 被登记。
//
// 运行前提：无需网络；MCP 子进程由 startAgent 用同一 node/cli 拉起；root 需含 host.html、preload.cjs、guest.cjs。
// 失败即停：任一 assert 抛出即跳过后续用例并走 finally 清理，这是刻意的 fail-fast，不做用例级重试。
// 阅读顺序：初始化 → 主窗口 → 逐条 check → 组合用例 → 断链 → 收尾；check 名即失败定位线索。
//
import { app, BrowserWindow, ipcMain, protocol, webContents, type WebContents } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
import { createPluginUiBridgeService } from "../../../services/src/plugin-ui-bridge/pluginUiBridgeService.js";
import { startAgent } from "./agent.js";
import { checkCombinations } from "./chain-combinations.js";
import { evaluateGuest } from "./guest-evaluation.js";
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
// [资源] userData 钉到 argv[1] 的 profile：分区、Cookie、IndexedDB 全落这里，跑完可整目录丢弃。
// [契约] 必须早于 whenReady 执行，Chromium 一旦绑定默认 userData，分区隔离断言会读到宿主机数据。
// [权衡] 不复用默认 profile 换取可重复性：代价是每片 CI 要独立目录，收益是身份用例之间零串扰。
app.setPath("userData", profile);
// [契约] 特权 scheme 与生产 installPluginSandboxHost 使用同一常量，禁止在 fixture 里另写字符串。
// [契约] 注册必须在 app ready 之前完成，否则 guest 资源走非沙箱路径，后续断言失去意义。
// [失败路径] 漏注册不会立刻报错，而是在 guest 首次取资源时加载失败，排障先看这一行。
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // [资源] agent 先于任何窗口启动：主 scope 与身份矩阵都靠它换 session，事件历史同时是断言数据源。
    // [契约] 实参顺序即 argv 解构顺序（root/node/cli），错位会让 MCP 子进程用错解释器，表现为启动即退出。
    // [失败路径] 启动失败直接抛到顶层 catch，打栈并 exit(1)，不在此处重试。
    const agent = await startAgent(root, node, cli);
    const checks: { name: string; ms: number }[] = [];
    const windows: BrowserWindow[] = [];
    // [契约] guests 以宿主 webContents.id 为键，保证一窗一 guest；同窗口重建页面时值被替换。
    // [资源] 该表只增不删：窗口销毁后仍留旧 WebContents，读取前必须先判 isDestroyed。
    // [契约] handles 与 scopes 同键，三张表共同构成「窗口 → 身份 → 沙箱句柄」的唯一映射。
    const guests = new Map<number, WebContents>();
    const scopes = new Map<number, any>();
    const handles = new Map<number, any>();
    const calls: any[] = [];
    // [契约] Host 走生产安装函数，fixture 只喂目录：rendererDir 与 aliasDir 同为 root，preload 固定 guest.cjs。
    // [权衡] 不在此处手写 protocol 与 attach 逻辑，确保被测对象是真实 Host 而非测试替身。
    // [契约] root 需同时含 host.html、preload.cjs、guest.cjs，缺一会在 loadFile 或 guest 注入阶段失败。
    const host = installPluginSandboxHost({
      rendererDir: root,
      aliasDir: root,
      preloadPath: join(root, "guest.cjs"),
    });
    // [契约] wire 是 bridge 参数到 agent 参数的唯一整形口：剥离 UI 专属字段，补出 workspace 结构。
    // [契约] workspaceKey 必须取 workspaceIdentity?.trim() || workspacePath，与仓库身份规则一致；scopeId 等下划线字段只服务 UI 层，不下传。
    const wire = (params: any) => {
      const {
        workspacePath,
        workspaceIdentity,
        scopeId: _scope,
        resourceUri: _uri,
        ownerWebContentsId: _owner,
        csp: _csp,
        prefersBorder: _border,
        ...rest
      } = params;
      return {
        ...rest,
        workspace: {
          workspacePath,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
      };
    };
    // [契约] bridge 是生产服务，fixture 只注入 RPC 转发：open/validate/close/recycle 各对应一个 mcp 方法。
    // [契约] recycleInstance 用 onlyIfIdle:true 复用 closeInstance 并只取 closed 字段，语义是「空闲才回收」。
    // [契约] 每个转发都先过 wire 再 agent.call，形状偏离生产协议会以 RPC 报错而非断言失败暴露。
    const bridge = createPluginUiBridgeService({
      openInstance: (p) =>
        agent.call("mcp/uiOpenInstance", {
          workspace: wire(p).workspace,
          sessionId: p.sessionId,
          pluginId: p.pluginId,
          serverName: p.serverName,
          resourceUri: p.resourceUri,
          scopeId: p.scopeId,
          ownerWebContentsId: p.ownerWebContentsId,
        }),
      validateInstance: (p) => agent.call("mcp/uiValidateInstance", wire(p)),
      closeInstance: (p) => agent.call("mcp/uiCloseInstance", wire(p)),
      recycleInstance: async (p) =>
        (await agent.call("mcp/uiCloseInstance", { ...wire(p), onlyIfIdle: true })).closed,
      readMcpResource: (p) => agent.call("mcp/readResource", wire(p)),
      callMcpToolForUi: (p) => {
        calls.push(p);
        return agent.call("mcp/uiCallTool", wire(p));
      },
      cancelMcpToolCallForUi: (p) => agent.call("mcp/uiCancelCall", wire(p)),
      readMcpResourceForUi: (p) => agent.call("mcp/uiReadResource", wire(p)),
      listMcpResourcesForUi: (p) => agent.call("mcp/uiListResources", wire(p)),
      // [契约] 这是 Main 侧唯一登记入口：registerFromHost 返回值立刻写入 handles，供按窗口取 instance/sandboxId。
      // [并发] 覆盖写是刻意的，页面重建会替换旧句柄；旧句柄由 late-approval 用例单独持有以验证代际隔离。
      // [失败路径] 登记抛错沿 bridge 调用栈回到页面，fixture 不做补偿，宁可直接失败。
      registerSandbox: async (input) => {
        const handle = host.registerFromHost(input);
        handles.set(input.ownerWebContentsId, handle);
        return handle;
      },
    });
    // [契约] fixture-config 把该窗口 scope 回给页面，供 preload 组装参数；scopes 未命中时非空断言直接抛。
    // [契约] presentation.resourceUri 固定 ui://fixture，只用于通过生产侧校验，不对应真实资源。
    // [契约] scope.kind 固定 surface/same，保证同窗口多次取配置拿到同一逻辑页面身份。
    ipcMain.handle("fixture-config", (event) => {
      const scope = scopes.get(event.sender.id)!;
      return {
        scope: {
          workspacePath: scope.workspace.workspacePath,
          ...(scope.workspace.workspaceIdentity
            ? { workspaceIdentity: scope.workspace.workspaceIdentity }
            : {}),
          sessionId: scope.sessionId,
          scope: { kind: "surface", surfaceId: "same" },
        },
        presentation: {
          pluginId: scope.pluginId,
          serverName: scope.serverName,
          resourceUri: "ui://fixture",
        },
      };
    });
    // [契约] fixture-bridge 是页面唯一 RPC 入口：先按 event.sender.id 取 scope，再逐字段校验 sessionId 与 serverName。
    // [契约] 这两条 assert 是身份串线护栏：跨会话复用会在此同步失败，而不是在后续计数断言里漂移。
    // [失败路径] method 不存在时 typeof 检查抛错；不做静默兜底，避免拼错方法名被当成成功。
    ipcMain.handle("fixture-bridge", async (event, method, params) => {
      const scope = scopes.get(event.sender.id);
      assert.equal(params.sessionId, scope.sessionId);
      assert.equal(params.serverName, scope.serverName);
      if (method === "prepareSandbox") {
        // 同一逻辑页面并发初始化经过生产 bridge，必须只有一次 MCP read 与 Main register。
        // [并发] 两个 prepareSandbox 同时进入真实 bridge，期望内部去重成一次 MCP read 与一次 Main register。
        // [契约] deepEqual(a, b) 断言两次返回同构；若去重退化为后到覆盖，instance token 不同会在此暴露。
        // [并发] 刻意不串行 await，串行会掩盖竞态；同一 params 对象复用也验证 bridge 不修改入参。
        const [a, b] = await Promise.all([
          bridge.prepareSandbox(params),
          bridge.prepareSandbox(params),
        ]);
        assert.deepEqual(a, b);
        return a;
      }
      const fn = (bridge as any)[method];
      assert.equal(typeof fn, "function");
      return fn(params);
    });
    // [资源] 建窗顺序固定：new BrowserWindow → 登记 scope → 挂 will-attach/did-attach → loadFile → 等两个 ready。
    // [契约] show:false 让断言不依赖窗口可见；webviewTag:true 才可能出现 guest 附着路径。
    // [资源] backgroundThrottling:false 防止后台窗口被节流导致 ready 长时间不触发。
    async function createWindow(scope: any) {
      const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 700,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          webviewTag: true,
          backgroundThrottling: false,
        },
      });
      windows.push(win);
      scopes.set(win.webContents.id, scope);
      // [并发] will-attach 与 did-attach 是两次独立回调，sandboxId 通过 pending 队列按序交接。
      // [并发] 不能假设同一时刻只有一个 webview 在附着；队列保证 did-attach 取到的是自己那次 configure 的结果。
      // [契约] 队列只做先进先出，不做去重，重复 configure 留下的多余条目属于应被发现的异常。
      const pending: string[] = [];
      win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
        const result = host.configureGuest({
          webPreferences,
          params,
          ownerWebContentsId: win.webContents.id,
        });
        if (!result.ok) event.preventDefault();
        else pending.push(result.sandboxId);
      });
      // [契约] 附着成功才写 guests 并调用 host.attachGuest，sandboxId 由 pending.shift() 出队。
      // [契约] 这一刻是 guest 可被 evalPage 驱动的唯一时间点，早于此执行页面脚本拿不到 WebContents。
      // [失败路径] will-attach 已 preventDefault 时本回调不触发，因此不会出现 sandboxId 为 undefined 的登记。
      win.webContents.on("did-attach-webview", (_event, guest) => {
        guests.set(win.webContents.id, guest);
        host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! });
      });
      await win.loadFile(join(root, "host.html"));
      // [契约] 两道 ready 闸门：宿主 harnessReady 先于 guest fixtureReady，顺序颠倒说明 preload 未注入。
      // [失败路径] 两个 await 都不设超时，卡住由 CI 超时暴露，不在脚本里加兜底 sleep 掩盖同步问题。
      // [契约] 只有 fixtureReady 之后才返回窗口，调用方拿到的 win 一定处于可 eval 状态。
      await win.webContents.executeJavaScript("window.harnessReady");
      await evaluateGuest(guests.get(win.webContents.id)!, "window.fixtureReady");
      return win;
    }
    // [资源] 关窗前先挂 guest destroyed 监听再 win.destroy()，确保等待发生在销毁之前，避免漏事件后永久挂起。
    // [失败路径] 已销毁窗口直接 return，使 finally 中的重复关闭成为幂等操作。
    // [资源] 用 destroy 而非 close，绕过页面 beforeunload 逻辑，让销毁路径可预测。
    async function closeWindow(win: BrowserWindow) {
      if (win.isDestroyed()) return;
      const guest = guests.get(win.webContents.id);
      const closed =
        guest && !guest.isDestroyed()
          ? new Promise<void>((resolve) => guest.once("destroyed", resolve))
          : Promise.resolve();
      win.destroy();
      await closed;
    }
    const evalPage = (win: BrowserWindow, code: string) =>
      evaluateGuest(guests.get(win.webContents.id)!, code);
    // [契约] check 是用例唯一包壳：计时、push 结果、写 PASS；断言抛错直接上抛，不吞异常。
    // [契约] checks 数组顺序即 chain-results.json 顺序，也是失败时的阅读顺序，具诊断意义。
    // [权衡] 只记耗时不做阈值判定，避免把性能波动写成抖动失败。
    async function check(name: string, run: () => Promise<void>) {
      const start = performance.now();
      await run();
      checks.push({ name, ms: performance.now() - start });
      process.stdout.write(`PASS ${name}\n`);
    }
    const approval = (key: string) =>
      agent.approvals.wait((request) => request.params.input?.key === key);
    const executed = (key: string) =>
      agent.events.history.filter((event) => event.type === "executed" && event.key === key).length;
    const scope = await agent.session(join(root, "workspace-a"), "source-a");
    const win = await createWindow(scope);
    try {
      // [并发] 首个用例回看 prepare 的副作用：source-a 的 read 事件只有 1 条。
      // [并发] 同时断言 webview 类型 WebContents 只有 1 个，证明并发初始化没有挂出第二个 guest。
      await check("concurrent prepare reads once and mounts one guest", async () => {
        assert.equal(
          agent.events.history.filter(
            (event) => event.type === "read" && event.source === "source-a",
          ).length,
          1,
        );
        assert.equal(
          webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
            .length,
          1,
        );
      });
      await check(
        "app-only tool approval and untruncated raw result without conversation turn",
        async () => {
          const result = evalPage(win, "window.callTool('raw')");
          await agent.respond(await approval("raw"), "allow");
          const response = await result;
          // [契约] 40000 是 fixture 侧固定负载长度，减小会掩盖截断回归，须与 guest 脚本生成长度同步。
          // [契约] 同用例还校验 structuredContent 与 _meta 原样透传，且 executed('raw') 恰为 1。
          assert.equal(response.result.content[0].text.length, 40_000);
          assert.deepEqual(response.result.structuredContent, { key: "raw", source: "source-a" });
          assert.deepEqual(response.result._meta, { fixture: true });
          assert.equal(executed("raw"), 1);
          const snapshot = await agent.call("session/read", { sessionId: scope.sessionId });
          assert.equal(snapshot.messages.length, 0);
        },
      );
      await check("denied approval never reaches MCP tool", async () => {
        // [失败路径] 拒绝路径只断言返回 error 且 executed('denied')===0，不锁定错误文案。
        // [契约] 先取 Promise 再用 approval 放行 deny，保证审批与调用落在同一事务窗口内。
        const result = evalPage(win, "window.callTool('denied')");
        await agent.respond(await approval("denied"), "deny");
        assert.ok((await result).error);
        assert.equal(executed("denied"), 0);
      });
      await check(
        "cancellation before admission and after success never replays a call",
        async () => {
          // [契约] binding 复用主 scope 并手工补 instance 与 callId，模拟 SDK 侧已准入与未准入两种时序。
          // [事务] cancel-before-admission 的 callId 从未入队，首次 cancel 必须为 false，随后的调用必须 reject。
          // [事务] 已完成调用还要再进一次 uiCallTool 并期望 reject，证明结果不可重放。
          const instance = handles.get(win.webContents.id).instance;
          const binding = { ...scope, instance, callId: "cancel-before-admission" };
          assert.equal((await agent.call("mcp/uiCancelCall", binding)).cancelled, false);
          await assert.rejects(() =>
            agent.call("mcp/uiCallTool", {
              ...binding,
              toolName: "edit",
              arguments: { key: "before-admission" },
            }),
          );
          assert.equal(executed("before-admission"), 0);
          const completed = calls.find((call) => call.arguments.key === "raw");
          await assert.rejects(() => agent.call("mcp/uiCallTool", wire(completed)));
          const { toolName: _tool, arguments: _args, ...cancel } = completed;
          assert.equal((await bridge.cancelToolCall(cancel)).cancelled, false);
          assert.equal(executed("raw"), 1);
        },
      );
      await check("SDK cancellation reaches real MCP process and rejects late result", async () => {
        // [事务] 取消链顺序固定：executed → cancelTool → cancelled → release → released，每步都 await 事件历史。
        // [并发] 不使用固定延时，慢机器上也不会偶发通过/失败；事件驱动是这里唯一的同步手段。
        // [契约] 最终断言 result.error 存在且 executed('cancelled') 仍为 1，取消不等于回滚执行。
        const result = evalPage(win, "window.callTool('cancelled',true)");
        await agent.respond(await approval("cancelled"), "allow");
        await agent.events.wait((event) => event.type === "executed" && event.key === "cancelled");
        await evalPage(win, "window.cancelTool('cancelled')");
        await agent.events.wait((event) => event.type === "cancelled" && event.key === "cancelled");
        assert.ok((await result).error);
        agent.release("source-a", "cancelled");
        await agent.events.wait((event) => event.type === "released" && event.key === "cancelled");
        assert.equal(executed("cancelled"), 1);
      });
      await check("duplicate callId executes once and cancellation is idempotent", async () => {
        // [事务] 同 callId 第二次 uiCallTool 必须 reject，已完成调用不可重入。
        // [事务] 首次 cancel 返回 true（仍在执行），第二次返回 false（幂等），executed 恒为 1。
        // [契约] 从 calls 反查该 callId 的原始入参构造 cancel，避免手写字段与生产形状不一致。
        const result = evalPage(win, "window.callTool('duplicate',true)");
        await agent.respond(await approval("duplicate"), "allow");
        await agent.events.wait((event) => event.type === "executed" && event.key === "duplicate");
        const binding = calls.find((call) => call.arguments.key === "duplicate");
        await assert.rejects(() => agent.call("mcp/uiCallTool", wire(binding)));
        const { toolName: _tool, arguments: _args, ...cancel } = binding;
        assert.equal((await bridge.cancelToolCall(cancel)).cancelled, true);
        assert.equal((await bridge.cancelToolCall(cancel)).cancelled, false);
        assert.ok((await result).error);
        assert.equal(executed("duplicate"), 1);
      });
      await check(
        "pending approval pins instance and late approval cannot run closed generation",
        async () => {
          // [并发] 页面调用在审批未决时挂起；catch 兜底返回 closed:true，因为重建页面会让旧 Promise 被拒。
          // [事务] dispose 再 restore 制造代际切换，新页面拿到新 token，旧代际的审批结果必须被丢弃。
          // [失败路径] 旧 dispose 按 (sandboxId, initId) 精确匹配后丢弃，不能按窗口 id 一刀切拆掉替换页面。
          const pending = evalPage(win, "window.callTool('late-approval')").catch(() => ({
            closed: true,
          }));
          const request = await approval("late-approval");
          const old = handles.get(win.webContents.id);
          const binding = {
            workspacePath: scope.workspace.workspacePath,
            sessionId: scope.sessionId,
            pluginId: scope.pluginId,
            serverName: scope.serverName,
            instance: old.instance,
          };
          // [事务] 存在未决审批时 recycle 必须返回 false，证明实例被 pin 住、不会被空闲回收。
          // [契约] binding 只带 workspacePath/sessionId/pluginId/serverName/instance，回收语义不依赖 ownerWebContentsId。
          assert.equal(await bridge.recycleInstance(binding), false);
          await win.webContents.executeJavaScript("window.disposePage()");
          await win.webContents.executeJavaScript("window.restorePage(false)");
          await evalPage(win, "window.fixtureReady");
          assert.notEqual(handles.get(win.webContents.id).instance.token, old.instance.token);
          await agent.respond(request, "allow");
          await pending;
          assert.equal(executed("late-approval"), 0);
          // 旧 dispose 到达新登记之后，也不能拆掉替换页面。
          await win.webContents.executeJavaScript(
            `window.harness.dispose(${JSON.stringify(old.sandboxId)},${old.initId})`,
          );
          const result = evalPage(win, "window.callTool('new-approval')");
          await agent.respond(await approval("new-approval"), "deny");
          assert.ok((await result).error);
          assert.equal(executed("new-approval"), 0);
          assert.ok(!guests.get(win.webContents.id)!.isDestroyed());
        },
      );
      await check(
        "same surface in different windows keeps independent guest and widget snapshot",
        async () => {
          // [契约] 第二个窗口共用同一 scope（同 surface），但必须拥有独立 guest 与独立 instance token。
          // [契约] 这是「窗口即隔离域」的核心证据：先断言 id/token 不同，再断言 widget 与存储互不可见。
          // [契约] 关掉第二窗口后主窗口 guest 仍存活，证明关闭不会连带销毁同 scope 的其他窗口。
          const second = await createWindow(scope);
          assert.notEqual(
            guests.get(win.webContents.id)!.id,
            guests.get(second.webContents.id)!.id,
          );
          assert.notEqual(
            handles.get(win.webContents.id).instance.token,
            handles.get(second.webContents.id).instance.token,
          );
          await evalPage(win, "window.saveWidget({window:1})");
          assert.equal(await evalPage(second, "window.readWidget()"), null);
          await evalPage(win, "window.storageRoundTrip(true)");
          assert.deepEqual(await evalPage(second, "window.storageRoundTrip(false)"), {
            local: "42",
            indexed: 42,
          });
          await closeWindow(second);
          assert.ok(!guests.get(win.webContents.id)!.isDestroyed());
        },
      );
      await check(
        "same surface across server and workspace identities isolates browser storage",
        async () => {
          // [契约] 身份矩阵一次只变一维：换 server、换 workspace、换 workspaceIdentity。
          // [契约] 三项共用同一 root 与同一 source-a，确保差异只来自身份，而非连接命令或参数。
          // [资源] 循环内建窗后立即 closeWindow 并 session/close，避免身份变体累积占用 guest 与 agent 会话。
          for (const [workspace, server, identity] of [
            ["workspace-a", "other"],
            ["workspace-b", "fixture"],
            ["workspace-a", "fixture", "fixture-other-workspace"],
          ]) {
            // 连接命令、参数、资源、surface 完全相同，每次只改变一个身份维度。
            const otherScope = await agent.session(
              join(root, workspace!),
              "source-a",
              server!,
              identity,
            );
            const other = await createWindow(otherScope);
            assert.notEqual(
              handles.get(win.webContents.id).partition,
              handles.get(other.webContents.id).partition,
            );
            assert.deepEqual(await evalPage(other, "window.storageRoundTrip(false)"), {
              local: null,
              indexed: null,
            });
            await closeWindow(other);
            await agent.call("session/close", { sessionId: otherScope.sessionId });
          }
        },
      );
      await checkCombinations({
        agent,
        win,
        scope,
        handles,
        guests,
        calls,
        bridge,
        wire,
        evalPage,
        createWindow,
        closeWindow,
        check,
      });
      await check("connection revoked during approval rejects late allow", async () => {
        // [失败路径] 断链用例：审批未决时 disconnect，晚到的 allow 必须无效，executed 保持 0。
        // [契约] 随后对旧 instance 调 uiValidateInstance 必须 reject，证明连接撤销同时废掉实例校验。
        // [契约] 用例放在最后，因为 disconnect 会破坏 source-a，后续用例无法再复用该连接。
        const result = evalPage(win, "window.callTool('disconnect')");
        const request = await approval("disconnect");
        agent.disconnect("source-a");
        assert.ok((await result).error);
        await agent.respond(request, "allow");
        assert.equal(executed("disconnect"), 0);
        await assert.rejects(() =>
          agent.call("mcp/uiValidateInstance", {
            ...scope,
            instance: handles.get(win.webContents.id).instance,
          }),
        );
      });
      // [资源] 先逐个关窗并等 guest 销毁，再断言全局 webview 计数为 0；顺序颠倒会读到尚未回收的 WebContents。
      // [契约] 该断言必须在写结果之前，否则 remainingGuests 字段与实际残留不一致。
      for (const window of windows) if (!window.isDestroyed()) await closeWindow(window);
      assert.equal(
        webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
          .length,
        0,
      );
      await writeFile(
        // [契约] 结果字段固定 checks/executions/remainingGuests；remainingGuests 写死 0，是对上一行断言的显式复述。
        // [契约] 用 writeFile 写回 root，调用方据此判断链路完整性，字段改名会破坏外部解析。
        join(root, "chain-results.json"),
        JSON.stringify(
          {
            checks,
            executions: agent.events.history.filter((event) => event.type === "executed"),
            remainingGuests: 0,
          },
          null,
          2,
        ),
      );
    } finally {
      // [资源] finally 再关一遍是幂等兜底：正常路径已全部销毁时这里全命中 isDestroyed 提前返回。
      // [失败路径] 断言中途抛错时窗口仍会被关，避免残留窗口把 Electron 进程钉住导致 CI 超时。
      // [资源] 先关窗再 agent.close()，让子进程收到「无活跃 UI 请求」的退出而不是被强杀。
      for (const window of windows) if (!window.isDestroyed()) await closeWindow(window);
      await agent.close();
    }
    // [资源] 显式 exit(0) 而非等自然退出：窗口已 destroy，但 agent 子进程句柄仍可能让事件循环存活。
    // [契约] 只有走到这里才代表全部用例通过；之前任何抛出都会落到 catch 的 exit(1)。
    app.exit(0);
  })
  .catch((error) => {
    // [失败路径] 顶层 catch 只把栈打到 stderr 并以 1 退出，不做重试或降级，保证 CI 直接失败。
    // [契约] 优先输出 stack，非 Error 抛值退化为字符串，避免只看到 [object Object]。
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
