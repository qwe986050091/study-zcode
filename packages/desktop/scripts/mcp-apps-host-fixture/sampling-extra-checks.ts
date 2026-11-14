// INV-01 复用同一 sampling 请求体：守住位置 request 常量；改错故障 各检查参数漂移。
// INV-02 每种权限模式都要走通：守住位置 模式循环；改错故障 某模式被跳过。
// INV-03 授权历史不应增加：守住位置 前后比对；改错故障 隐式弹审批。
// INV-04 会话消息不应被写入：守住位置 messages 长度；改错故障 采样污染会话。
// INV-05 用量至少覆盖四次请求：守住位置 modelRequestCount；改错故障 计数漏记。
// INV-06 provider 错误只到 SDK 一次：守住位置 filter 长度；改错故障 重试风暴。
// INV-07 错误后实例可继续使用：守住位置 after-error 调用；改错故障 实例被永久占死。
// INV-08 采样与主任务并发：守住位置 并行发起；改错故障 串行导致用例失真。
// INV-09 取消采样不影响主任务：守住位置 取消后比对消息；改错故障 主任务被连带取消。
// INV-10 主任务终态成功：守住位置 terminal 状态；改错故障 误判失败。
// INV-11 关闭任务中止采样：守住位置 session/close；改错故障 采样悬挂。
// INV-12 陈旧请求被拒绝：守住位置 assert.rejects；改错故障 旧实例继续服务。
// INV-13 keep-warm 订阅要释放：守住位置 waitConnectionsReleased；改错故障 句柄泄漏。
// INV-14 每个检查独立命名：守住位置 check 包装；改错故障 失败无法定位。
// INV-15 窗口最终销毁：守住位置 win.destroy；改错故障 残留窗口。
// INV-16 计划键区分用例：守住位置 采样键；改错故障 用例互相命中。
// INV-17 采样结果必须显式断言：守住位置 result 与 error；改错故障 静默通过。
// INV-18 中止事件要等到：守住位置 aborted 等待；改错故障 竞态下假通过。
//
// 模块职责：在 fixture 环境里验证 sampling 的权限、错误、并发与关闭语义。
// 状态所有权：环境与窗口由调用方创建，本函数只在最后销毁窗口。
// 阅读顺序：先看公共请求与作用域，再看四个 check。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
// request 请求体保持最小，只含一条 text 消息。
// scope 与 win 各建一次，全函数复用。
// 结束时销毁 win 窗口，避免残留。
export async function checkSamplingExtras(
  env: Environment,
  root: string,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  // 单条文本消息。
  // 输出上限 32。
  // 所有 check 调用共用同一个 request。
  const request = {
    messages: [{ role: "user", content: { type: "text", text: "Explain 1/2" } }],
    maxTokens: 32,
  };
  // 独立测试工作区由 join(root, "sampling-extra-workspace") 给出。
  // 独立会话作用域由 env.agent.session 创建。
  // 复用 env.model.selection 同一模型选择。
  const scope = await env.agent.session(join(root, "sampling-extra-workspace"), "sampling-extra");
  await env.agent.call("session/setModel", {
    sessionId: scope.sessionId,
    model: env.model.selection,
  });
  const win = await env.createWindow(scope, "sampling");
  // page 在页面内执行脚本。
  // UI 侧同样可执行。
  // sample 把采样入口单独封装，返回 Promise。
  const page = (code: string) => env.evalPage(win, code);
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  // 键用于区分计划。
  // 请求体序列化传入。
  // 返回 Promise 供断言。
  const sample = (key: string) =>
    page(`window.sample(${JSON.stringify(key)},${JSON.stringify(request)})`);
  await check(
    "task permission modes reuse the same sampling path without extra approval",
    async () => {
      const before = env.agent.approvals.history.length;
      for (const mode of ["plan", "build", "edit", "yolo"]) {
        await env.agent.call("session/setMode", { sessionId: scope.sessionId, mode });
        assert.ok((await sample(`mode-${mode}`)).result);
      }
      assert.equal(env.agent.approvals.history.length, before);
      assert.equal(
        (await env.agent.call("session/read", { sessionId: scope.sessionId })).messages.length,
        0,
      );
      const usage = await env.agent.call("session/usage", { sessionId: scope.sessionId });
      assert.ok(usage.modelRequestCount >= 4);
      assert.ok(usage.totalTokens >= 60);
    },
  );
  await check(
    "provider error reaches SDK once and releases the instance for the next call",
    async () => {
      env.model.plans.push({ key: "failed", delayed: false, status: 401 });
      assert.ok((await sample("failed")).error);
      await ui("window.waitSamplingIdle()");
      assert.equal(env.model.requests.history.filter((e) => e.plan?.key === "failed").length, 1);
      assert.ok((await sample("after-error")).result);
    },
  );
  await check(
    "sampling and the main task run concurrently with independent cancellation",
    async () => {
      env.model.plans.push({ key: "parallel-sampling", delayed: true });
      const sampling = sample("parallel-sampling");
      await env.model.requests.wait((e) => e.plan?.key === "parallel-sampling");
      const offset = env.agent.notifications.history.length;
      const ack = await env.agent.call("v4/command", {
        commandId: randomUUID(),
        clientId: "sampling-fixture",
        sessionId: scope.sessionId,
        type: "sendText",
        payload: {
          text: "A main conversation question",
          modelSelection: env.model.selection,
          mode: "build",
        },
        issuedAt: Date.now(),
      });
      assert.equal(ack.status, "accepted");
      const terminal = await env.agent.notifications.wait(
        (e) =>
          e.method === "v4/telemetry/event" &&
          e.params.kind === "turn.terminal" &&
          e.params.sessionId === scope.sessionId,
        offset,
      );
      assert.equal(terminal.params.status, "success");
      assert.equal((await ui("window.managedState()")).busy, true);
      const before = await env.agent.call("session/read", { sessionId: scope.sessionId });
      assert.ok(before.messages.length > 0);
      await page("window.cancelSample('parallel-sampling')");
      assert.ok((await sampling).error);
      await env.model.aborted.wait((key) => key === "parallel-sampling");
      assert.deepEqual(
        (await env.agent.call("session/read", { sessionId: scope.sessionId })).messages,
        before.messages,
      );
    },
  );
  await check(
    "closing task aborts sampling, rejects stale requests and releases keep-warm subscriptions",
    async () => {
      env.model.plans.push({ key: "close-task", delayed: true });
      const result = sample("close-task").catch(() => ({ error: "page closed" }));
      await env.model.requests.wait((e) => e.plan?.key === "close-task");
      const instance = env.handles.get(win.webContents.id).instance;
      await env.agent.call("session/close", { sessionId: scope.sessionId });
      assert.ok((await result).error);
      await env.model.aborted.wait((key) => key === "close-task");
      await assert.rejects(() =>
        env.agent.call("mcp/uiSampling", {
          ...scope,
          instance,
          operationId: "after-close",
          request,
        }),
      );
      await ui(
        "window.setAnchors(false,false).then(() => { window.clearManaged(); return window.waitConnectionsReleased(); })",
      );
      win.destroy();
    },
  );
}
