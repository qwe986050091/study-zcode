// INV-01 以 argv 传入 root 与 profile：守住位置 首两行解构；改错故障 路径缺失时写入错误目录。
// INV-02 userData 必须在 ready 前设置：守住位置 启动段；改错故障 Electron 使用默认配置目录。
// INV-03 特权 scheme 必须先声明：守住位置 registerSchemesAsPrivileged；改错故障 webview 加载被拒。
// INV-04 沙箱宿主与 preload 分别装配：守住位置 whenReady 首段；改错故障 guest 无法桥接。
// INV-05 窗口隐藏但禁用后台节流：守住位置 BrowserWindow 选项；改错故障 压测时序被打乱。
// INV-06 will-attach-webview 阶段统一配置 guest：守住位置 事件回调；改错故障 越权选项生效。
// INV-07 配置失败必须阻止附加：守住位置 preventDefault；改错故障 非法 guest 被挂载。
// INV-08 sandboxId 在附加事件按队列取用：守住位置 pending 数组；改错故障 guest 与会话错配。
// INV-09 每页注册递增 generation：守住位置 注册闭包；改错故障 宿主判定为陈旧绑定。
// INV-10 应用标识与令牌长度固定：守住位置 instance 字段；改错故障 校验分支提前拒绝。
// INV-11 IPC 只暴露 register 一个方法：守住位置 ipcMain.handle；改错故障 fixture 面被扩大。
// INV-12 容量上限固定 64：守住位置 循环与断言；改错故障 上限回归无法发现。
// INV-13 超限后既不新增也不误释放：守住位置 overflow 三段断言；改错故障 计数漂移被掩盖。
// INV-14 busy 页面不参与 LRU 淘汰：守住位置 task 段断言；改错故障 活跃页被回收。
// INV-15 可见页面不因时长被释放：守住位置 deadline 段；改错故障 前台页被误杀。
// INV-16 隐藏且空闲页面按截止时间释放：守住位置 advance 调用；改错故障 快照泄漏。
// INV-17 释放以 destroyed 事件为准：守住位置 Promise 等待；改错故障 用 sleep 造成偶发失败。
// INV-18 失败必须带栈退出非零：守住位置 catch 分支；改错故障 CI 把错误当通过。
//
// 模块职责：真实 Electron 环境下的插件沙箱 retention 压测 fixture。
// 状态所有权：无持久状态；所有计数与阶段结论只写入结果 JSON。
// 阅读顺序：先看启动装配，再读注册入口，最后看容量、LRU 与截止时间三段断言。
import { app, BrowserWindow, ipcMain, protocol, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
// root 是打包资源目录。
// profile 是隔离的 userData。
// 参数顺序固定为 root、profile，写反不会报错但会把数据写进错误目录。
// 缺参数时 root! / profile! 会抛 TypeError 直接退出，不静默用默认目录跑压测。
// 脚本不校验路径是否可写，压测前由宿主自己保证 userData 目录存在。
const [root, profile] = process.argv.slice(2);
app.setPath("userData", profile!);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app
  .whenReady()
  .then(async () => {
    const host = installPluginSandboxHost({
      rendererDir: root!,
      aliasDir: root!,
      preloadPath: join(root!, "guest.cjs"),
    });
    // 窗口不显示，仅承载 webview。
    // preload 来自资源目录。
    // 开启 webviewTag 才能挂载 guest。
    // 关闭后台节流保证压测时序。
    // width 1000 / height 900 只为让 webview 有确定视口，不参与时序测量。
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 900,
      webPreferences: {
        preload: join(root!, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    const pending: string[] = [];
    // 附加前由宿主改写 webPreferences。
    // 成功时记录 sandboxId。
    // 失败直接阻止附加。
    // 阻止后计数不应变化。
    // owner 是承载窗口自身。
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = host.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (result.ok) pending.push(result.sandboxId);
      else event.preventDefault();
    });
    win.webContents.on("did-attach-webview", (_event, guest) =>
      host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! }),
    );
    const html = await readFile(join(root!, "widget.html"), "utf8");
    let generation = 0;
    // generation 每次注册递增。
    // token 使用随机 UUID。
    // 应用标识为固定长度占位。
    // 工作区路径固定为根。
    const register = (key: string, task: string) =>
      host.registerFromHost({
        instance: {
          runtimeId: "retention",
          generation: ++generation,
          token: crypto.randomUUID(),
          appIdentity: "c".repeat(64),
        },
        ownerWebContentsId: win.webContents.id,
        workspacePath: "/retention",
        sessionId: task,
        pluginId: "fixture",
        serverName: "fixture",
        scopeId: key,
        html,
      });
    ipcMain.handle("fixture-bridge", (_event, method, params) => {
      assert.equal(method, "register");
      return register(params.key, params.task);
    });
    await win.loadFile(join(root!, "retention.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    const run = (code: string) => win.webContents.executeJavaScript(`window.retention.${code}`);
    const guestCount = () =>
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").length;
    // 容量段先填满 64 个 guest。
    // 任务段验证 LRU 与 busy 保护。
    // 结果写入 JSON 供上层断言。
    const started = performance.now();
    const counts: any[] = [];
    for (let n = 0; n < 64; n++) assert.ok((await run(`addPage('cap-${n}','capacity')`)).sandboxId);
    assert.equal(guestCount(), 64);
    counts.push({ phase: "capacity-full", guests: guestCount(), ...(await run("counts()")) });
    assert.match((await run("addPage('overflow','capacity')")).error, /capacity/);
    assert.equal(guestCount(), 64);
    assert.throws(() => register("native-overflow", "capacity"), /64/);
    assert.equal(guestCount(), 64);
    await run("visibility('cap-0',false)");
    await run("busy('cap-0',true)");
    assert.match((await run("addPage('busy-overflow','capacity')")).error, /capacity/);
    assert.equal(guestCount(), 64);
    await run("busy('cap-0',false)");
    assert.ok((await run("addPage('replacement','capacity')")).sandboxId);
    assert.equal(guestCount(), 64);
    assert.ok((await run("counts()")).released.includes("cap-0"));
    await run("clear()");
    assert.equal(guestCount(), 0);
    assert.equal((await run("counts()")).ports, 0);
    counts.push({ phase: "capacity-cleared", guests: guestCount(), ...(await run("counts()")) });
    for (let n = 0; n < 30; n++) {
      await run(`addPage('task-${n}','task-${n}',false)`);
      await run(`visibility('task-${n}',false)`);
    }
    await run("busy('task-0',true)");
    await run("addPage('task-30','task-30',false)");
    assert.equal(guestCount(), 30);
    const lru = await run("counts()");
    assert.equal(lru.pages, 30);
    assert.equal(lru.snapshots, 30);
    assert.ok(lru.released.includes("task-1"));
    assert.ok(!lru.released.includes("task-0"));
    counts.push({ phase: "task-lru", guests: guestCount(), ...lru });
    await run("clear()");
    assert.equal(guestCount(), 0);
    await run("addPage('deadline','deadline')");
    await run("visibility('deadline',false)");
    await run("advance(299999)");
    assert.equal(guestCount(), 1);
    await run("visibility('deadline',true)");
    await run("advance(600000)");
    assert.equal(guestCount(), 1);
    await run("visibility('deadline',false)");
    await run("busy('deadline',true)");
    await run("advance(300000)");
    assert.equal(guestCount(), 1);
    await run("busy('deadline',false)");
    // 释放完成由 guest destroyed 事件确认；不使用 sleep 作为同步依据。
    const remaining = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview");
    await Promise.all(
      remaining.map((guest) => new Promise<void>((resolve) => guest.once("destroyed", resolve))),
    );
    assert.equal(guestCount(), 0);
    assert.equal((await run("counts()")).snapshots, 1);
    await run("clear()");
    const cleared = await run("counts()");
    assert.equal(cleared.pages, 0);
    assert.equal(cleared.ports, 0);
    assert.equal(cleared.snapshots, 0);
    assert.equal(cleared.timers, 0);
    counts.push({ phase: "all-cleared", guests: guestCount(), ...cleared });
    await writeFile(
      join(root!, "retention-results.json"),
      JSON.stringify({ durationMs: performance.now() - started, counts }, null, 2),
    );
    process.stdout.write("PASS real Electron 64 guests / 30 tasks / offscreen / busy retention\n");
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
