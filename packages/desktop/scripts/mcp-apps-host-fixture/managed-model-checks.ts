// INV-01 页面调用一律通过注入的求值函数执行：守住位置 ui 与 page 两个包装；改错故障 在 Node 侧直接触碰页面对象。
// INV-02 每条命令都携带新的命令标识：守住位置 command 构造；改错故障 重放场景被误判为重复命令。
// INV-03 命令必须声明客户端、会话与签发时间：守住位置 命令载荷；改错故障 服务端拒绝或串会话。
// INV-04 权限等待以输入键匹配：守住位置 permission；改错故障 并发任务拿到彼此的审批。
// INV-05 终止事件等待必须带起始偏移：守住位置 terminal；改错故障 读到上一轮的历史终止事件。
// INV-06 每次开始前记录通知历史长度：守住位置 begin；改错故障 断言命中旧帧。
// INV-07 发送文本必须携带模型选择与构建模式：守住位置 begin 的命令载荷；改错故障 模型回退到默认。
// INV-08 发送回执必须为已接受才继续：守住位置 begin 的断言；改错故障 后续等待在错误前提上超时。
// INV-09 模型请求必须确实产生工具调用：守住位置 begin 的断言；改错故障 页面工具根本没被触发。
// INV-10 重复实时帧只允许执行一次页面调用：守住位置 首个用例；改错故障 锚点切换时重复执行副作用。
// INV-11 锚点切换不得中断已认领的调用：守住位置 用例中的切换与释放顺序；改错故障 合法调用被误取消。
// INV-12 审批挂起时取消必须拒绝迟到的允许：守住位置 第二个用例；改错故障 取消后仍执行页面。
// INV-13 认领前取消必须让认领回执失败：守住位置 第三个用例；改错故障 SDK 处理器被调用。
// INV-14 执行中取消必须传到中止信号：守住位置 第四个用例；改错故障 页面调用继续跑完并写回结果。
// INV-15 重试替换页面后旧目标必须失效：守住位置 末个用例；改错故障 审批落到新页面实例。
// INV-16 页面调用计数断言必须按 key 过滤：守住位置 三处 filter；改错故障 其他用例的调用污染计数。
// INV-17 每个用例结束都要确认终止状态：守住位置 terminal 调用；改错故障 用例之间状态串扰。
// INV-18 环境句柄通过窗口内容 id 获取：守住位置 末个用例的句柄读取；改错故障 对比到错误的页面实例。
//
// 模块职责：在托管 MCP App 夹具中验证模型发起页面工具的发现、审批、取消与重试语义。
// 状态所有权：夹具状态归托管环境；本文件只通过命令、事件与页面求值观察和驱动。
// 阅读顺序：先看命令与等待包装，再读 begin，最后按取消时序逐个读五个用例。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
// 把页面求值、命令、审批与终止事件拆成四个包装。
// 审批按输入键匹配，避免并发用例互相认领。
// 终止事件只认本会话的 turn.terminal。
// 所有等待都带历史偏移，保证只看本轮。
export async function checkModel(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  const page = (code: string) => env.evalPage(win, code);
  const command = (type: string, payload: unknown) =>
    env.agent.call("v4/command", {
      commandId: randomUUID(),
      clientId: "fixture-client",
      sessionId: scope.sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    });
  const permission = (key: string) => env.agent.approvals.wait((r) => r.params.input?.key === key);
  const terminal = (after: number) =>
    env.agent.notifications.wait(
      (e) =>
        e.method === "v4/telemetry/event" &&
        e.params.kind === "turn.terminal" &&
        e.params.sessionId === scope.sessionId,
      after,
    );
  // begin 先记录 env.agent.notifications.history.length 作为本轮事件偏移。
  // env.model.plans 登记 delayed 计划后再 sendText，模拟模型先思考。
  // sendText 载荷固定 mode=build 并带上 env.model.selection。
  // 断言 ack.status 为 accepted，且 env.model.requests 等到带工具的请求。
  // 返回偏移，供后续 env.events.wait 复用。
  async function begin(key: string) {
    const after = env.agent.notifications.history.length;
    env.model.plans.push({ key, delayed: true });
    const ack = await command("sendText", {
      text: `fixture ${key}`,
      modelSelection: env.model.selection,
      mode: "build",
    });
    assert.equal(ack.status, "accepted");
    const request = await env.model.requests.wait((r) => r.plan?.key === key);
    assert.ok(request.tool);
    return after;
  }
  await check(
    // 先用 env.events.history.length 记录偏移，再触发一次页面工具调用。
    // respond 批准审批后，等 claimAppToolCall 事件被 accepted。
    // 同一帧重复投递五次，pageCalls 仍只应执行一次。
    // setAnchors(false, true) 切换锚点后再 releasePageCall，结果仍应成功。
    // 最后断言 claimAppToolCall 只有一条且 terminal 状态为 success。
    "model discovers page tool, duplicate live frames execute once across anchor switch",
    async () => {
      const offset = env.events.history.length;
      const after = await begin("model-page");
      await env.agent.respond(await permission("model-page"), "allow");
      await env.events.wait((e) => e.type === "claimAppToolCall" && e.result.accepted, offset);
      await page("window.waitPageCall('model-page')");
      const delivered = env.agent.notifications.history.find((e) =>
        e.params?.frame?.payload?.deltas?.some(
          (d: any) =>
            d.op === "pluginUi.appToolCall" && d.arguments?.key === "model-page" && !d.activity,
        ),
      );
      assert.ok(delivered);
      for (let n = 0; n < 5; n++)
        win.webContents.send("fixture-notification", { kind: "frame", value: delivered.params });
      assert.equal((await ui("window.managedState()")).busy, true);
      await ui("window.setAnchors(false, true)");
      await page("window.releasePageCall('model-page')");
      const result = await env.events.wait((e) => e.type === "resolveAppToolCall", offset);
      assert.equal(result.params.result.structuredContent.key, "model-page");
      assert.equal(result.result.accepted, true);
      assert.deepEqual(await page("window.pageCalls"), [{ key: "model-page", aborted: false }]);
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "claimAppToolCall").length,
        1,
      );
      assert.equal((await terminal(after)).params.status, "success");
    },
  );
  await check(
    "model cancellation while approval pending rejects late allow without executing page",
    async () => {
      const after = await begin("model-approval-cancel");
      const pending = await permission("model-approval-cancel");
      await command("stop", {});
      await env.agent.respond(pending, "allow");
      await terminal(after);
      assert.equal(
        await page("window.pageCalls.filter(c => c.key === 'model-approval-cancel').length"),
        0,
      );
    },
  );
  await check(
    // 用 env.gates.set 卡住 claimAppToolCall，制造取消窗口。
    // 发送停止命令后再放行门闩，让取消先于认领。
    // 断言 claim 回执的 accepted 为 false。
    // pageCalls 计数保持为零，证明 SDK 处理器未执行。
    // 用 terminal(after) 等本轮 turn.terminal 收尾，避免污染下一用例。
    "model cancellation before claim denies stale claim and never invokes SDK handler",
    async () => {
      const gate = Promise.withResolvers<void>();
      env.gates.set("claimAppToolCall", gate.promise);
      const offset = env.events.history.length;
      const after = await begin("model-claim-cancel");
      await env.agent.respond(await permission("model-claim-cancel"), "allow");
      await env.events.wait(
        (e) => e.type === "app-tools-arrived" && e.method === "claimAppToolCall",
        offset,
      );
      await command("stop", {});
      env.gates.delete("claimAppToolCall");
      gate.resolve();
      const claim = await env.events.wait((e) => e.type === "claimAppToolCall", offset);
      assert.equal(claim.result.accepted, false);
      await terminal(after);
      assert.equal(
        await page("window.pageCalls.filter(c => c.key === 'model-claim-cancel').length"),
        0,
      );
    },
  );
  await check(
    "model cancellation during page execution reaches SDK AbortSignal and rejects late result",
    async () => {
      const offset = env.events.history.length;
      const after = await begin("model-execution-cancel");
      await env.agent.respond(await permission("model-execution-cancel"), "allow");
      await page("window.waitPageCall('model-execution-cancel')");
      await command("stop", {});
      await page("window.waitPageAbort('model-execution-cancel')");
      const result = await env.events.wait((e) => e.type === "resolveAppToolCall", offset);
      assert.equal(result.result.accepted, false);
      await terminal(after);
      await page("window.releasePageCall('model-execution-cancel')");
      assert.equal(
        await page("window.pageCalls.filter(c => c.key === 'model-execution-cancel').length"),
        1,
      );
      assert.equal((await ui("window.managedState()")).busy, false);
    },
  );
  // 先保存 env.handles 里旧页面的 instance 句柄。
  // 审批挂起期间调用 retryManaged，等待 phase 进入 running。
  // respond 放行审批后，终止事件仍应到达。
  // 新 instance 必须变化，且旧 pageCalls 没有新增。
  // 该用例验证审批绑定的是发起时的 target。
  await check("model target stays bound when retry replaces page during approval", async () => {
    const old = env.handles.get(win.webContents.id).instance;
    const after = await begin("model-replaced");
    const pending = await permission("model-replaced");
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
    await page("window.fixtureReady");
    await env.agent.respond(pending, "allow");
    await terminal(after);
    assert.notEqual(env.handles.get(win.webContents.id).instance.token, old.token);
    assert.deepEqual(await page("window.pageCalls"), []);
  });
}
