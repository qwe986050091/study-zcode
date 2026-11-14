// INV-01 协议处理器按分区去重：守住位置 已备集合；改错故障 二次注册直接抛错。
// INV-02 夹具页最小化：守住位置 固定文档响应；改错故障 夹具自身引入存储行为。
// INV-03 可见性不干扰计时：守住位置 关闭后台节流；改错故障 隐藏窗口里写入被推迟。
// INV-04 窗口必须销毁：守住位置 收尾块；改错故障 残留页面影响后续分区判定。
// INV-05 写入与读取同一事务口径：守住位置 索引库操作；改错故障 读到未提交的值。
// INV-06 旧分区读数必须为空：守住位置 清理后回读；改错故障 残留数据被当成迁移成功。
// INV-07 哨兵文件先读后比：守住位置 清理前基线；改错故障 无法证明插件数据未被波及。
// INV-08 清理时序由测试控制：守住位置 进入与释放信号；改错故障 断言与清理互相抢跑。
// INV-09 包装层仍调用原生清理：守住位置 保留原函数引用；改错故障 用假实现代替持久化验证。
// INV-10 卸载拦截不能阻塞清理：守住位置 页面内注册的拦截；改错故障 清理被对话框卡死。
// INV-11 帧必须真的停止：守住位置 帧销毁断言；改错故障 包装对象已销毁但文档仍在写。
// INV-12 清理未完成前不得注册：守住位置 抛错断言；改错故障 新插件在清空中被挂载。
// INV-13 清理未完成前不得重开：守住位置 拒绝断言；改错故障 旧页面在清空中复活。
// INV-14 完成标志用于证伪：守住位置 两次假值断言；改错故障 清理提前返回被忽略。
// INV-15 全部通过才写结果：守住位置 结果文件位置；改错故障 中途失败留下误导性报告。
// INV-16 原生方法必须还原：守住位置 收尾赋回；改错故障 后续用例沿用被包装版本。
// INV-17 释放信号幂等：守住位置 成功与收尾都放行；改错故障 异常路径下清理永久等待。
// INV-18 断言信息自带语境：守住位置 失败消息；改错故障 只看到布尔比较。
//
// 模块职责：验证插件沙箱清理存储时的时序、拒绝语义与旧数据清除效果。
// 状态所有权：分区与宿主由调用方注入，本模块只临时替换清理方法。
// 阅读顺序：先看旧分区夹具，再看清理检查的时序编排与断言。
import { BrowserWindow, session, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSandboxHost } from "../../src/main/pluginSandbox/host.js";

// prepared 集合保证同一 partition 只挂一次 protocol.handle()。
// session.protocol.handle() 重复注册会抛错，故用 prepared 去重。
// https 处理器只返回 legacy fixture 最小 HTML，不做真实页面。
// 存储读写全部发生在页面内，夹具侧不直接写 localStorage。
const prepared = new Set<string>();
export async function legacyStorage(partition: string, write: boolean) {
  const storage = session.fromPartition(partition);
  if (!prepared.has(partition)) {
    prepared.add(partition);
    await storage.protocol.handle(
      "https",
      () =>
        new Response("<!doctype html><body>legacy fixture</body>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition, backgroundThrottling: false },
  });
  try {
    await win.loadURL("https://legacy.fixture.invalid");
    return await win.webContents.executeJavaScript(
      `(${async function (write: boolean) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("host-fixture", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("values");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (write) {
          localStorage.setItem("counter", "legacy");
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("values", "readwrite");
            tx.objectStore("values").put(7, "counter");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
        const value = await new Promise((resolve, reject) => {
          const request = db.transaction("values").objectStore("values").get("counter");
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return { local: localStorage.getItem("counter"), indexed: value };
      }.toString()})(${write})`,
    );
  } finally {
    win.destroy();
  }
}

// sentinelPaths 的两个哨兵文件用于确认插件侧数据未被清理波及。
// 清理前先读 before 基线，清理后再对比 after。
// clearStorageData 在真实实现外包一层，仅用于控制时序。
// entered 与 release 两个 Promise.withResolvers 信号控制清理时序。
// 包装层 await release 后仍调用原生 clear(options)，不 mock 成功。
export async function checkClearing(input: {
  root: string;
  partition: string;
  oldPartition: string;
  host: PluginSandboxHost;
  win: BrowserWindow;
  register(): unknown;
}) {
  const { root, partition, oldPartition, host, win, register } = input;
  const sentinelPaths = [join(root, "plugin-sentinel.sqlite"), join(root, "plugin-sentinel.txt")];
  const before = await Promise.all(sentinelPaths.map((file) => readFile(file)));
  const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview")!;
  const frame = guest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
  await frame.executeJavaScript(
    "window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = 'keep writing'; }); window.startStorageWriter()",
    true,
  );
  const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
  const storage = session.fromPartition(partition);
  const clear = storage.clearStorageData.bind(storage);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // 只控制真实清理开始的时序；释放后仍调用 Electron 原生实现，不用 mock 成功代替持久化验证。
  storage.clearStorageData = async (options) => {
    entered.resolve();
    await release.promise;
    await clear(options);
  };
  // completed 标志用于证明清理尚未返回。
  // clearing 与断言在竞态中交错执行，靠 completed 判断先后。
  // register() 必须因分区正在清理而抛 /being cleared/。
  // restorePage(false) 同样被拒绝，assert.rejects 断言其失败。
  // release.resolve() 后旧分区 legacyStorage 必须为 { local: null, indexed: null }。
  let completed = false;
  const clearing = host.clearBrowserData().then(() => {
    completed = true;
  });
  try {
    await entered.promise;
    await destroyed;
    // Electron guest 的包装对象 destroyed 不等于插件文档退出；旧实现这里稳定失败。
    assert.equal(frame.isDestroyed(), true, "plugin frame must stop before storage clearing");
    assert.equal(completed, false);
    assert.equal(
      webContents.getAllWebContents().filter((c) => c.getType() === "webview").length,
      0,
    );
    assert.throws(register, /being cleared/);
    await assert.rejects(() => win.webContents.executeJavaScript("window.restorePage(false)"));
    assert.equal(completed, false);
    release.resolve();
    await clearing;
    assert.deepEqual(await legacyStorage(oldPartition, false), { local: null, indexed: null });
    const after = await Promise.all(sentinelPaths.map((file) => readFile(file)));
    assert.deepEqual(after, before);
    await writeFile(
      join(root, "clearing-results.json"),
      JSON.stringify({
        oldFrameDestroyedBeforeClear: true,
        registrationAndReopenRejected: true,
        beforeUnloadDidNotBlock: true,
        legacyStorageEmpty: true,
        pluginSentinelsUnchanged: true,
      }),
    );
    process.stdout.write(
      "PASS clearing rejects register/reopen, destroys writing frame before clearing despite beforeunload, clears legacy data, preserves SQLite/file sentinels\n",
    );
  } finally {
    release.resolve();
    await clearing;
    storage.clearStorageData = clear;
  }
}
