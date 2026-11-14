// INV-01 argv 只取位置参数 root / profile / mode 三段；守住位置：顶层解构 process.argv 的 slice 结果；改错故障：缺 profile 时各用例共用默认 userData，分区断言互相污染而误报通过。
// INV-02 userData 必须在 app ready 之前改写完成；守住位置：紧接解构之后的 setPath 调用；改错故障：ready 后改路径只生效于内存副本，磁盘分区仍落默认 profile，跨进程持久化验证整体失效。
// INV-03 特权 scheme 注册必须早于任何 session.fromPartition；守住位置：顶层的 registerSchemesAsPrivileged；改错故障：旧分区上的 webRequest 钩子不含该方案，htmlReads 恒为 0，切换期间的资源断言失去意义。
// INV-04 进程只允许经显式 exit 退出，不依赖默认的 window-all-closed 行为；守住位置：空 window-all-closed 监听与末尾的 app.exit；改错故障：探针关窗瞬间进程退出，主宿主窗口来不及重建，CI 只看到退出码 0 的假成功。
// INV-05 旧分区名必须是固定的 64 位十六进制样式串；守住位置：oldPartition 的 repeat 构造；改错故障：随机名落入「非本宿主」分支，迁移与清理路径完全不被覆盖，每轮磁盘状态也不再可复现。
// INV-06 unrelated 分区的 fixture cookie 任何时刻都不得被清理；守住位置：write 分支的 set 与两处 length 断言；改错故障：清理若按前缀或全量扫描误伤旁路分区，「清理误删用户数据」这类缺陷再无法被本 fixture 拦住。
// INV-07 同一进程内 host 只安装一次；守住位置：installPluginSandboxHost 的唯一调用点；改错故障：同一 scheme 重复注册直接抛错，或协议处理器被后装者覆盖导致 guest 侧资源 404。
// INV-08 will-attach 与 did-attach 的 sandboxId 必须按 FIFO 一一配对；守住位置：pending 的 push 与 shift；改错故障：配对错位后 attachGuest 拿到他人 id，宿主越权挂载 guest，隔离性失效而用例仍可能通过。
// INV-09 configureGuest 返回失败时必须阻止挂载且不入队；守住位置：will-attach 回调里的 preventDefault 分支；改错故障：未配置的 guest 以默认 webPreferences 加载，绕过 preload 与沙箱限制。
// INV-10 单个宿主页最多挂载一个 webview guest；守住位置：will-attach 回调与队列长度假定；改错故障：队列积压后 shift 顺序与真实挂载顺序脱钩，后续 guest 断言全部指向错误对象。
// INV-11 每次 register 都递增 generation 并返回唯一分区名；守住位置：register 闭包里的自增与 host 返回句柄；改错故障：复用分区会让上一轮 storage 混入本轮断言，write 与 read 的期望值互相掩盖。
// INV-12 fixture-handle 只在首次调用返回初始句柄，之后一律重新注册；守住位置：ipcMain.handle 里的 first 分支；改错故障：渲染侧反复拿到过期句柄，切换测试退化为对同一代实例空转。
// INV-13 整个用例生命周期内 index.html 只允许被读取一次；守住位置：onCompleted 里的 htmlReads 自增与循环内断言；改错故障：页面复用退化为每次重建，冷启动与切换耗时指标失真，组件状态随之丢失。
// INV-14 40 次切换期间 webContents 总数与 guest id 必须恒定；守住位置：循环内两次 getAllWebContents 断言；改错故障：旧 guest 未销毁会泄漏渲染进程，id 被复用会掩盖状态串号。
// INV-15 同一侧的 listener 计数不得随切换次数增长；守住位置：listenerCounts 首次采样与逐轮深比较；改错故障：监听器泄漏在长会话中线性累积，最终拖垮宿主页，且只在长时间运行后显现。
// INV-16 debugger attach 与 detach 必须严格配对；守住位置：调试输入事件前后的两处调用；改错故障：异常路径残留 attach，后续切换与恢复用例全部因 debugger 独占而失败。
// INV-17 storage 往返期望值必须按 mode 三态严格区分；守住位置：两处 storageRoundTrip 的深比较；改错故障：read 与 empty 混判后，「清理成功」与「从未写入」无法区分，清理回归会被放过。
// INV-18 退出顺序固定为三分区 flush、destroy 窗口、exit 进程；守住位置：whenReady 末尾的三条语句；改错故障：先 destroy 再 flush 只能读到空会话，最后一批 cookie 落不了盘，下轮 read 模式读到过期状态。
import { app, BrowserWindow, ipcMain, protocol, session, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legacyStorage, checkClearing } from "./storage-checks.js";
import { checkPagePointerInput } from "./pointer-input.js";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
// [失败路径] argv 只按位置取值且不做校验：缺 root 时 readFile 抛 ENOENT，
// 缺 profile 时 app.setPath 收到 undefined，userData 会落到进程默认目录，
// 两份并发用例便共用同一份 Local Storage 互相污染，故三段缺一即快速失败。
// mode 只允许 read / write / empty 三态：write 建库、read 复用上一轮磁盘状态、
// empty 断言全新分区为空，拼写错误会让断言落到 read 语义而静默通过。
// [权衡] 不引入参数解析库，是为了让 fixture 被 CI 直接 spawn 时不带额外依赖，
// 代价是错误输入只能由下游断言暴露，而不是启动时就给出明确报错。
const [root, profile, mode] = process.argv.slice(2);
// [时序] userData 必须在 app ready 之前改写：ready 之后 Chromium 已完成
// profile 路径解析，再改只会落到内存副本，磁盘分区目录仍指向默认 profile。
// [资源] 每个用例独占一个 profile 目录且退出时不做清理，由外层脚本按目录回收，
// 失败现场（cookies、Local Storage、IndexedDB）在崩溃后仍可复盘。
// registerSchemesAsPrivileged 同样只能在 ready 前调用，且必须早于任何
// session.fromPartition，否则旧分区上的 webRequest 钩子拿不到该特权方案。
// [权衡] 方案注册是进程级一次性的，多分区共享同一份配置，无法按用例隔离。
app.setPath("userData", profile!);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
// 旧分区探针会先关闭临时窗口；完整测试结束前不能触发 Electron 默认退出。
// [并发] 默认退出策略是引用计数式的：探针阶段关闭临时窗口时若没有这个空监听器，
// Electron 会直接退出，而主宿主窗口还没开始建，后续全部断言都不会执行。
// 进程存活期因此被固定为「从顶层解构到末尾 exit」，中间任何环节都不允许提前终止。
// [失败路径] 若断言失败而未走到末尾，catch 分支补上 exit 1，避免进程悬挂；
// 悬挂的 fixture 只会表现为 CI 超时，比失败本身更难定位。
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // [权衡] 旧分区名用固定 64 个 b 而非随机串：清理逻辑按 token 形态校验分区名，
    // 必须呈 64 位十六进制样式才会被识别为可回收的沙箱分区；随机 UUID 会让本用例
    // 落入「非本宿主」分支，测不到真正的迁移与清理路径。
    // 固定名字还让每轮磁盘状态一致：write 写入的值可被下一轮 read 直接读到，
    // 这是跨进程验证持久化的前提，否则断言只能依赖同进程内缓存。
    // [失败路径] legacyStorage 期望值按 mode 分支：empty 必须为 null，其余必须是
    // 遗留值，否则说明上轮未按约定写入，或清理逻辑误伤了非目标分区。
    const oldPartition = "persist:plugin-sandbox-v1-" + "b".repeat(64);
    const old = session.fromPartition(oldPartition);
    assert.deepEqual(
      await legacyStorage(oldPartition, mode === "write"),
      mode === "empty" ? { local: null, indexed: null } : { local: "legacy", indexed: 7 },
    );
    // [并发] unrelated 分区是「不该被动到」的对照样本：清理旧沙箱分区时若按前缀
    // 或按全局分区列表批量删除，就会连它的 cookie 一起抹掉，本断言立刻失败。
    // 它在 write 模式写入同一个 cookie，保证两侧初始状态对称，对比才有意义。
    // [事务] 清理必须全有或全无：cookie 与 storage 任一残留都会让后续用例读到
    // 上一轮数据，因此对两面都做断言，而不是只查 storage。
    // [失败路径] expirationDate 取当前时间加一小时，避免会话期 cookie 在进程重启后
    // 消失，把「未被清理」误判成「被清理」。
    const unrelated = session.fromPartition("persist:unrelated-fixture");
    const cookie = {
      url: "https://fixture.invalid",
      name: "fixture",
      value: "retained",
      expirationDate: Date.now() / 1000 + 3600,
    };
    if (mode === "write") {
      await old.cookies.set(cookie);
      await unrelated.cookies.set(cookie);
    } else {
      assert.equal((await old.cookies.get({ name: "fixture" })).length, mode === "empty" ? 0 : 1);
      assert.equal((await unrelated.cookies.get({ name: "fixture" })).length, 1);
    }
    // 冷启动计时只包含待测宿主页，不把旧分区探针窗口的启动耗时算入。
    const started = performance.now();
    // [资源] installPluginSandboxHost 返回的 host 持有协议处理器与分区清理状态，
    // 后续每次 registerFromHost 都复用同一份；重复安装会让同一 scheme 注册两次，
    // Electron 直接抛错，故整个进程只允许安装一次且必须在建窗口之前。
    // logger 把参数数组 JSON 化后按行写盘：外层 harness 按行解析，绝不能直接
    // 拼接对象字符串，否则日志里出现换行会破坏行式协议。
    // [失败路径] 此处只透传事件名与计数类字段，token 与 sessionId 不得进入参数，
    // 日志泄漏的敏感值无法在事后撤回，只能在写之前拦。
    const host = installPluginSandboxHost({
      rendererDir: root!,
      aliasDir: root!,
      preloadPath: join(root!, "guest.cjs"),
      logger: {
        info: (...args) => process.stdout.write(JSON.stringify(args) + "\n"),
        warn: (...args) => process.stderr.write(JSON.stringify(args) + "\n"),
      },
    });
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        preload: join(root!, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("console-message", (event) =>
      process.stderr.write(String(event.message) + "\n"),
    );
    const pending: string[] = [];
    // [并发] configureGuest 与 attachGuest 通过 pending 队列按 FIFO 配对：
    // will-attach-webview 先给出 sandboxId，did-attach-webview 才拿到 guest，
    // 两个回调之间没有其它同步手段，队列顺序就是唯一契约。
    // 失败时必须阻止挂载，否则未配置的 guest 以默认 webPreferences 加载，
    // 绕过 preload 与沙箱限制，后续 did-attach 还会取到不属于本宿主的 id。
    // [失败路径] 队列取空得到 undefined 说明配对已错位，attachGuest 的断言会立即
    // 失败，比静默跳过更能暴露挂载时序被改动；单宿主页只挂一个 guest，长度恒为 0 或 1。
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = host.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!result.ok) event.preventDefault();
      else pending.push(result.sandboxId);
    });
    win.webContents.on("did-attach-webview", (_event, guest) =>
      host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! }),
    );
    const html = await readFile(join(root!, "widget.html"), "utf8");
    let generation = 0;
    const register = () =>
      host.registerFromHost({
        instance: {
          runtimeId: "fixture",
          generation: ++generation,
          token: crypto.randomUUID(),
          appIdentity: "a".repeat(64),
        },
        ownerWebContentsId: win.webContents.id,
        workspacePath: "/fixture",
        sessionId: "fixture",
        pluginId: "fixture",
        serverName: "fixture",
        scopeId: "fixture",
        html,
      });
    const handle = register();
    let first = true;
    let htmlReads = 0;
    session
      .fromPartition(handle.partition)
      .webRequest.onCompleted({ urls: ["zcode-sandbox://*/*"] }, (event) => {
        if (event.url.includes("/index.html")) htmlReads++;
      });
    ipcMain.handle("fixture-handle", () => {
      if (first) {
        first = false;
        return handle;
      }
      return register();
    });
    ipcMain.handle("fixture-config", () => null);
    await win.loadFile(join(root!, "host.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === "webview")!;
    assert.ok(guest);
    const frame = guest.mainFrame.frames.find((frame) => frame.url.includes("/instance/"))!;
    await frame.executeJavaScript("window.fixtureReady");
    const initialState =
      "({ counter: document.querySelector('#counter').textContent, input: document.querySelector('#input').value, scroll: document.querySelector('#scroll').scrollTop, starts: window.starts })";
    assert.deepEqual(await frame.executeJavaScript(initialState), {
      counter: "0",
      input: "",
      scroll: 0,
      starts: 1,
    });
    if (mode === "write")
      assert.deepEqual(await frame.executeJavaScript("window.storageRoundTrip(false)"), {
        local: null,
        indexed: null,
      });
    const coldMs = performance.now() - started;
    await win.webContents.executeJavaScript("window.switchPage(false)");
    const storage = await frame.executeJavaScript(`window.storageRoundTrip(${mode === "write"})`);
    assert.deepEqual(
      storage,
      mode === "empty" ? { local: null, indexed: null } : { local: "42", indexed: 42 },
    );
    // 用 Chromium 输入事件走 React onClick/onChange，避免直接改 DOM 掩盖受控状态丢失。
    // [资源] debugger 是独占资源：attach 成功前 DevTools 与其它 attach 都会被拒，
    // 因此必须在同一段同步代码里 detach，不能跨 await 持有。
    // [失败路径] 上面两次 sendCommand 若有任一抛错，detach 不会执行，guest 会带着
    // 已附加的 debugger 跑完后续 40 次切换，失败点会漂移到无关位置。
    // 走 Chromium 输入事件而非直接改 DOM，是为了让受控组件真正经历一次
    // 完整的事件序列；点击坐标取 rect 中心并四舍五入，亚像素坐标会让命中测试落空。
    // [权衡] 接受上述异常路径的泄漏风险，因为本 fixture 一旦抛错即整进程退出。
    guest.debugger.attach("1.3");
    for (const selector of ["#counter", "#input"]) {
      const point = await frame.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`,
      );
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
    }
    await guest.debugger.sendCommand("Input.insertText", { text: "retained" });
    guest.debugger.detach();
    await frame.executeJavaScript(
      "document.querySelector('#scroll').scrollTop = 123; new Promise(requestAnimationFrame)",
    );
    const active = webContents.getAllWebContents().length;
    const times: number[] = [];
    const dispatchTimes: number[] = [];
    const listenerCounts = new Map<boolean, number>();
    // [并发] 固定 40 次而不是循环到稳定：次数固定才能让耗时中位数跨机器比较，
    // 也让失败可复现；动态停止会丢失「第几次开始退化」这一信息。
    // listenerCounts 只在首次见到该侧时采样，之后每轮必须与首次相等：
    // 监听器随切换次数增长是宿主最常见的泄漏形态，等差增长在这里会被抓住。
    // [事务] 每轮切换后校验 htmlReads 恒为 1、webContents 总数不变、guest id 不变，
    // 说明页面是被复用而非重建；哪轮变了，紧邻这一轮就是根因，无需二分。
    // dispatchMs 只参与中位数统计，不参与稳定性断言，它是耗时指标而非语义契约。
    for (let n = 0; n < 40; n++) {
      const start = performance.now();
      const counts = await win.webContents.executeJavaScript(`window.switchPage(${n % 2 === 0})`);
      times.push(performance.now() - start);
      const side = n % 2 === 0;
      if (!listenerCounts.has(side)) listenerCounts.set(side, counts.listeners);
      dispatchTimes.push(counts.dispatchMs);
      const { dispatchMs: _dispatch, ...stable } = counts;
      assert.deepEqual(stable, {
        handshakes: 1,
        views: 1,
        listeners: listenerCounts.get(n % 2 === 0),
      });
      assert.equal(htmlReads, 1);
      assert.equal(webContents.getAllWebContents().length, active);
      assert.equal(
        guest.id,
        webContents.getAllWebContents().find((contents) => contents.getType() === "webview")!.id,
      );
    }
    assert.deepEqual(
      await frame.executeJavaScript(
        "({ counter: document.querySelector('#counter').textContent, input: document.querySelector('#input').value, scroll: document.querySelector('#scroll').scrollTop, starts: window.starts })",
      ),
      { counter: "1", input: "retained", scroll: 123, starts: 1 },
    );
    for (const position of ["inline", "sidebar", "preview"]) {
      await win.webContents.executeJavaScript(`window.switchPage(${position === "sidebar"})`);
      if (position === "preview")
        await win.webContents.executeJavaScript("window.previewPage(true)");
      await checkPagePointerInput(win, guest);
      if (position === "preview")
        await win.webContents.executeJavaScript("window.previewPage(false)");
      assert.equal(guest.isDestroyed(), false);
    }
    await writeFile(
      join(root!, `switch-${mode}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
    await writeFile(
      join(root!, `metrics-${mode}.json`),
      JSON.stringify(
        {
          mode,
          coldMs,
          switches: times.length,
          switchObservedMedianMs: [...times].sort((a, b) => a - b)[20],
          switchDispatchMedianMs: [...dispatchTimes].sort((a, b) => a - b)[20],
          webContents: active,
          handshakes: 1,
          htmlReads,
          listeners: { inline: listenerCounts.get(false), sidebar: listenerCounts.get(true) },
          storage,
        },
        null,
        2,
      ),
    );
    assert.equal(await frame.executeJavaScript("window.readWidget()"), null);
    await frame.executeJavaScript("window.saveWidget({ saved: 7 })");
    assert.deepEqual(await win.webContents.executeJavaScript("window.recyclePage()"), {
      views: 0,
      state: { saved: 7 },
    });
    assert.equal(
      webContents.getAllWebContents().filter((c) => c.getType() === "webview").length,
      0,
    );
    for (const retry of [false, true]) {
      await win.webContents.executeJavaScript(`window.restorePage(${retry})`);
      const restoredGuest = webContents.getAllWebContents().find((c) => c.getType() === "webview")!;
      const restored = restoredGuest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
      await restored.executeJavaScript("window.fixtureReady");
      assert.deepEqual(await restored.executeJavaScript(initialState), {
        counter: "0",
        input: "",
        scroll: 0,
        starts: 1,
      });
      assert.deepEqual(
        await restored.executeJavaScript("window.readWidget()"),
        retry ? null : { saved: 7 },
      );
      assert.deepEqual(await restored.executeJavaScript("window.storageRoundTrip(false)"), storage);
      assert.equal(webContents.getAllWebContents().length, active);
    }
    if (mode === "read") {
      await checkClearing({
        root: root!,
        partition: handle.partition,
        oldPartition,
        host,
        win,
        register,
      });
      assert.equal(
        webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
          .length,
        0,
      );
      assert.equal((await old.cookies.get({ name: "fixture" })).length, 0);
      assert.equal((await unrelated.cookies.get({ name: "fixture" })).length, 1);
      assert.throws(() => host.registerFromHost({} as never), /being cleared/);
    }
    // [资源] 退出前先 flush 三个分区再 destroy 窗口：destroy 会触发渲染进程退出，
    // 之后再 flush 只能拿到空会话，磁盘上会丢掉最后一次写入。
    // [时序] app.exit 不等待窗口 close 事件，故 destroy 必须显式前置；否则进程可能
    // 在 webContents 仍存活时退出，CI 会看到渲染进程异常终止的噪声。
    // [失败路径] catch 打印 stack 后以 1 退出，保证失败不会被 exit 0 掩盖。
    session.fromPartition(handle.partition).flushStorageData();
    await old.cookies.flushStore();
    await unrelated.cookies.flushStore();
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error));
    app.exit(1);
  });
