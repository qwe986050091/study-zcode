// INV-01 每条用例独立命名：守住位置 check 的标题；改错故障 失败信息无法定位场景。
// INV-02 三条用例覆盖三类迟到：守住位置 三个 check 调用；改错故障 替换竞态无人验证。
// INV-03 事件按偏移切片：守住位置 history.slice(offset)；改错故障 统计到上一用例的残留事件。
// INV-04 gate 只扣单个方法：守住位置 env.gates.set；改错故障 页面启动被整体挂起。
// INV-05 gate 用完即删：守住位置 env.gates.delete；改错故障 后续用例永久等待。
// INV-06 新旧 token 必须不同：守住位置 notEqual；改错故障 替换页复用旧实例仍算通过。
// INV-07 旧实例校验必须被拒：守住位置 assert.rejects；改错故障 过期句柄仍可操作。
// INV-08 旧沙箱显式销毁：守住位置 dispose 调用；改错故障 旧窗口泄漏。
// INV-09 游客恒为一：守住位置 countGuests；改错故障 替换变成新增窗口。
// INV-10 端口监听恒为一：守住位置 listeners.ports；改错故障 旧监听未释放。
// INV-11 迟到授权不得授予替换页：守住位置 oldCall 的 error 断言；改错故障 旧许可越权生效。
// INV-12 被拒调用不留执行记录：守住位置 executed 过滤；改错故障 权限阻断形同虚设。
// INV-13 新权限请求单独等待：守住位置 approvals.wait；改错故障 拒绝作用到错误的请求。
// INV-14 用例只读断言：守住位置 不写产品代码；改错故障 测试夹具与产品共用可变状态。
//
// 模块职责：MCP 托管页替换场景的迟到回调用例，验证旧句柄与旧授权不会复活。
// 阅读顺序：先看 prepare 回执用例，再看迟到授权用例，最后看工具注册用例。
import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
// checkLate 的三条用例共用 env 与 win 两个夹具，断言都通过 check 入口注册。
export async function checkLate(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  // ui 包装 win.webContents.executeJavaScript，页面脚本统一从这里注入。
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  await check(
    // 第一条：扣住 prepare 回执，验证替换与串行。
    "retry while prepare reply is withheld discards old handle and serializes replacement",
    async () => {
      // 以当前事件数为起点，只看本轮。
      const offset = env.events.history.length;
      const gate = Promise.withResolvers<void>();
      // 只扣住 prepare，其它桥调用照常。
      env.gates.set("return:prepareSandbox", gate.promise);
      await ui("window.retryManaged()");
      await env.events.wait((e) => e.type === "bridge" && e.method === "prepareSandbox", offset);
      // 先记住即将被替换的旧句柄。
      const stale = env.handles.get(win.webContents.id);
      await ui("window.retryManaged(); window.retryManaged()");
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "registered").length,
        1,
      );
      // 用完即删，避免后续页面永远挂起。
      env.gates.delete("return:prepareSandbox");
      gate.resolve();
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await env.evalPage(win, "window.fixtureReady");
      const replacement = env.handles.get(win.webContents.id);
      // 替换页必须持有新 token。
      assert.notEqual(replacement.instance.token, stale.instance.token);
      // 旧实例的校验必须被拒绝。
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: stale.instance }),
      );
      await ui(`window.harness.dispose(${JSON.stringify(stale.sandboxId)}, ${stale.initId})`);
      // 替换不新增游客窗口。
      assert.equal(env.countGuests(), 1);
      // 替换完成后 listeners.ports 仍为 1，证明旧端口监听已经释放。
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
  await check("late project-wide permission answer cannot grant replacement page", async () => {
    const oldCall = env
      .evalPage(win, "window.callTool('project-stale')")
      .catch((error) => ({ error: String(error) }));
    // 第二条用例先扣住 project-stale 的项目级授权，再触发页面替换。
    const pending = await env.agent.approvals.wait((r) => r.params.input?.key === "project-stale");
    const project = pending.params.options.find(
      (option: any) => option.optionId === "allow_project",
    );
    assert.ok(project?.response.permissionUpdates?.length);
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
    await env.evalPage(win, "window.fixtureReady");
    await env.agent.client.respond(pending.id, project.response);
    assert.ok((await oldCall).error);
    const next = env.evalPage(win, "window.callTool('project-replacement')");
    const nextPermission = await env.agent.approvals.wait(
      (r) => r.params.input?.key === "project-replacement",
    );
    await env.agent.respond(nextPermission, "deny");
    assert.ok((await next).error);
    assert.equal(
      // 旧授权迟到时 agent.events 里不得出现 project- 前缀的 executed 记录。
      env.agent.events.history.some((e) => e.type === "executed" && e.key.startsWith("project-")),
      false,
    );
  });
  await check(
    "withheld app tool registration cannot resurrect replaced page or unregister its successor",
    async () => {
      const offset = env.events.history.length;
      const gate = Promise.withResolvers<void>();
      env.gates.set("registerAppTools", gate.promise);
      await ui("window.retryManaged()");
      await env.events.wait(
        (e) => e.type === "app-tools-arrived" && e.method === "registerAppTools",
        offset,
      );
      const stale = env.handles.get(win.webContents.id).instance;
      env.gates.delete("registerAppTools");
      const after = env.events.history.length;
      await ui("window.retryManaged()");
      const registered = await env.events.wait((e) => e.type === "registerAppTools", after);
      assert.notEqual(registered.params.instance.token, stale.token);
      gate.resolve();
      await env.evalPage(win, "window.fixtureReady");
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: stale }),
      );
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
}
