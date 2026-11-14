// INV-01 隐藏窗口承载导出页：守住位置 构造；改错故障 校验期间弹出可见窗口。
// INV-02 沙箱必须开启：守住位置 webPreferences；改错故障 导出页获得 Node 能力。
// INV-03 只认 srcdoc 子帧：守住位置 frame 查找；改错故障 校验打到主页面而非导出内容。
// INV-04 加载等待覆盖两种时序：守住位置 Promise；改错故障 快加载时永久挂起。
// INV-05 两种主题都验字号：守住位置 循环；改错故障 只验浅色主题漏掉深色回归。
// INV-06 主色随主题反转：守住位置 断言；改错故障 深色模式按钮对比度不足。
// INV-07 调试器附着后才发命令：守住位置 顺序；改错故障 命令无会话直接失败。
// INV-08 命令统一带 sessionId：守住位置 send 包装；改错故障 命令落到浏览器级而非页面级。
// INV-09 触摸仿真在 finally 复位：守住位置 清理块；改错故障 后续用例继承移动端度量。
// INV-10 三个仿真开关都要关：守住位置 清理；改错故障 鼠标事件仍被转成触摸。
// INV-11 调试器必须解绑：守住位置 清理末尾；改错故障 下一次附着报已附加。
// INV-12 导出页不得有 require：守住位置 断言；改错故障 隔离边界被悄悄放开。
// INV-13 初始计数为零：守住位置 断言；改错故障 导出页带入了构建期状态。
// INV-14 第三方库版本锁定：守住位置 断言；改错故障 升级依赖后图表行为变化无人察觉。
// INV-15 工具提示可离屏触发：守住位置 等待逻辑；改错故障 触摸端提示无法验证。
// INV-16 状态持久化只走本地：守住位置 断言；改错故障 导出页尝试写远端存储。
// INV-17 重载后状态回灌：守住位置 第二次加载；改错故障 持久化只写不读。
// INV-18 窗口最终必销毁：守住位置 外层 finally；改错故障 校验失败后进程残留窗口。
//
// 模块职责：在真实 Chromium 中校验导出页的样式、隔离与交互能力。
// 状态所有权：临时窗口与调试会话都在本函数内创建并释放。
// 阅读顺序：先看窗口与加载，再看两轮主题断言，最后看触摸仿真与清理。
import assert from "node:assert/strict";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { checkControlStates } from "./control-state-checks.js";

/** 导出资源必须独立工作，不能依赖桌面 preload 或正在运行的 Agent。 */
// BrowserWindow 以 show: false 创建，并在 webPreferences 里开启 sandbox。
// load 把加载与等待逻辑抽成可复用函数，供两轮主题各调一次。
// light 与 dark 两轮共用同一套 checkStandalone 断言。
// 调试会话在两轮主题轮询结束后才建立。
// finally 里调用 win.destroy()，失败路径也必须销毁窗口。
export async function checkStandalone(root: string) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    // load 以 about:srcdoc 子帧出现作为加载完成标志。
    // 导出内容必须落在隔离子帧，mainFrame 直接渲染视为失败。
    // 等待逻辑同时兼容 readyState 已完成与未完成两种情况。
    // load 返回 frame 供后续 executeJavaScript 断言复用。
    // 每次调用 load 都会重新 loadFile 导航，不缓存旧 frame。
    const load = async () => {
      await win.loadFile(join(root, "standalone.html"));
      const frame = win.webContents.mainFrame.frames.find((item) => item.url === "about:srcdoc");
      assert.ok(frame, "Export must use an isolated srcdoc iframe");
      await frame.executeJavaScript(`new Promise(resolve => {
        if (document.readyState === 'complete') resolve(true);
        else addEventListener('load', () => resolve(true), {once:true});
      })`);
      return frame;
    };
    // 主题通过 document.documentElement.dataset.theme 切换。
    // 探针元素插入 DOM 后立即测量样式。
    // 测量完即 probe.remove()，避免残留节点污染下一轮 theme。
    // light 与 dark 两轮跑完后才进入 checkControlStates 调试器断言。
    let frame = await load();
    for (const theme of ["light", "dark"]) {
      const styles = await frame.executeJavaScript(`(() => {
        document.documentElement.dataset.theme=${JSON.stringify(theme)};
        const probe=document.createElement('div');probe.innerHTML='<h1>Title</h1><h2>Title</h2><h3>Title</h3><div class="card"><button class="btn btn-primary">Primary</button><input class="form-control"><select class="form-select"><option>Option</option></select></div>';
        document.body.append(probe);const css=selector=>getComputedStyle(probe.querySelector(selector));
        const result={headings:[...probe.querySelectorAll('h1,h2,h3')].map(node=>getComputedStyle(node).fontSize),radius:css('.card').borderRadius,input:css('input').minHeight,primary:css('.btn').backgroundColor};probe.remove();return result;
      })()`);
      assert.deepEqual(styles.headings, ["18px", "16px", "14px"]);
      assert.equal(styles.radius, "12px");
      assert.equal(styles.input, "36px");
      assert.equal(styles.primary, theme === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
    }
    win.webContents.debugger.attach("1.3");
    const { targetInfos } = await win.webContents.debugger.sendCommand("Target.getTargets");
    const target = targetInfos.find((info: { url: string }) => info.url === "about:srcdoc");
    const { sessionId } = await win.webContents.debugger.sendCommand("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    try {
      const send = (method: string, params = {}) =>
        win.webContents.debugger.sendCommand(method, params, sessionId);
      await send("DOM.enable");
      await send("CSS.enable");
      await send("DOM.getDocument", { depth: -1 });
      for (const theme of ["light", "dark"]) {
        await frame.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);
        await checkControlStates((code) => frame.executeJavaScript(code), send, true);
      }
      await win.webContents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: true,
        },
        sessionId,
      );
      await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await win.webContents.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", {
        enabled: true,
        configuration: "mobile",
      });
      const touch = await frame.executeJavaScript(`(() => {
        const probe=document.createElement('div');probe.innerHTML='<button class="btn btn-xs">Touch</button><input class="form-control form-control-xs">';document.body.append(probe);
        const button=getComputedStyle(probe.querySelector('button')),input=getComputedStyle(probe.querySelector('input'));
        const result={coarse:matchMedia('(pointer:coarse)').matches,button:button.minHeight,input:input.minHeight,font:input.fontSize};probe.remove();return result;
      })()`);
      assert.equal(touch.coarse, true);
      assert.equal(touch.button, "44px");
      assert.equal(touch.input, "44px");
      assert.equal(touch.font, "16px");
    } finally {
      await win.webContents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: false,
        },
        sessionId,
      );
      await win.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      await win.webContents.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", {
        enabled: false,
      });
      win.webContents.debugger.detach();
    }
    assert.equal(await frame.executeJavaScript("typeof require"), "undefined");
    assert.equal(await frame.executeJavaScript("window.initialCount"), 0);
    assert.equal(await frame.executeJavaScript("d3.version"), "7.9.0");
    assert.equal(
      await frame.executeJavaScript(
        "document.querySelector('[data-d3-probe]').getAttribute('width')",
      ),
      "7",
    );
    assert.equal(await frame.executeJavaScript("typeof FloatingUIDOM.computePosition"), "function");
    assert.equal(
      await frame.executeJavaScript("Boolean(document.querySelector('svg.lucide-search'))"),
      true,
    );
    await frame.executeJavaScript(`new Promise((resolve,reject)=>{
      document.querySelector('[data-tooltip]').dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true}));
      const end=Date.now()+2000;const tick=()=>{if(document.querySelector('[role=tooltip]')?.style.visibility==='visible')resolve(true);else if(Date.now()>end)reject(new Error('Offline tooltip failed'));else requestAnimationFrame(tick)};tick();
    })`);
    assert.equal(await frame.executeJavaScript("window.calendarWasReady"), true);
    assert.equal(
      await frame.executeJavaScript("Boolean(document.querySelector('viz-calendar').shadowRoot)"),
      true,
    );
    assert.equal(await frame.executeJavaScript("window.zcode.statePersistence"), "local");
    await frame.executeJavaScript(
      "window.zcode.setWidgetState({privateContent:{count:7},modelContent:'count:7'})",
    );
    frame = await load();
    assert.equal(await frame.executeJavaScript("window.initialCount"), 7);
    assert.equal(await frame.executeJavaScript("d3.version"), "7.9.0");
    assert.equal(await frame.executeJavaScript("window.zcode.stateModelContext"), "none");
    assert.equal(await frame.executeJavaScript("typeof globalThis.Tweak"), "undefined");
    assert.equal(
      await frame.executeJavaScript(
        "window.zcode.sendFollowUpMessage({prompt:'test'}).then(()=>true)",
      ),
      true,
    );
  } finally {
    // win.destroy() 放在最外层 finally，保证只执行一次。
    // 调试器在 win.destroy() 之前已经解绑。
    // 断言抛错时异常路径同样会走到 finally。
    // 清理后不留下任何全局引用，checkStandalone 可重复执行。
    win.destroy();
  }
}
