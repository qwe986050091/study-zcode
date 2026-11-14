// INV-01 [顺序] 本函数只向 harness 登记用例而不自行断言；守住位置：每一处 await check 的 name 与 run 组合；改错故障：检查在登记阶段就执行，失败无法归属到用例名。
// INV-02 [边界] 环境由调用方注入，夹具不另外创建 Host；守住位置：env、win、scope 三个形参与 Environment 类型别名；改错故障：自建环境绕过真实 SDK 链路，集成缺陷测不出来。
// INV-03 [边界] 两套求值通道按对象严格分工；守住位置：ui 闭包的 executeJavaScript 与 page 闭包的 evalPage；改错故障：把宿主代码送进访客页面，断言对象错位后结论失真。
// INV-04 [并发] 资源通知代数只增不复用；守住位置：let updates 与 notification 内 ++updates 的模板插值；改错故障：代数回退使 waitResources 立即返回，读到上一轮事件。
// INV-05 [并发] 订阅去重由 SDK、Agent 与 MCP 真实链路承担；守住位置：首个用例对 resources/subscribe 计数为 1 与 resourceEvents 单元素断言；改错故障：重复订阅被接受，去重回归漏检。
// INV-06 [并发] 挂起审批必须跨锚点反复卸载存活；守住位置：第二个用例六次 setAnchors 交替与 busy 为 true 的断言；改错故障：卸载即取消审批，工具结果与授权双双丢失。
// INV-07 [资源] 重挂载不得重建沙箱或换访客；守住位置：after 与 before 的 sandboxId 比较、guests 映射的 id 比较；改错故障：每次挂载新建 guest，widget、端口与订阅全部重置。
// INV-08 [资源] 监听器与订阅各只登记一次；守住位置：listeners.frame 为 1、env.events 中 subscribed 为 1、Agent 事件中 read 为 1；改错故障：重复挂监听，事件成倍触发并积压回调。
// INV-09 [状态] 快照归宿主内存而非访客重建；守住位置：widget 深比较 {managed:7} 与 guest 未重建时的 fixtureReady 注释；改错故障：指望 hostContext 重发恢复，重试后数据变空。
// INV-10 [失败路径] 扩展名白名单必须在真实链路上拦截；守住位置：unsupported.bin 对 /application\/x-msdownload.*not allowed/ 的匹配；改错故障：放行可执行附件，或断言绑到已移除字段上空转。
// INV-11 [失败路径] 一次非法读取不得污染页面运行态；守住位置：拒绝之后 managedState 的 phase 仍为 running；改错故障：4xx 把页面打成 error，后续用例连环失败。
// INV-12 [资源] 三类资源各只读一次；守住位置：第三个用例对 pdf、bin、svg 分别按 uri 过滤 read 计数；改错故障：重试或重放造成重复读，掩盖缓存与去重退化。
// INV-13 [事务] 后台任务的释放晚于卸载与过期；守住位置：release 调用位于 expireOffscreen 之后、suspendManaged 之前；改错故障：提前释放让结果与保留期断言错位。
// INV-14 [资源] 保留期内页面与访客都不可回收；守住位置：isDestroyed 为 false、countGuests 为 1、suspendManaged 返回 false；改错故障：空闲回收销毁仍在跑的会话页。
// INV-15 [事务] retry 只清瞬时 widgetState；守住位置：readWidget 为 null 与 storageRoundTrip(false) 的 local、indexed 断言；改错故障：连带清掉持久存储，用户草稿丢失。
// INV-16 [顺序] 事件游标必须在动作前采样；守住位置：offset 取 history.length 后作为 wait 第二个参数；改错故障：游标晚取会命中旧 phase，等待立即通过形成假绿。
// INV-17 [资源] 内嵌页滚动不得出现帧延迟位移；守住位置：样本逐项小于 1 的断言与双 requestAnimationFrame 采样；改错故障：容忍布局抖动，滚动容器错位回归漏检。
// INV-18 [失败路径] 运行时销毁后晚到授权必须拒绝；守住位置：respond 之后 executed 为 0、phase 为 error、uiValidateInstance 调用被 rejects；改错故障：幽灵工具调用被执行，权限边界被穿透。
//
// 模块职责：MCP Apps 宿主夹具的校验编排，用注入的 check 把订阅去重、审批存续、MIME 守卫、保留期、重试与运行时销毁串成有序用例。
// 状态所有权：env 与 win 由夹具创建并持有，本模块只读取事件历史、访客映射与页面状态；updates 是本模块唯一的本地计数器。
// 阅读顺序：先看四个注入 helper，再按登记顺序看订阅、审批、MIME、保留期、重试、滚动，checkModel 插在滚动与运行时用例之间。
import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
import { checkModel } from "./managed-model-checks.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkManaged(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  // [边界] ui 固定走 webContents 求值，面向宿主渲染进程；page 固定走 evalPage，面向夹具访客页，二者不互换。
  // [契约] approval 以 params.input.key 作为唯一匹配键；键写错会永久等待，直到用例超时才暴露。
  // [契约] executed 只统计类型为 executed 且 key 相等的历史条目，等价于该工具恰好成功一次的探针。
  // [并发] updates 从 0 起递增并前置自增，保证每次通知请求的代数严格大于上一轮。
  // [失败路径] notification 先发状态变更再等资源计数，顺序反了会去等待已经到达的事件而空转。
  // [权衡] helper 全部是无状态闭包，仅有 updates 留存；避免 helper 自身变成第二个事实来源。
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  const page = (code: string) => env.evalPage(win, code);
  const approval = (key: string) => env.agent.approvals.wait((r) => r.params.input?.key === key);
  const executed = (key: string) =>
    env.agent.events.history.filter((e) => e.type === "executed" && e.key === key).length;
  let updates = 0;
  async function notification() {
    env.agent.notify("managed", "fixture://state");
    await page(`window.waitResources(${++updates})`);
  }
  // [并发] 两次订阅并发发起，断言真实链路只产生一次 resources/subscribe，即 SDK 侧去重生效。
  // [并发] resourceEvents 深比较为单元素数组，说明同一次通知只投递一次，不按订阅者数量放大。
  // [顺序] 订阅完成后才触发 notification，确保计数器代数与首次投递一一对应。
  // [失败路径] 若去重失效，这里先出现计数为 2 的失败，而不是拖到页面侧表现为重复刷新。
  // [权衡] 用例只覆盖订阅与投递两条最窄路径，把重连与取消留给 Agent 侧单测，夹具不承担过多语义。
  await check("resource subscriptions deduplicate through SDK, real Agent and MCP", async () => {
    await page("Promise.all([window.subscribeFixture(), window.subscribeFixture()])");
    assert.equal(
      env.agent.events.history.filter((e) => e.type === "resources/subscribe").length,
      1,
    );
    await notification();
    assert.deepEqual(await page("window.resourceEvents"), ["fixture://state"]);
  });
  await check(
    "pending approval survives React inline unmount and keeps real resource feed in sidebar",
    async () => {
      const guest = env.guests.get(win.webContents.id)!;
      const before = await ui("window.managedState()");
      await page("window.saveWidget({managed:7})");
      // [并发] 该调用故意不 await，先挂起为 promise，再等待审批请求，模拟用户点击前的空窗。
      // [并发] 六次 setAnchors 交替内嵌与侧栏形态，每次后接通知，验证审批不随 React 内联卸载被取消。
      // [资源] 收尾一次 setAnchors(false, true) 固定到侧栏，再用 busy 为 true 证明审批仍在等待而非被丢弃。
      // [事务] respond 放行后才断言 result 有值且 executed 为 1，保证授权与执行各发生一次。
      // [资源] sandboxId 与访客 id 前后一致，说明重挂载复用了同一沙箱，没有重建运行时。
      // [资源] listeners.frame、subscribed、read 三个 1 共同约束只注册一次，任一变成 2 都是泄漏信号。
      const result = page("window.callTool('managed-approval')");
      const request = await approval("managed-approval");
      for (let n = 0; n < 6; n++) {
        await ui(`window.setAnchors(true, ${n % 2 === 0})`);
        await notification();
      }
      await ui("window.setAnchors(false, true)");
      await notification();
      assert.equal((await ui("window.managedState()")).busy, true);
      await env.agent.respond(request, "allow");
      assert.ok((await result).result);
      assert.equal(executed("managed-approval"), 1);
      const after = await ui("window.managedState()");
      assert.equal(after.handle.sandboxId, before.handle.sandboxId);
      assert.equal(env.guests.get(win.webContents.id)!.id, guest.id);
      assert.deepEqual(after.widget, { managed: 7 });
      assert.equal(after.listeners.frame, 1);
      assert.equal(env.events.history.filter((e) => e.type === "subscribed").length, 1);
      assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 1);
    },
  );
  await check(
    "PDF and SVG resources cross the real SDK, Agent and MCP with MIME guards intact",
    async () => {
      // [契约] PDF 断言同时锁定 uri、mimeType 与 base64 blob，三者任一漂移都视为跨链路破坏。
      // [失败路径] 非法扩展名走 error 分支，只匹配 message 片段；测试 IPC 丢弃结构化 reason，细节归 Agent 单测。
      // [失败路径] 拒绝原因固定为 application/x-msdownload 不允许，改成通配会放过其他可执行类型。
      // [契约] SVG 以 image/svg+xml 与内联 text 返回，验证文本类资源不走 blob 通道。
      // [失败路径] 读取被拒后 phase 仍为 running，页面未被打成 error，后续用例可继续。
      // [资源] 三种 uri 的 read 计数都为 1，说明没有因为重试或回退路径重复读取。
      const pdfUri = "fixture://document.pdf";
      const pdf = await page(`window.readResourceFixture(${JSON.stringify(pdfUri)})`);
      assert.deepEqual(
        pdf.result?.contents,
        [
          {
            uri: pdfUri,
            mimeType: "application/pdf",
            blob: Buffer.from("%PDF-1.7\n%%EOF\n").toString("base64"),
          },
        ],
        JSON.stringify(pdf),
      );
      const rejected = await page("window.readResourceFixture('fixture://unsupported.bin')");
      // 测试 IPC 的异常只保留 message，页面侧核对拒绝原因；结构化 reason 由 Agent 单测覆盖。
      assert.match(rejected.error ?? "", /application\/x-msdownload.*not allowed/);
      const svg = await page("window.readResourceFixture('fixture://vector.svg')");
      assert.deepEqual(
        svg.result?.contents,
        [
          {
            uri: "fixture://vector.svg",
            mimeType: "image/svg+xml",
            text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
          },
        ],
        JSON.stringify(svg),
      );
      assert.equal((await ui("window.managedState()")).phase, "running");
      for (const uri of [pdfUri, "fixture://unsupported.bin", "fixture://vector.svg"]) {
        assert.equal(
          env.agent.events.history.filter((e) => e.type === "read" && e.uri === uri).length,
          1,
        );
      }
    },
  );
  await check(
    "all anchors unmounted plus expired retention keeps MCP guest and resource feed after completion",
    async () => {
      // [顺序] step 只发阶段事件，用于失败时回放卡在哪一步，不参与任何断言判定。
      // [事务] 工具运行中先卸载全部锚点，再触发过期，验证保留期优先于锚点可见性。
      // [资源] 过期后访客未销毁且 countGuests 为 1，说明后台任务仍持有页面。
      // [事务] release 放在过期之后，模拟任务真正结束；提前释放会让后续保留断言失去意义。
      // [资源] suspendManaged 返回 false 表示运行期不可挂起，不能被当作成功而提前回收。
      // [顺序] 任务结束后再发一次通知，确认空闲态仍保留访客，且 executed 仍为 1。
      const step = (stage: string) => env.events.emit({ type: "retention-step", stage });
      const guest = env.guests.get(win.webContents.id)!;
      const result = page("window.callTool('managed-background', true)");
      await env.agent.respond(await approval("managed-background"), "allow");
      await env.agent.events.wait((e) => e.type === "executed" && e.key === "managed-background");
      step("tool-running");
      await ui("window.setAnchors(false, false)");
      step("anchors-unmounted");
      await notification();
      step("background-notification");
      await ui("window.expireOffscreen()");
      assert.equal(guest.isDestroyed(), false);
      assert.equal(env.countGuests(), 1);
      env.agent.release("managed", "managed-background");
      assert.ok((await result).result);
      step("tool-completed");
      assert.equal(await ui("window.suspendManaged()"), false);
      assert.equal(guest.isDestroyed(), false);
      await notification();
      step("idle-notification");
      assert.equal(env.countGuests(), 1);
      assert.equal(executed("managed-background"), 1);
    },
  );
  await check(
    "production owner retains snapshot and guest after idle and retry clears only widgetState",
    async () => {
      const retained = env.guests.get(win.webContents.id)!;
      await ui("window.setAnchors(true, false)");
      assert.notEqual(
        (await ui("window.managedState()")).actual?.phase,
        "error",
        JSON.stringify(await ui("window.managedState()")),
      );
      assert.equal(env.guests.get(win.webContents.id), retained);
      await page("window.fixtureReady");
      // guest 没有重建，初始化 hostContext 不会重发；保存快照仍由宿主内存 store 持有。
      assert.deepEqual((await ui("window.managedState()")).widget, { managed: 7 });
      // [状态] 侧栏锚点恢复后断言 phase 不为 error，且访客引用未变，确认没有因空闲重建。
      // [状态] widget 仍为 {managed:7}，说明快照留在宿主内存 store，不依赖访客重建时重发 hostContext。
      // [顺序] 先做一次存储往返写入，再采样事件游标，保证 retry 只从这一刻之后判定阶段。
      // [事务] retry 后旧访客 isDestroyed 为 true，新访客接管，证明重试是替换而非就地复活。
      // [事务] readWidget 为 null 表示瞬时 widgetState 被清空，这是重试唯一允许清除的状态。
      // [事务] 持久存储仍是 local 为 42、indexed 为 42，越权清理会在这里立刻暴露。
      await page("window.storageRoundTrip(true)");
      const old = env.guests.get(win.webContents.id)!;
      const offset = env.events.history.length;
      await ui("window.retryManaged()");
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await page("window.fixtureReady");
      assert.equal(old.isDestroyed(), true);
      assert.equal(await page("window.readWidget()"), null);
      assert.deepEqual(await page("window.storageRoundTrip(false)"), { local: "42", indexed: 42 });
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
  await check(
    "inline page stays in the scrolling container without frame-delayed movement",
    async () => {
      await ui("window.setAnchors(true, false)");
      // [资源] 先断言 webview 位于 data-sandbox-page-container 之下，排除页面挂到错误滚动树。
      // [资源] 六个偏移量各采两帧，位移误差都必须小于 1 像素，帧延迟位移会直接超标。
      // [资源] 真实滚动到 900 后 visible 转 false，再把锚点切到侧栏，visible 回到 true 且访客数仍为 1。
      // [顺序] checkModel 在滚动用例之后登记，让宿主渲染验证与模型验证共享同一环境而不交叉污染。
      const samples = await ui(`(async () => {
      const scroller = document.querySelector('#inline-scroll');
      const view = document.querySelector('webview');
      if (!view.closest('[data-sandbox-page-container]')) throw new Error('page outside scroll tree');
      const initial = view.getBoundingClientRect().top + scroller.scrollTop;
      const errors = [];
      for (const offset of [0, 40, 180, 60, 260, 0]) {
        scroller.scrollTop = offset;
        errors.push(Math.abs(view.getBoundingClientRect().top + scroller.scrollTop - initial));
        await new Promise(requestAnimationFrame);
        errors.push(Math.abs(view.getBoundingClientRect().top + scroller.scrollTop - initial));
      }
      return errors;
    })()`);
      assert.ok(
        samples.every((error: number) => error < 1),
        JSON.stringify(samples),
      );
    },
  );
  await check(
    "real scroll observation removes inline visibility while sidebar remains protected",
    async () => {
      await ui(
        "document.querySelector('#inline-scroll').scrollTop = 900; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      assert.equal((await ui("window.managedState()")).visible, false);
      await ui("window.setAnchors(true, true)");
      assert.equal((await ui("window.managedState()")).visible, true);
      await ui("window.expireOffscreen()");
      assert.equal(env.countGuests(), 1);
    },
  );
  await checkModel(env, win, scope, check);
  await check(
    "runtime unavailable during approval releases page and rejects late permission",
    async () => {
      const guest = env.guests.get(win.webContents.id)!;
      const result = page("window.callTool('managed-runtime')").catch((error) => ({
        error: String(error),
      }));
      const request = await approval("managed-runtime");
      // [失败路径] 调用侧先把页面 promise 收敛为 error 值，避免销毁引发的未处理拒绝掩盖真正断言。
      // [失败路径] 等 destroyed 事件而非固定延时，确认运行时确实下线后才放行晚到授权。
      // [失败路径] 放行后 executed 为 0、phase 为 error，且实例校验被拒绝，三条一起封死幽灵执行。
      const stopped = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      await ui("window.runtimeUnavailable()");
      await stopped;
      assert.ok((await result).error);
      await env.agent.respond(request, "allow");
      assert.equal(executed("managed-runtime"), 0);
      assert.equal((await ui("window.managedState()")).phase, "error");
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", {
          ...scope,
          instance: env.handles.get(win.webContents.id).instance,
        }),
      );
    },
  );
}
