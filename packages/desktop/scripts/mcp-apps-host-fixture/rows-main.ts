// INV-01 检查按脚本顺序串行执行，前一场景失败即整批中止，不并发跑多个 check；守住位置：check 辅助函数与所有 await check 调用；改错故障：失败被后续 PASS 掩盖，报告与真实状态不符
// INV-02 只有 run 完整成功才把名字计入 checks 并打印 PASS；守住位置：check 辅助函数；改错故障：截图与结果 JSON 里的通过数和实际不符
// INV-03 行数据只经 window.setRows 注入真实时间线，不直接挂 PluginUiCard；守住位置：rows-renderer 的 RowsFixture；改错故障：绕过展示资格与折叠策略，全部断言失去意义
// INV-04 行 id 同时是顺序与时间戳基准，createdAt、createdAtSeq、toolCallId 全由 id 派生；守住位置：rows 的 useMemo 映射；改错故障：时间线重排，latest-success 锚点指向错误行
// INV-05 errors 固定 5 条且 id 升序为 2、4、6、7、8，刻意保留时间线中的空洞位；守住位置：errors 常量；改错故障：行数断言与 length 错位，覆盖场景悄悄漂移
// INV-06 失败行覆盖三种终止形态，isError、status 为 error、status 为 cancelled 各占位；守住位置：errors 常量与 rows 映射；改错故障：少测一类终止态，错误 App 挂载无人发现
// INV-07 全部失败行都带 fullscreen，用来同时验证失败不建 App 与失败不抢全屏；守住位置：errors 常量；改错故障：全屏抢占回归漏测
// INV-08 首轮 pin 只对成功行生效，失败行即使被 pin 也不得建卡片；守住位置：第一条 all failures 场景；改错故障：pin 掩盖失败行的展示策略
// INV-09 mixed 固定为 1、3、5 成功与 2、4、6、7、8 失败的交替序列，最后一个成功是 row-5；守住位置：mixed 常量；改错故障：owners 期望从 row-5 漂移，锚点断言全部失效
// INV-10 全程只允许一个 guest，guestId 取一次后在每处复用比较；守住位置：guestId 取值与各轮 guest 断言；改错故障：页面被重复挂载仍被判为通过
// INV-11 opens 是累计计数，断言一律用相对增量而不是绝对值；守住位置：20 轮往返与后续各 check；改错故障：一次多余的自动打开被吞掉
// INV-12 每次点击后必须先 settle 双帧再读状态；守住位置：settle、openRow、closeSidebar、showCard；改错故障：读到 React 提交前的中间态，随机失败
// INV-13 20 轮往返结束后 registered、read、subscribed 各为 1；守住位置：20 轮 check 尾部断言；改错故障：每次重开都新建页面与订阅，资源泄漏
// INV-14 时间线卸载与重挂载不得重置 opens 或 owners；守住位置：两处 mountRows 场景；改错故障：状态驻留丢失，用户看到侧栏反复重开
// INV-15 新的全屏成功结果只自动打开一次，关闭后不回收页面；守住位置：id 10 与 id 11、12 的场景；改错故障：每次渲染都弹侧栏
// INV-16 追加失败行不得改变既有的 row-5 锚点；守住位置：卸载重挂载场景；改错故障：错误行抢占成功页
// INV-17 侧栏开启期间到达的调用被消费，之后的调用仍能打开；守住位置：最后一条场景；改错故障：侧栏常开或再也不开
// INV-18 退出前必须关闭环境，异常路径同样清理窗口与 Agent；守住位置：finally 分支；改错故障：进程挂起、端口残留
// INV-19 顶层 catch 打印 stack 并以非零码退出，禁止吞异常；守住位置：catch 分支；改错故障：CI 把失败夹具当成通过
//
// 本文件是行数据夹具的驱动层：它不造 UI，只负责注入行、点击、读状态、断言。
// 行的确定性来自 id 派生的时间戳与固定交错，任何顺序改动都会直接改写锚点期望。
// 因此改数据等于改契约，先改期望再改数据，失败时保持整批不写半套结果。
import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
// 参数顺序是固定契约，root、profile、node、cli 依次取自 argv 尾部四项
// 顺序写错不会在启动时报错，只会让用户目录与 Agent 路径悄悄落到错误位置
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
// 特权 scheme 必须在 whenReady 之前注册，这是 Electron 的时序要求
// 漏注册时 guest 页面直接加载失败，表现为白屏而不是可读的协议错误 [失败路径]
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // 环境是一次性资源，窗口、guest、Agent 都挂在 env 上，由 finally 统一关闭 [资源]
    // 根目录用 root 拼相对路径，保证截图与结果落在夹具目录而不是仓库根
    // 环境构造失败会直接抛到 catch，不会留下半开的窗口
    const env = await managedEnvironment(root, node, cli);
    const checks: string[] = [];
    // check 串行执行，run 完全成功后才会记账并打印 PASS [失败路径]
    // run 抛错会中断整条检查序列，因此第一个失败点就是真实断点
    // 计数与 PASS 输出绑在同一步，避免日志和 checks 列表互相矛盾
    const check = async (name: string, run: () => Promise<void>) => {
      await run();
      checks.push(name);
      process.stdout.write(`PASS ${name}\n`);
    };
    // 所有场景共用同一个 try，异常统一上抛到文件末尾的 catch
    // 这里没有逐项 try，任一断言失败都会终止整批，不会写出半套结果 [失败路径]
    try {
      // 会话工作区固定为 rows-workspace，让每次运行的路径可预期、可复现
      // 第二个参数是会话标签，也是页面侧识别本夹具的固定前缀
      const scope = await env.agent.session(join(root, "rows-workspace"), "rows");
      const win = await env.createWindow(scope, "rows");
      // 两个执行入口分工固定，ui 读主窗口而 page 读 guest，混用会读到错误上下文
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const page = (code: string) => env.evalPage(win, code);
      const state = () => ui("window.rowsState()");
      // settle 用两帧 rAF 等布局稳定，单帧可能在 React 提交后仍读到旧 DOM
      // 所有点击后的读取都先过 settle，否则断言会在中间态上无提示地抖动
      const settle = () =>
        ui("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const openRow = async () => {
        await ui(`document.querySelector('[data-testid="plugin-ui-open-side-pane"]').click()`);
        await settle();
      };
      const closeSidebar = async () => {
        await ui("document.getElementById('close-sidebar').click()");
        await settle();
      };
      // showCard 先滚动到卡片再断言页面可见，顺序反了会因尚未渲染而误判
      // 它同时校验两个条件：卡片节点存在，且页面状态确实是可见
      const showCard = async () => {
        await ui(
          `document.querySelector('[data-tool-call-id] [data-testid="plugin-ui-card"]').scrollIntoView({block:'center'})`,
        );
        await settle();
        assert.equal(await ui("window.rowPageVisible()"), true);
      };
      // 历史行默认折叠，不展开则 data-tool-call-id 节点数量对不上
      // 选择器只点 data-history-open 为 false 的按钮，已展开的不会被二次触发
      const expandHistory = async () => {
        await ui(
          `document.querySelectorAll('button[data-history-open="false"]').forEach(e => e.click())`,
        );
        await settle();
      };
      // 失败行固定 5 条，id 依次为 2、4、6、7、8，刻意保留时间线中的空洞位
      // 三种终止形态各占一位，isError、status 为 error、status 为 cancelled，锁死覆盖范围
      // 全部标记 fullscreen，用同一批数据同时验证失败不建 App 与失败不抢全屏
      const errors = [
        { id: 2, isError: true, fullscreen: true },
        { id: 4, isError: true, fullscreen: true },
        { id: 6, isError: true, fullscreen: true },
        { id: 7, status: "error", fullscreen: true },
        { id: 8, status: "cancelled", fullscreen: true },
      ];
      // 第一条场景只用失败行，记录要保留，App 与自动侧栏一个都不许出现
      // 行数断言对照 errors.length，防止真实时间线把失败行吞掉
      // 末尾两条 history 断言分别守住 registered 与 read 计数为 0
      await check(
        "all failures: real timeline rows preserve records but create no App or automatic sidebar",
        async () => {
          await ui(`window.setRows(${JSON.stringify(errors)}, true)`);
          await expandHistory();
          assert.equal(
            await ui('document.querySelectorAll("[data-tool-call-id]").length'),
            errors.length,
          );
          assert.deepEqual(await state(), {
            cards: 0,
            placeholders: 0,
            opens: 0,
            sidebar: false,
            views: 0,
            owners: [],
          });
          assert.equal(env.events.history.filter((e) => e.type === "registered").length, 0);
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 0);
        },
      );
      await check("explicit widgetSessionId failures also cannot create App anchors", async () => {
        await ui(
          `window.setRows(${JSON.stringify(errors.map((row) => ({ ...row, widget: true })))}, true)`,
        );
        await expandHistory();
        assert.equal(
          await ui('document.querySelectorAll("[data-tool-call-id]").length'),
          errors.length,
        );
        const s = await state();
        assert.equal(s.cards, 0);
        assert.equal(s.placeholders, 0);
        assert.equal(s.opens, 0);
        assert.equal(s.views, 0);
        assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 0);
      });
      // mixed 是成功与失败的固定交错，1、3、5 成功，2、4、6、7、8 失败
      // 最后一个成功是 row-5，所以 owners 期望恒为 row-5，不接受其他锚点
      // 改这里的顺序等于改断言语义，新增成功行必须同步更新 owners 期望 [权衡]
      const mixed = [{ id: 1 }, errors[0], { id: 3 }, errors[1], { id: 5 }, ...errors.slice(2)];
      // 先挂 did-attach-webview 监听再注入行，避免事件在 await 之前就触发丢帧 [并发]
      // 只等一次，因为本批次期望恰好一个 guest，多开会在此后的计数断言中暴露
      const attached = new Promise<void>((resolve) =>
        win.webContents.once("did-attach-webview", () => resolve()),
      );
      await ui(`window.setRows(${JSON.stringify(mixed)})`);
      await attached;
      await ui("window.waitRowsRunning()");
      await page("window.fixtureReady");
      await expandHistory();
      // guestId 是全流程唯一身份基准，后续每处 guest 断言都引用它 [资源]
      // 只取一次而不每轮重取，才能真正验证复用同一个 guest，而不是总能拿到某个 guest
      const guestId = env.guests.get(win.webContents.id)!.id;
      // 首轮成功场景同时确认四件事，一张卡片、一个视图、零侧栏、锚点 row-5
      // 随后点计数器，验证页面内 React 状态不受行增删影响
      await check(
        "success plus three MCP errors, transport error and cancellation leaves one latest-success anchor",
        async () => {
          const s = await state();
          assert.equal(s.cards, 1);
          assert.equal(s.views, 1);
          assert.equal(s.opens, 0);
          assert.deepEqual(s.owners, ["row-5"]);
          await showCard();
          assert.equal(
            await ui('document.querySelectorAll("[data-tool-call-id]").length'),
            mixed.length,
          );
          await page("document.getElementById('counter').click()");
          await page("new Promise(r => requestAnimationFrame(r))");
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
        },
      );
      const started = performance.now();
      // 20 轮开关是稳定性压测，每轮都必须回到卡片 1、占位 0 的同一稳态
      // 循环内每轮比对 guestId，任何一次重建都会在这里被抓住 [资源]
      // 结束后 registered、read、subscribed 都应为 1，说明页面只初始化一次
      await check(
        "20 real row-button inline/sidebar round trips keep one guest, one anchor and React state",
        async () => {
          // 20 轮压测次数固定，循环只做开关与读状态，不新增行以隔离变量
          for (let i = 0; i < 20; i++) {
            await ui(`document.querySelector('[data-testid="plugin-ui-open-side-pane"]').click()`);
            await settle();
            let s = await state();
            assert.equal(s.cards, 0);
            assert.equal(s.placeholders, 1);
            assert.equal(s.views, 1);
            assert.deepEqual(s.owners, ["row-5"]);
            await ui("document.getElementById('close-sidebar').click()");
            await settle();
            s = await state();
            assert.equal(s.cards, 1);
            assert.equal(s.placeholders, 0);
            await showCard();
            assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          }
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
          assert.equal(await page("window.starts"), 1);
          assert.equal(env.events.history.filter((e) => e.type === "registered").length, 1);
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 1);
          assert.equal(env.events.history.filter((e) => e.type === "subscribed").length, 1);
        },
      );
      const switchesMs = performance.now() - started;
      // 先卸载再挂载时间线，模拟会话切换，状态必须仍停在 row-5
      // 追加的 id 9 失败行不得抢走已有成功页，这是全屏归属的核心回归
      await check(
        "timeline unmount/remount and later error preserve the good page without fullscreen stealing",
        async () => {
          await ui("window.mountRows(false)");
          await ui("window.mountRows(true)");
          await expandHistory();
          await ui(
            `window.setRows(${JSON.stringify([...mixed, { id: 9, isError: true, fullscreen: true }])})`,
          );
          await expandHistory();
          const s = await state();
          assert.equal(s.opens, 20);
          assert.equal(s.cards, 1);
          assert.deepEqual(s.owners, ["row-5"]);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
        },
      );
      // 新的全屏成功行 id 10 应自动打开一次，opens 加一且锚点换成 row-10
      // 关闭后重查 owners，确认关闭既不回收页面也不重置锚点
      await check(
        "new successful fullscreen result still opens once and reuses the existing page",
        async () => {
          await ui(`window.setRows(${JSON.stringify([...mixed, { id: 10, fullscreen: true }])})`);
          await settle();
          const s = await state();
          assert.equal(s.opens, 21);
          assert.equal(s.placeholders, 1);
          assert.deepEqual(s.owners, ["row-10"]);
          await ui("document.getElementById('close-sidebar').click()");
          await settle();
          assert.deepEqual((await state()).owners, ["row-10"]);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 1);
          assert.equal(env.events.history.filter((e) => e.type === "registered").length, 1);
        },
      );
      await check(
        "closed fullscreen call stays closed after session view unmount and remount",
        async () => {
          const opens = (await state()).opens;
          await ui("window.mountRows(false)");
          await ui("window.mountRows(true)");
          assert.equal((await state()).sidebar, false);
          assert.equal((await state()).opens, opens);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          await openRow();
          assert.equal((await state()).sidebar, true);
          assert.equal((await state()).opens, opens + 1);
        },
      );
      // 侧栏开着时到达的 row 11 算已消费，卸载重挂后既不开栏也不加计数
      // row 12 才重新打开，这一步区分状态驻留与每次新行都弹窗
      await check(
        "calls arriving in an open sidebar are consumed; later new calls still open",
        async () => {
          await ui(`window.setRows(${JSON.stringify([...mixed, { id: 11, fullscreen: true }])})`);
          const opens = (await state()).opens;
          await closeSidebar();
          await ui("window.mountRows(false)");
          await ui("window.mountRows(true)");
          assert.equal((await state()).sidebar, false);
          assert.equal((await state()).opens, opens);
          await ui(`window.setRows(${JSON.stringify([...mixed, { id: 12, fullscreen: true }])})`);
          assert.equal((await state()).sidebar, true);
          assert.equal((await state()).opens, opens + 1);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          await closeSidebar();
        },
      );
      await showCard();
      // 截图前再 showCard 一次，保证图里是可见卡片而不是折叠行
      // 截图与结果 JSON 都写到 root，产物路径固定，便于外部脚本收集
      // checks 顺序即执行顺序，失败时可据此定位停在哪条场景
      await writeFile(join(root, "rows-inline.png"), (await win.webContents.capturePage()).toPNG());
      await writeFile(
        join(root, "rows-results.json"),
        JSON.stringify({ checks, switchesMs, guestId, state: await state() }, null, 2),
      );
    } finally {
      await env.close();
    }
    // [资源] 正常路径显式退出，防止 Electron 主进程因残留句柄挂起
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
