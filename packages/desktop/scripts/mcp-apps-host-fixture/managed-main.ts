// INV-01 四个参数缺一不可：守住位置 进程参数解构；改错故障 夹具在错误目录下运行。
// INV-02 用户数据目录必须隔离：守住位置 设置 userData 路径；改错故障 污染真实配置。
// INV-03 特权协议要在就绪前注册：守住位置 注册调用位置；改错故障 插件页拿不到安全上下文。
// INV-04 关窗不退出：守住位置 空实现的关窗监听；改错故障 用例中途被系统回收。
// INV-05 每个检查都有超时：守住位置 竞速包裹；改错故障 挂起检查拖死整批。
// INV-06 保活类给更长窗口：守住位置 名称分支；改错故障 正常保活被误判超时。
// INV-07 失败必须留下现场：守住位置 写失败文件；改错故障 只能看到一行栈无法复盘。
// INV-08 现场要截断历史：守住位置 事件与通知的切片；改错故障 文件体积失控。
// INV-09 计时器必须释放：守住位置 收尾清理；改错故障 残留定时器让进程不退出。
// INV-10 通过要逐个打印：守住位置 标准输出；改错故障 失败时无法定位卡在哪一步。
// INV-11 打开等待初始化握手：守住位置 事件等待；改错故障 抢跑读到准备中之前的状态。
// INV-12 放行信号由测试掌控：守住位置 显式放行调用；改错故障 初始化永远不完成。
// INV-13 打开失败不得静默：守住位置 捕获后仍等待结果；改错故障 未处理的拒绝让进程崩溃。
// INV-14 成功后不得出现错误阶段：守住位置 阶段历史断言；改错故障 先报错再恢复被当成通过。
// INV-15 注册只发生一次：守住位置 计数断言；改错故障 重复注册被忽略。
// INV-16 会话租约必须唯一：守住位置 视图与监听计数；改错故障 多份订阅导致重复渲染。
// INV-17 退出码区分成败：守住位置 两处退出调用；改错故障 失败被流水线当成成功。
// INV-18 环境始终关闭：守住位置 收尾块；改错故障 子进程与窗口泄漏。
//
// 模块职责：驱动托管式 MCP 应用的端到端夹具，并汇总逐项检查结果。
// 状态所有权：环境、窗口与检查清单都在一次进程生命周期内创建并销毁。
// 阅读顺序：先看参数与协议注册，再看检查包装器，最后看主流程与退出码。
import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { checkPermissions } from "./managed-permission-checks.js";
import { checkLifecycle } from "./managed-lifecycle-checks.js";
import { checkManaged } from "./managed-checks.js";
// process.argv[2] 是夹具根目录 root，用于定位夹具资源。
// process.argv[3] 是独立的用户数据目录 profile，供 app.setPath("userData") 使用。
// 后两参 node 与 cli 分别指向宿主运行时与命令行入口。
// 四参缺任一项时解构得到 undefined，后续步骤会以空值失败。
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const env = await managedEnvironment(root, node, cli);
    const checks: { name: string; ms: number }[] = [];
    // 每次 check 都用 performance.now() 记录耗时并压入 checks。
    // 超时窗口按 name 区分：keep-warm 类给 45_000 ms，其余 20_000 ms。
    // 失败时先落盘现场再抛错，避免只留栈信息。
    // 现场写入 managed-failure.json，覆盖 requests / approvals / events / notifications 四段历史。
    // finally 里无条件 clearTimeout(timer)，无论成败都清掉计时器。
    const check = async (name: string, run: () => Promise<void>) => {
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out: ${name}`)),
              name.includes("keep-warm") ? 45_000 : 20_000,
            );
          }),
        ]);
      } catch (error) {
        await writeFile(
          join(root, "managed-failure.json"),
          JSON.stringify(
            {
              name,
              requests: env.model.requests.history,
              approvals: env.agent.approvals.history,
              events: env.events.history.slice(-20),
              notifications: env.agent.notifications.history.slice(-12),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        clearTimeout(timer!);
      }
      checks.push({ name, ms: performance.now() - start });
      process.stdout.write(`PASS ${name}\n`);
    };
    try {
      const scope = await env.agent.session(join(root, "managed-workspace"), "managed-delayed");
      const started = performance.now();
      const opening = env.createWindow(scope);
      void opening.catch(() => {});
      await check("App opening waits for MCP startup and runs without reload", async () => {
        await env.agent.events.wait(
          (e) => e.type === "initialize-waiting" && e.source === "managed",
        );
        const arrived = await env.events.wait(
          (e) => e.type === "bridge-arrived" && e.method === "prepareSandbox",
        );
        const owner = env.windows.find((w) => w.webContents.id === arrived.owner)!;
        assert.equal(
          (await owner.webContents.executeJavaScript("window.managedState()")).phase,
          "preparing",
        );
        env.agent.release("managed", "initialize");
        await opening;
        assert.equal(
          env.events.history.some((e) => e.type === "phase" && e.phase === "error"),
          false,
        );
        assert.equal(env.events.history.filter((e) => e.type === "registered").length, 1);
      });
      const win = await opening;
      const coldPageMs = performance.now() - started;
      await writeFile(
        join(root, "managed-inline.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await check(
        "production React card and managed page establish one live conversation lease",
        async () => {
          const state = await win.webContents.executeJavaScript("window.managedState()");
          assert.equal(state.phase, "running");
          assert.equal(state.views, 1);
          assert.equal(state.listeners.frame, 1);
          assert.equal(env.events.history.filter((e) => e.type === "subscribed").length, 1);
        },
      );
      // checkManaged() 是通用托管检查，独立于主卡片检查。
      // checkPermissions() 与 checkLifecycle() 各自收尾，不共享状态。
      // 存储身份由 env.handles 按 win.webContents.id 回读。
      // checks 与 coldPageMs 一起写入 managed-results.json。
      // 异常路径仍走 finally 里的 env.close()，统一收尾关闭环境。
      await checkManaged(env, win, scope, check);
      await checkPermissions(env, root, check);
      await checkLifecycle(env, win, scope, check);
      await writeFile(
        join(root, "managed-storage-identity.json"),
        JSON.stringify({ appIdentity: env.handles.get(win.webContents.id).instance.appIdentity }),
      );
      await writeFile(
        join(root, "managed-results.json"),
        JSON.stringify({ coldPageMs, checks }, null, 2),
      );
    } finally {
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
