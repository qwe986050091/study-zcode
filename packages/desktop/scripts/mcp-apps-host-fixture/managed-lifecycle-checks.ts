// 模块职责：宿主 fixture 的 managed 生命周期验收用例，按场景顺序驱动 Electron 窗口、guest 渲染进程与 agent 事件流。
// 边界：只通过渲染进程暴露的 fixture 接口与 env.agent 事件流断言观察状态，不直接读写主进程内部数据结构。
// 依赖：retry 依赖 events.history 偏移量定位事件，checkLate 承接后续场景，scope 为实例校验提供身份参数。
// 失败策略：任一断言失败即中断整个 checkLifecycle 序列；场景之间用事件偏移量保持互不干扰。
// INV-01 重试必须在同一 guest 上重建单页并恢复 running 相位；守住位置：retry；改错故障：页面白屏且后续场景全部超时。
// INV-02 feed 去重后 40 次双向切换仍只产生 40 条独立结果且 input 与 result 相等；守住位置：production feed 场景的 for 循环；改错故障：订阅重复导致 UI 闪烁并重复渲染。
// INV-03 handle 的 sandboxId 在 80 次位置切换后保持不变；守住位置：production feed 场景的 after 断言；改错故障：sandbox 被重建，宿主侧实例引用全部失效。
// INV-04 listeners.ports 与 listeners.frame 恒为 1；守住位置：production feed 场景末断言；改错故障：端口或 frame 监听泄漏导致消息重复投递。
// INV-05 read 事件计数在位置切换前后相等；守住位置：reads 快照对比；改错故障：每次切换都重新读取资源，放大 IPC 与磁盘压力。
// INV-06 页面交互状态不因 feed 重建而重置；守住位置：counter 与 scroll 的 deepEqual 快照；改错故障：用户滚动位置与输入状态丢失。
// INV-07 512K widget 快照在 idle 过期后必须原样保留；守住位置：idle MCP page 场景；改错故障：大快照被截断或反序列化成空对象。
// INV-08 idle 页面不得因 offscreen 过期触发重建；守住位置：expireOffscreen 分支；改错故障：无交互页面被反复销毁重建，持续占用 CPU。
// INV-09 guest 实例在 idle 场景中保持同一引用；守住位置：guest 引用与 countGuests 比较；改错故障：身份漂移使旧监听残留在废弃进程上。
// INV-10 渲染进程崩溃后旧 credential 必须被吊销；守住位置：real guest renderer crash 场景；改错故障：失效 token 仍可调用工具，越权访问实例。
// INV-11 崩溃恢复只允许重建一个 guest 且 ports 监听恢复为 1；守住位置：countGuests 与 listeners.ports 断言；改错故障：孤儿渲染进程堆积并重复订阅。
// INV-12 web 与 remote 平台不得注册或订阅 managed 资源；守住位置：Web and remote 场景的事件切片；改错故障：不支持平台出现幽灵监听与假成功。
// INV-13 每轮 fallback 窗口必须销毁且 guest 总数保持 1；守住位置：fallback.destroy 与 countGuests；改错故障：窗口与渲染进程泄漏。
// INV-14 两个 managed 窗口共享存储但 widget 快照彼此隔离；守住位置：two managed windows 场景；改错故障：一个窗口的 widget 覆盖另一个，用户数据串台。
// INV-15 indexedDB 升级阻塞期间订阅与通知仍能送达双方；守住位置：upgradeBlocked 与 upgradeDone 分支；改错故障：阻塞连接导致资源更新丢失。
// INV-16 关闭第二个窗口后第一个窗口的 frame 监听恒为 1；守住位置：second.destroy 之后的 waitResources 断言；改错故障：销毁对端时误清共享订阅。
// INV-17 工具删除期间到达的迟到审批不得再执行工具；守住位置：task deletion 场景；改错故障：已删除任务仍被写入，产生幻影记录。
// INV-18 clear data 期间注册必须被拒绝且所有 guest 与 frame 失效；守住位置：clearBrowserData 分支；改错故障：清理中新建实例，数据残留跨越账号。
// INV-19 全量清理必须在真实 unsubscribed ACK 到达后才判定成功；守住位置：full cleanup 场景的 events.wait；改错故障：本地已释放但远端仍推送，跨进程完成顺序造成误报通过。
import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
import { checkLate } from "./managed-late-checks.js";
// [边界] 把 managedEnvironment 的返回值整体别名为 Environment，避免逐字段重复声明
// [权衡] 测试复用生产 probe 的返回结构，产出端字段变更会在此立即暴露类型漂移
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
// [职责] 按固定顺序串行执行 managed 生命周期的全部验收场景，任一断言失败即中断后续
// [并发] 场景之间不做并行，因为 guest、窗口与审批队列都指向同一份宿主状态
// [约定] 每个场景经 check 回调包装，失败时用场景名称定位而不是裸行号
export async function checkLifecycle(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  // [边界] ui 面向宿主窗口的 webContents，page 面向 managed guest 的 fixture 页面
  // [失败路径] 两者都返回 Promise，脚本异常会原样冒泡到场景回调并中止当前场景
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  const page = (code: string) => env.evalPage(win, code);
  // [时序] 先记录事件偏移再触发重试，只等待偏移之后的 running 相位，避免命中历史事件
  // [资源] 重试后必须等待 fixtureReady，确保新页面脚本就绪再继续断言
  // [失败路径] guest 未恢复到 running 时 wait 会超时，用例以超时而非断言错误失败
  async function retry() {
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait(
      (e) => e.type === "phase" && e.phase === "running" && e.owner === win.webContents.id,
      offset,
    );
    await page("window.fixtureReady");
  }
  // [前置] 首个场景开始前先做一次干净重试，让基线 guest 与端口监听处于已知状态
  // [权衡] 这一步顺带覆盖初次启动路径，后续场景无需各自处理冷启动差异
  await retry();
  await checkLate(env, win, scope, check);
  await check(
    "production feed deduplication and 80 position switches preserve guest, ports and resource count",
    async () => {
      // [基线] initial 保存切换前的 handle 与监听快照，作为去重与保活的不变量参照
      // [约束] 该快照只读，不得就地修改，否则后续比较会退化为自我满足
      const initial = await ui("window.managedState()");
      const reads = env.agent.events.history.filter((e) => e.type === "read").length;
      await page(
        "document.querySelector('#counter').click(); document.querySelector('#scroll').scrollTop=123",
      );
      // [并发] 每轮先切到 anchor 态并等 feed，再切回另一态，保证两条订阅路径都被覆盖
      // [时序] waitFeed 按序号匹配，防止跨轮次串读上一轮遗留消息
      // [失败路径] 某轮订阅丢失时 waitFeed 超时而非返回空数组，可区分丢失与空结果
      for (let n = 0; n < 40; n++) {
        await ui(`window.setAnchors(true, true, ${n})`);
        await page(`window.waitFeed(${n})`);
        await ui(`window.setAnchors(true, false, ${n})`);
      }
      // [不变量] after 相对 initial 的差异只应出现在预期字段，其余变化都视为状态污染
      // [边界] 断言基于渲染进程回传的 managedState，而不是主进程侧的推测值
      const after = await ui("window.managedState()");
      const feed = await page("window.receivedFeed");
      assert.deepEqual(
        feed.result,
        Array.from({ length: 40 }, (_, i) => i),
      );
      assert.deepEqual(feed.input, feed.result);
      assert.equal(after.handle.sandboxId, initial.handle.sandboxId);
      // [资源] 端口监听恒为 1 说明多次切换没叠加重复订阅，也没吞掉唯一订阅
      // [失败路径] 计数为 0 通常是重建时漏订阅，大于 1 则是退订未真正生效
      assert.equal(after.listeners.ports, 1);
      assert.equal(after.listeners.frame, 1);
      assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, reads);
      assert.deepEqual(
        await page(
          "({ count: document.querySelector('#counter').textContent, scroll: document.querySelector('#scroll').scrollTop, starts:window.starts })",
        ),
        { count: "1", scroll: 123, starts: 1 },
      );
    },
  );
  await check(
    "idle MCP page preserves large widget snapshot and unsaved page state without reconstruction",
    async () => {
      await page(
        "window.saveWidget({text:'x'.repeat(512*1024), nested:[null,1,false,{value:'safe'}]})",
      );
      // [前置] 先关闭两组 anchor 让页面进入 idle 候选，过期观察才有意义
      // [时序] 关闭 anchor 与 expireOffscreen 之间不插入其他通知，否则中间态不可解释
      await ui("window.setAnchors(false,false)");
      const guest = env.guests.get(win.webContents.id)!;
      // [权衡] 直接用 fixture 触发 offscreen 过期，避免等待真实空闲计时器拖慢用例
      // [失败路径] 过期后若仍发生重建，下面的同一 guest 引用断言会立即失败
      await ui("window.expireOffscreen()");
      // [不变量] 返回 false 表示 idle 页面被保留而非被挂起或销毁
      // [资源] 保留真实渲染进程，512K 快照无需重新序列化即可继续读取
      // [失败路径] 返回 true 说明空闲判定误伤活页面，会带走未保存的页面状态
      assert.equal(await ui("window.suspendManaged()"), false);
      await ui("window.setAnchors(true,false)");
      assert.equal(env.guests.get(win.webContents.id), guest);
      await page("window.fixtureReady");
      const snapshot = (await ui("window.managedState()")).widget;
      assert.equal(snapshot.text.length, 512 * 1024);
      assert.deepEqual(snapshot.nested, [null, 1, false, { value: "safe" }]);
      assert.equal(await page("document.querySelector('#counter').textContent"), "1");
      await page("window.saveWidget(null)");
      assert.equal((await ui("window.managedState()")).widget, null);
    },
  );
  await check(
    "real guest renderer crash revokes old credential and retry reconstructs one page",
    async () => {
      const old = env.handles.get(win.webContents.id).instance;
      const guest = env.guests.get(win.webContents.id)!;
      const offset = env.events.history.length;
      // [并发] 先发起等待再触发崩溃，保证订阅先于事件到达，不漏掉瞬时 error 相位
      // [失败路径] 该 Promise 永不落地时整场景超时，可区分崩溃未上报与上报延迟
      const failed = ui("window.waitManagedPhase('error')");
      // [故障注入] 用真实渲染进程崩溃而非模拟事件，覆盖 Chromium 侧进程消失的完整路径
      // [时序] 崩溃前先挂上 error 相位等待，避免恢复过快导致断言错过中间态
      // [资源] 崩溃会留下不可用的 handle 与端口，必须由后续重试路径统一回收
      guest.forcefullyCrashRenderer();
      await failed;
      await env.events.wait(
        (e) =>
          e.type === "bridge" && e.method === "closeInstance" && e.owner === win.webContents.id,
        offset,
      );
      // [安全] 旧实例 token 在崩溃后必须被拒绝，验证吊销不是仅改本地标记
      // [失败路径] 若调用成功，说明校验仍信任失效 credential，构成越权风险
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: old }),
      );
      await retry();
      assert.notEqual(env.handles.get(win.webContents.id).instance.token, old.token);
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
  await check(
    "Web and remote platform adapters keep fallback without sandbox or conversation lease",
    async () => {
      // [边界] web 与 remote 平台应走 fallback 通道，不具备 managed 能力
      // [不变量] 两者 supported 为 false、views 为 0，事件流中不得出现注册或订阅
      // [失败路径] 一旦出现 registered 或 subscribed，说明能力判定泄漏到不支持平台
      for (const mode of ["web", "remote"]) {
        const offset = env.events.history.length;
        const fallback = await env.createWindow(scope, mode);
        const state = await fallback.webContents.executeJavaScript("window.managedState()");
        assert.equal(state.supported, false);
        assert.equal(state.views, 0);
        assert.equal(
          env.events.history
            .slice(offset)
            .some((e) => e.type === "registered" || e.type === "subscribed"),
          false,
        );
        // [资源] 每轮 fallback 窗口必须显式销毁，否则残留窗口会污染后续 countGuests 断言
        // [时序] 销毁完成后再进入下一轮，避免两个平台的窗口生命周期重叠
        fallback.destroy();
      }
      assert.equal(env.countGuests(), 1);
    },
  );
  await check(
    "two managed windows share browser storage but isolate widget snapshots and resource feeds",
    async () => {
      // [前置] 第二个 managed 窗口共享同一 scope，用于验证多窗口下的隔离与共享边界
      // [并发] 两窗口页面脚本各自独立执行，断言需分别取各自的 evalPage 结果
      const second = await env.createWindow(scope);
      const other = (code: string) => env.evalPage(second, code);
      await page("window.saveWidget({window:1}); window.storageRoundTrip(true)");
      // [不变量] widget 快照按窗口隔离，第二个窗口读不到第一个窗口保存的内容
      // [权衡] localStorage 与 indexedDB 仍按源共享，这是产品期望的会话级共享语义
      // [失败路径] 若读出非 null，说明快照落到了共享存储而非窗口私有区域
      assert.equal(await other("window.readWidget()"), null);
      assert.deepEqual(await other("window.storageRoundTrip(false)"), { local: "42", indexed: 42 });
      await other(
        "new Promise(resolve => { const r=indexedDB.open('host-fixture'); r.onsuccess=()=>{window.heldDb=r.result; resolve();}; })",
      );
      await page(
        "window.upgradeBlocked=Promise.withResolvers(); window.upgradeDone=Promise.withResolvers(); const upgrade=indexedDB.open('host-fixture',2); upgrade.onblocked=()=>window.upgradeBlocked.resolve(); upgrade.onupgradeneeded=()=>upgrade.result.createObjectStore('v2'); upgrade.onsuccess=()=>{upgrade.result.close(); window.upgradeDone.resolve();}; upgrade.onerror=()=>window.upgradeDone.reject(upgrade.error); true",
      );
      // [并发] 先用 heldDb 占住旧版本连接，让升级进入 blocked，构造可控的阻塞窗口
      // [失败路径] blocked 未触发说明连接未真正持有，后续并发订阅断言即失去意义
      await page("window.upgradeBlocked.promise");
      await Promise.all([page("window.subscribeFixture()"), other("window.subscribeFixture()")]);
      env.agent.notify("managed", "fixture://state");
      await Promise.all([page("window.waitResources(1)"), other("window.waitResources(1)")]);
      await other("window.heldDb.close()");
      await page("window.upgradeDone.promise");
      assert.deepEqual(await other("window.storageRoundTrip(false)"), { local: "42", indexed: 42 });
      const active = env.guests.get(win.webContents.id)!;
      const dead = env.guests.get(second.webContents.id)!;
      // [资源] 以 destroyed 事件作为销毁完成信号，而不是依赖固定延时
      // [时序] 先建立等待再调用 destroy，避免事件早于订阅造成永久挂起
      // [不变量] 第二个窗口销毁后第一个窗口的 frame 监听仍为 1，共享订阅不受牵连
      const stopped = new Promise<void>((resolve) => dead.once("destroyed", resolve));
      second.destroy();
      await stopped;
      assert.equal(active.isDestroyed(), false);
      env.agent.notify("managed", "fixture://state");
      await page("window.waitResources(2)");
      assert.equal((await ui("window.managedState()")).listeners.frame, 1);
    },
  );
  await check(
    "task deletion during approval removes page, snapshot and task listener before late allow",
    async () => {
      // [时序] 先发起工具调用并捕获异常，再从审批队列取待处理项，保证调用与审批不竞态
      // [故障注入] 审批挂起期间移除任务并等 guest 销毁，模拟目标在决策前消失
      // [失败路径] 迟到放行不得让工具进入 executed，否则产生无主任务记录
      const result = page("window.callTool('task-delete')").catch((error) => ({
        error: String(error),
      }));
      const pending = await env.agent.approvals.wait((r) => r.params.input?.key === "task-delete");
      const guest = env.guests.get(win.webContents.id)!;
      const stopped = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      await ui("window.setAnchors(false,false); window.removeTask()");
      await stopped;
      // [事务] 放行是对已消失目标的迟到决策，必须整体失败而不是部分生效
      // [不变量] 放行后 widget 为 undefined，task 与 ports 监听均归零
      // [失败路径] 若事件流出现 executed，说明删除与放行缺少统一的所有者校验
      await env.agent.respond(pending, "allow");
      assert.ok((await result).error);
      const state = await ui("window.managedState()");
      assert.equal(state.widget, undefined);
      assert.equal(state.listeners.task, 0);
      assert.equal(state.listeners.ports, 0);
      assert.equal(
        env.agent.events.history.some((e) => e.type === "executed" && e.key === "task-delete"),
        false,
      );
    },
  );
  await check(
    "clear data seals registration and cancels live tool before discarding multi-window storage",
    async () => {
      const offset = env.events.history.length;
      await ui("window.setAnchors(true,false)");
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await page("window.fixtureReady");
      const second = await env.createWindow(scope);
      await page("window.storageRoundTrip(true)");
      const guest = env.guests.get(win.webContents.id)!;
      const frame = guest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
      const active = page("window.callTool('clear-running',true)").catch((error) => ({
        error: String(error),
      }));
      await env.agent.respond(
        await env.agent.approvals.wait((r) => r.params.input?.key === "clear-running"),
        "allow",
      );
      await env.agent.events.wait((e) => e.type === "executed" && e.key === "clear-running");
      const waiting = env
        .evalPage(second, "window.callTool('clear-approval')")
        .catch((error) => ({ error: String(error) }));
      const permission = await env.agent.approvals.wait(
        (r) => r.params.input?.key === "clear-approval",
      );
      await Promise.all([
        page("window.startStorageWriter()"),
        env.evalPage(second, "window.startStorageWriter()"),
      ]);
      const clearing = env.native.clearBrowserData();
      assert.throws(() => env.native.registerFromHost({} as never), /being cleared/);
      await clearing;
      assert.equal(frame.isDestroyed(), true);
      assert.equal(env.countGuests(), 0);
      assert.ok((await active).error);
      assert.ok((await waiting).error);
      await env.agent.respond(permission, "allow");
      await env.agent.events.wait((e) => e.type === "cancelled" && e.key === "clear-running");
      env.agent.release("managed", "clear-running");
      assert.equal(
        env.agent.events.history.some((e) => e.type === "executed" && e.key === "clear-approval"),
        false,
      );
    },
  );
  await check(
    "full cleanup releases production subscriptions after existing keep-warm deadline",
    async () => {
      const active = env.windows.filter((w) => !w.isDestroyed());
      const offset = env.events.history.length;
      for (const owner of active)
        await owner.webContents.executeJavaScript(
          "window.setAnchors(false,false).then(() => window.clearManaged())",
        );
      await Promise.all(
        active.map((owner) =>
          owner.webContents.executeJavaScript("window.waitConnectionsReleased()"),
        ),
      );
      for (const owner of active)
        assert.ok(
          Object.values(
            (await owner.webContents.executeJavaScript("window.managedState()")).listeners,
          ).every((count) => count === 0),
        );
      assert.equal(env.countGuests(), 0);
      // Renderer 释放本地监听不代表异步退订 RPC 已应答；等待真实 ACK，避免跨进程完成顺序造成误报。
      await Promise.all(
        active.map((owner) =>
          env.events.wait(
            (event) => event.type === "unsubscribed" && event.owner === owner.webContents.id,
            offset,
          ),
        ),
      );
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "unsubscribed").length,
        active.length,
      );
    },
  );
}
