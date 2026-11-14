// INV-01 启动前写入独立用户数据目录：守住位置 路径设置；改错故障：复用默认目录会让多次运行共享缓存，握手状态互相污染。
// INV-02 特权协议必须在就绪前注册：守住位置 注册调用位置；改错故障：就绪后注册无效，沙箱页面加载失败。
// INV-03 关闭所有窗口不退出：守住位置 关闭事件；改错故障：默认行为会让用例在窗口关闭后直接结束。
// INV-04 先制造启动失败再恢复页面：守住位置 失败写入与恢复；改错故障：从未失败会测不到重试入口。
// INV-05 握手超时必须被判为失败：守住位置 创建结果的断言；改错故障：超时被当作成功会让重试用例失去前提。
// INV-06 重试按钮用真实宿主鼠标点击：守住位置 点击辅助调用；改错故障：脚本点击无法验证命中与层级。
// INV-07 记录点击次数以证明只触发一次：守住位置 计数断言；改错故障：重复触发会让重试被幂等逻辑吞掉。
// INV-08 恢复后等待进入运行阶段才继续：守住位置 阶段等待；改错故障：未进入运行就断言会让后续读数全为空。
// INV-09 注册次数必须精确等于预期：守住位置 注册计数断言；改错故障：多注册会让同一页面被两套卡片驱动。
// INV-10 可见性切换不得销毁访客：守住位置 访客标识对比；改错故障：隐藏即销毁会让恢复后状态丢失。
// INV-11 隐藏时布局为块级、透明且不可交互：守住位置 四项可见性断言；改错故障：用显示隐藏会让访客停止渲染，后台帧断言失去意义。
// INV-12 隐藏后仍需真实帧推进：守住位置 双帧竞速断言；改错故障：只检查访客存在无法证明后台未停帧。
// INV-13 恢复后计数器与输入值不变：守住位置 状态对比断言；改错故障：重建访客会让用户输入丢失。
// INV-14 每次切换前后注册总数不变：守住位置 注册计数对比；改错故障：切换导致重新注册会让插件被重复加载。
// INV-15 四种切换入口都要覆盖：守住位置 选择器列表；改错故障：只测侧栏收起会漏掉标签与工作区切换的回归。
// INV-16 亮暗两套主题各跑一遍：守住位置 主题循环；改错故障：只测亮色会漏掉暗色下的可见性样式。
// INV-17 每个切换都落盘截图与可见性快照：守住位置 两次写入；改错故障：只断不断言不留证会让失败难以定位。
// INV-18 用例结束必须恢复原始页面并关闭环境：守住位置 收尾块；改错故障：残留的坏页面会让下一次运行从错误状态开始。
//
// 模块职责：以真实宿主交互验证握手失败后的重试、访客隐藏与恢复、四种切换入口与双主题表现。
// 状态所有权：无模块状态；页面上下文、访客句柄与快照都来自托管环境，收尾时统一关闭。
// 阅读顺序：先看启动参数与就绪回调，再看失败制造与重试点击，最后看主题循环与结果汇总。
import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { clickHostPoint, checkPagePointerInput } from "./pointer-input.js";

// process.argv.slice(2) 解构出的 root/profile/node/cli 四个位置参数必须齐全：app.setPath("userData", profile) 与 protocol.registerSchemesAsPrivileged 都必须在 whenReady 之前同步执行，缺 profile 会让多次运行共享缓存，缺 root 会让后面的 join(root, "widget.html") 全部落空。
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  // whenReady() 链上：registerSchemesAsPrivileged 已在第 38 行提前注册，晚于 ready 会被忽略并让沙箱页空白；window-all-closed 注册空回调阻止默认退出；回调内先 readFile(root/widget.html) 存 goodHtml，managedEnvironment 与页面写入共享同一 try 作用域，finally 才能复原。
  .whenReady()
  .then(async () => {
    const htmlPath = join(root, "widget.html");
    const goodHtml = await readFile(htmlPath, "utf8");
    const env = await managedEnvironment(root, node, cli);
    try {
      // 真实等待握手时限；不伪造 controller 的错误态或直接卸载 webview。
      await writeFile(
        htmlPath,
        '<!doctype html><script>throw new Error("fixture startup failure")</script>',
      );
      // writeFile 先写入 throw new Error("fixture startup failure") 的页面制造可复现失败；createWindow(...).then(() => "unexpected success", String) 把成败都转成字符串交给 assert.match(/handshake timed out/)；events.wait 等 phase === "mounted" 而非固定延时，工作区用 interaction-workspace 与其它夹具隔离。
      const scope = await env.agent.session(join(root, "interaction-workspace"), "managed");
      const creation = env
        .createWindow(scope, "background-interaction")
        .then(() => "unexpected success", String);
      await env.events.wait((event) => event.type === "phase" && event.phase === "mounted");
      const win = env.windows[0]!;
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      await ui("window.setAnchors(false, true)");
      assert.match(await creation, /handshake timed out/);
      await ui(`new Promise(resolve => {
      if (!document.querySelector('webview')) return resolve();
      const observer = new MutationObserver(() => {
        if (!document.querySelector('webview')) { observer.disconnect(); resolve(); }
      });
      observer.observe(document.body, {subtree: true, childList: true});
    })`);
      const point = await ui(`(() => {
      const button = document.querySelector('[data-testid=plugin-ui-retry]');
      const r = button.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      window.retryClickCount = 0;
      button.addEventListener('click', () => window.retryClickCount++);
      return {x, y, hit: document.elementFromPoint(x, y)?.outerHTML};
    })()`);
      await writeFile(join(root, "retry-hit-test.json"), JSON.stringify(point, null, 2));
      await writeFile(htmlPath, goodHtml);
      const offset = env.events.history.length;
      await clickHostPoint(win, { x: point.x, y: point.y });
      assert.equal(await ui("window.retryClickCount"), 1, JSON.stringify(point));
      await env.events.wait((event) => event.type === "phase" && event.phase === "running", offset);
      await env.evalPage(win, "window.fixtureReady");
      assert.equal((await ui("window.managedState()")).views, 1);
      assert.equal(env.events.history.filter((event) => event.type === "registered").length, 2);
      const guest = env.guests.get(win.webContents.id)!;
      await checkPagePointerInput(win, guest);
      await ui("window.setAnchors(true, false)");
      await checkPagePointerInput(win, guest);
      assert.equal(env.guests.get(win.webContents.id)!.id, guest.id);
      await ui("window.setAnchors(false, true)");
      const stateBeforeHide = await env.evalPage(
        win,
        `({
        counter: document.querySelector('#counter').textContent,
        input: document.querySelector('#input').value
      })`,
      );
      const registrations = env.events.history.filter(
        (event) => event.type === "registered",
      ).length;
      // clickControl(selector) 取 document.querySelector(selector).getBoundingClientRect() 的矩形中心再调 clickHostPoint(win, point)：脚本 click() 验证不到命中与层级，这个辅助函数只投递一次真实宿主点击、不做断言，选择器由调用方给出，断言紧跟在每次调用之后避免状态串扰。
      const clickControl = async (selector: string) => {
        const point = await ui(`(() => {
          const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
        })()`);
        await clickHostPoint(win, point);
      };
      // 保留真实 React 卡片与 guest，用宿主鼠标关闭、重开及切换标签，防止只测卸载的假阳性。
      // 主题循环遍历 ["light", "dark"]，每个主题依次点 #toggle-sidebar、#switch-sidebar-tab、#switch-main-page、#switch-workspace 四个入口：每次切换把 visibility-${theme}-${selector}.json 与 .png 落盘，断言 webview 的 visible=false、display="block"、opacity≤0.001、inert=true、宽度>0 且 guest.isDestroyed()=false，恢复后 counter/input 必须等于 stateBeforeHide。
      for (const theme of ["light", "dark"] as const) {
        await ui(`window.setShowcasePresentation(${JSON.stringify(theme)}, 'en', 400)`);
        await ui("window.setAnchors(false, true)");
        for (const selector of [
          "#toggle-sidebar",
          "#switch-sidebar-tab",
          "#switch-main-page",
          "#switch-workspace",
        ]) {
          await clickControl(selector);
          const hidden = await ui(`(() => {
          const view = document.querySelector('webview');
          const root = view.closest('[data-sandbox-page-root]');
          return {
            visible: window.managedState().visible,
            display: getComputedStyle(root).display,
            opacity: getComputedStyle(root).opacity,
            inert: root.inert,
            width: view.getBoundingClientRect().width,
            anchorConnected: document.querySelector('#sidebar-anchor [data-testid="plugin-ui-card"]').isConnected,
            hit: document.elementFromPoint(600, 200)?.tagName
          };
        })()`);
          await writeFile(
            join(root, `visibility-${theme}-${selector.slice(1)}.json`),
            JSON.stringify(hidden, null, 2),
          );
          await writeFile(
            join(root, `visibility-${theme}-${selector.slice(1)}.png`),
            (await win.webContents.capturePage()).toPNG(),
          );
          assert.equal(hidden.visible, false, JSON.stringify(hidden));
          assert.equal(hidden.display, "block", JSON.stringify(hidden));
          assert.ok(Number(hidden.opacity) <= 0.001, JSON.stringify(hidden));
          assert.equal(hidden.inert, true);
          assert.ok(hidden.width > 0);
          assert.equal(hidden.anchorConnected, true);
          assert.notEqual(hidden.hit, "WEBVIEW");
          assert.equal(guest.isDestroyed(), false);
          // 隐藏不能停帧；用真实后台双帧完成工作，不能只检查 guest 还存在。
          assert.equal(
            await env.evalPage(
              win,
              `Promise.race([
          new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('running')))),
          new Promise(resolve => setTimeout(() => resolve('stalled'), 5000))
        ])`,
            ),
            "running",
          );
          await clickControl(selector);
          assert.equal((await ui("window.managedState()")).visible, true);
          assert.equal(env.guests.get(win.webContents.id)!.id, guest.id);
          assert.deepEqual(
            await env.evalPage(
              win,
              `({
          counter: document.querySelector('#counter').textContent,
          input: document.querySelector('#input').value
        })`,
            ),
            stateBeforeHide,
          );
        }
        await writeFile(
          join(root, `visibility-${theme}-restored.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      assert.equal(
        env.events.history.filter((event) => event.type === "registered").length,
        registrations,
      );
      await checkPagePointerInput(win, guest);
      await writeFile(
        join(root, "interaction-results.json"),
        JSON.stringify(
          {
            retryClicks: await ui("window.retryClickCount"),
            phase: (await ui("window.managedState()")).phase,
            views: (await ui("window.managedState()")).views,
            sidebarInput: true,
            inlineInput: true,
            sidebarHideAndRestore: true,
            inactiveTabHideAndRestore: true,
            mainPageHideAndRestore: true,
            workspaceHideAndRestore: true,
            hiddenBackgroundFrames: true,
            themes: ["light", "dark"],
          },
          null,
          2,
        ),
      );
      // process.stdout.write("PASS ...") 必须放在 finally 之前、所有断言之后：提前输出会让失败用例也显示 PASS；interaction-results.json 汇总 retryClicks/phase/themes，finally 里 writeFile(htmlPath, goodHtml) 与 env.close() 在异常路径同样执行，顶层 catch 只写 error.stack 到 stderr 并 app.exit(1)。
      process.stdout.write(
        "PASS real handshake timeout accepts mouse retry and restores interactive sidebar/inline guest\n",
      );
    } finally {
      await writeFile(htmlPath, goodHtml);
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
