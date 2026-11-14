// MCP Apps 宿主采样的端到端 fixture 入口：在真实 Electron 主进程里启动模型桩与 agent，
// 按固定顺序验证应用发起的采样能力、取消、隔离、模型冻结与资源回收。
// 本文件只做场景编排与断言，不负责宿主实现、协议编解码、模型桩行为或界面渲染。
//
// INV-01 断言：命令行四参数依次是根目录、profile、node 路径与 cli 路径 —— 守住它的位置：process.argv 解构 —— 改错故障：userData 落到错误目录，缓存与插件沙箱在别处重建且不报错
// INV-02 断言：userData 在注册特权 scheme 与创建窗口之前设置 —— 守住它的位置：app.setPath 调用顺序 —— 改错故障：缓存、锁文件与沙箱存储分裂到默认 profile，场景之间互相污染
// INV-03 断言：插件沙箱 scheme 在 ready 之前注册 —— 守住它的位置：protocol.registerSchemesAsPrivileged —— 改错故障：guest 页面失去安全上下文，跨域与权限判断整体失效
// INV-04 断言：关闭全部窗口不结束进程 —— 守住它的位置：window-all-closed 空监听 —— 改错故障：多窗口场景中途退出，后半段检查永远不执行
// INV-05 断言：每次检查成功才写入结果数组 —— 守住它的位置：check 内 push 分支 —— 改错故障：失败被计入通过数，结果文件虚高并掩盖首个异常
// INV-06 断言：单次检查受超时约束，keep-warm 场景放宽到四十五秒 —— 守住它的位置：race 与超时分支 —— 改错故障：挂起请求拖死整个 fixture，或回收场景被误判为超时
// INV-07 断言：超时定时器在 finally 中清除 —— 守住它的位置：clearTimeout 调用 —— 改错故障：进程残留活跃句柄，退出码与断言结果不一致
// INV-08 断言：失败证据先写盘再抛出 —— 守住它的位置：catch 分支的 writeFile —— 改错故障：只看到栈而拿不到请求、审批与事件历史，无法区分误接线与实现回归
// INV-09 断言：采样永不写入主会话消息 —— 守住它的位置：mainBefore 与各阶段 after 比较 —— 改错故障：应用请求污染用户对话，下一次模型调用带上不该有的上下文
// INV-10 断言：采样不触发审批 —— 守住它的位置：approvals 历史长度断言 —— 改错故障：应用采样被误当作工具调用，用户被迫确认且自动化流程阻塞
// INV-11 断言：模型在请求接纳时冻结，挂起期间的切换不影响本次 —— 守住它的位置：model-change 场景 —— 改错故障：同一请求前后半段用不同模型，结果不可复现
// INV-12 断言：非协议字段不能覆盖绑定模型 —— 守住它的位置：ignored-provider 与直接宿主调用断言 —— 改错故障：应用可指定任意供应商与模型，绕过会话权限与配额
// INV-13 断言：非法选项与不支持的内容块在到达模型桩前被拒绝 —— 守住它的位置：请求计数比对 —— 改错故障：未定义语义被静默接受，模型桩多收请求而断言仍通过
// INV-14 断言：取消会中断请求、释放忙碌状态且不重放 —— 守住它的位置：cancel 场景与单次请求计数 —— 改错故障：取消变成重试，产生一次用户不可见的二次计费
// INV-15 断言：同一操作 id 只被接纳一次 —— 守住它的位置：complete-once 场景 —— 改错故障：重复提交产生并列采样，忙碌状态提前释放
// INV-16 断言：凭据按窗口实例与服务器名隔离 —— 守住它的位置：forged 与 wrong-server 断言 —— 改错故障：一个窗口可代另一个窗口采样，跨服务器调用不再被拦截
// INV-17 断言：挂起采样在二十次布局切换后依然存活且不被回收 —— 守住它的位置：move 场景的 guest 与监听器比较 —— 改错故障：侧边栏重排导致请求被取消或 guest 被重建
// INV-18 断言：连接撤销同时中止请求并让旧凭据失效 —— 守住它的位置：revoke 场景 —— 改错故障：撤销后仍能发起调用，留下可用的悬挂通道
// INV-19 断言：窗口销毁后 guest 计数归零 —— 守住它的位置：末尾 countGuests 断言 —— 改错故障：每个场景泄漏一个 webview，长时间运行后进程资源耗尽
// INV-20 断言：结果文件在环境关闭前写出 —— 守住它的位置：writeFile 与 finally 顺序 —— 改错故障：统计字段被清空或丢失，测试框架拿到空结果仍判成功
//
// 正文块按契约、并发、失败路径与资源释放标注：改动前先读对应断言，再决定是否触碰被测实现。
import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { checkSamplingExtras } from "./sampling-extra-checks.js";
import { managedEnvironment } from "./managed-environment.js";

const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
// 命令行参数顺序即契约：根目录、profile、node 与 cli 依次传入，任何重排都会让 userData 指向错误目录，Electron 会在别处重建缓存而不报错。
// userData 必须早于 app ready 设置；等到有代码开始写盘再改，只会让缓存与锁文件分裂到两个 profile。
// [契约] profile 由外部脚本生成并复用，这里不做存在性检查，也绝不创建目录——创建会把参数错误伪装成成功。
// root 同时是 renderer 静态资源、guest preload 与失败转储的落点，三处必须指向同一个绝对路径。
app.setPath("userData", profile);
// [契约] 特权 scheme 必须在 ready 之前注册；挪到 whenReady 之后再注册，插件沙箱页面会被当作普通内容，CORS 与安全上下文判断全部失效。
// 这里只注册从主进程模块导入的单一 scheme，不新增别名；fixture 与真实应用共用同一份定义，避免测试通过而线上规则不同。
// scheme 的字段由 pluginSandbox 模块持有，本文件只负责注册时机，不复制配置。
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
// [资源] 所有窗口关闭时不退出进程：后续检查要反复创建与销毁窗口，默认退出行为会让测试中途终止。
// 这不是产品行为，只是 fixture 的生命周期约束；真正退出由末尾显式的 app.exit 决定。
// 空实现保留监听器本身：某些平台在缺少该监听器时会走默认退出路径。
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // [失败路径] 模型桩与 agent 一起启动，任一步失败都会让后续检查失去意义，因此这里不捕获异常，直接交给最外层 catch 输出栈。
    // managedEnvironment 持有主进程侧 bridge、采样服务与 guest 注册表，本文件只通过返回对象操作，不绕过它直接调 ipc。
    // [权衡] 启动耗时不计入任何单次检查的超时预算，冷启动慢只影响总时长，不会让场景假失败。
    // 关闭顺序由 env.close 负责，本文件不提前销毁 agent 或 model。
    const env = await managedEnvironment(root, node, cli);
    const checks: { name: string; ms: number }[] = [];
    // [契约] 每次检查都在同一处收口：成功写入 checks 供结果文件统计，失败先落盘证据再抛出。
    // 超时是独立 Promise 与执行 Promise 竞争，业务代码无法自行清理；真正的取消语义必须由被测实现给出，不能靠这里的定时器。
    // [权衡] keep-warm 场景需要跨过宿主空闲回收窗口，超时放宽到四十五秒，其余二十秒；用名字判断而非传参，避免调用点漏传。
    // [失败路径] 失败转储包含请求、审批、最近事件与最近通知，只截取尾部若干条，防止无限增长的历史把文件写爆。
    // [资源] 定时器在 finally 中清除；提前返回或抛错都不能留下悬挂定时器，否则进程会因活跃句柄无法退出。
    const check = async (name: string, run: () => Promise<void>) => {
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout>;
      try {
        // [并发] race 只决定谁先完成，不取消另一方；run() 仍在后台跑，检查失败后不能假定被测任务已停止。
        // 拒绝值使用场景名构造错误，排查失败转储时能直接对上具体检查项。
        // 完成时记录耗时并立即打印通过标记，保证长任务卡住时仍能看到已通过进度。
        await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out: ${name}`)),
              name.includes("keep-warm") ? 45_000 : 20_000,
            );
          }),
        ]);
        checks.push({ name, ms: performance.now() - start });
        process.stdout.write(`PASS ${name}\n`);
      } catch (error) {
        // [失败路径] 失败证据在抛出之前写盘，路径固定在 root 下；若写盘本身失败，原始错误会被覆盖，这是已知取舍。
        // [契约] 请求历史反映模型桩实际收到的调用，审批历史证明采样未触发权限确认，两者是判断误接线的关键证据。
        // 事件与通知只保留尾部窗口，避免长会话把转储撑到无法阅读。
        // 缩进固定为二，便于人工比对与版本库中稳定 diff。
        await writeFile(
          join(root, "sampling-failure.json"),
          JSON.stringify(
            {
              name,
              requests: env.model.requests.history,
              approvals: env.agent.approvals.history,
              events: env.events.history.slice(-20),
              notifications: env.agent.notifications.history.slice(-10),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        // [资源] 必须用非空断言清定时器：赋值发生在 race 内部的执行器里，正常路径下同步完成，但类型系统看不到。
        // 若这里抛错，finally 会吞掉原始失败原因，因此不要在此处加入可能失败的逻辑。
        clearTimeout(timer!);
      }
    };
    try {
      // [事务] 采样使用独立工作区与独立会话，不复用主会话；目录由 root 派生，必须在 agent 启动前存在。
      // 会话名参与 guest 注册与连接标识，改名会同时影响下面所有绑定与断言。
      // 模型选择显式下发而不是依赖默认值，否则模型桩的返回模型断言会随环境漂移。
      const scope = await env.agent.session(join(root, "sampling-workspace"), "sampling");
      await env.agent.call("session/setModel", {
        sessionId: scope.sessionId,
        model: env.model.selection,
      });
      const started = performance.now();
      const win = await env.createWindow(scope, "sampling");
      const coldPageMs = performance.now() - started;
      const page = (code: string) => env.evalPage(win, code);
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const request = {
        messages: [{ role: "user", content: { type: "text", text: "What is 1 + 1?" } }],
        maxTokens: 128,
      };
      // [契约] 参数经序列化后拼进页面脚本，避免字符串插值破坏表达式；key 同时作为模型桩的应答标识。
      // 默认参数指向同一个 request 对象，调用方不得就地修改它，否则后续场景会串味。
      // page 与 ui 走两个不同通道：前者在 guest 内执行，后者在宿主渲染进程执行，混用会读到不同的全局状态。
      const sample = (key: string, params: any = request) =>
        page(`window.sample(${JSON.stringify(key)},${JSON.stringify(params)})`);
      // [契约] 绑定凭据由作用域、当前窗口的实例句柄与操作 id 组成；实例按 webContents id 现取，缓存旧句柄会在窗口重建后拿到失效凭据。
      // 操作 id 是幂等键：同一 id 只能被接纳一次，重复提交必须被拒绝，这是下面重复调用断言的依据。
      // 作用域里的会话与服务器名会被宿主再次校验，这里不裁剪也不补默认值。
      const binding = (operationId: string) => ({
        ...scope,
        instance: env.handles.get(win.webContents.id).instance,
        operationId,
      });
      // [契约] 主会话消息快照在全部采样开始前取得，后续每个阶段都拿它与最新读取结果比对。
      // 采样即使成功也绝不能把消息写入主对话；该断言覆盖三轮对话、图片请求与失败请求。
      // 快照是纯数据，读取后不再被修改，可作为跨场景的稳定基线。
      const mainBefore = await env.agent.call("session/read", { sessionId: scope.sessionId });
      await check(
        "official SDK sampling capability and app-owned three-round conversation",
        async () => {
          // [契约] 官方 SDK 的空能力对象必须原样透传；若返回了额外字段，说明宿主把自身实现细节泄漏给了应用。
          // 三轮对话每轮都要把助手回复追加回消息数组，模型桩按消息条数校验上下文没有丢失。
          // 第三轮结束后断言 `approvalHistory` 为零：采样不走工具审批链路。
          assert.deepEqual((await page("window.samplingCapabilities()")).sampling, {});
          const messages: any[] = [];
          for (let i = 0; i < 3; i++) {
            const key = `round-${i}`;
            messages.push({ role: "user", content: { type: "text", text: `question ${i}` } });
            env.model.plans.push({ key, delayed: false });
            const reply = await sample(key, { ...request, messages });
            assert.equal(reply.result.content.text, `answer:${key}`);
            assert.equal(reply.result.model, "gpt-4o");
            assert.equal(reply.result.stopReason, "endTurn");
            messages.push({ role: "assistant", content: reply.result.content });
            const sent = env.model.requests.history.at(-1).body;
            assert.equal(sent.messages.length, i * 2 + 1);
            assert.equal(sent.tools, undefined);
          }
          assert.equal(env.agent.approvals.history.length, 0);
          const after = await env.agent.call("session/read", { sessionId: scope.sessionId });
          assert.deepEqual(after.messages, mainBefore.messages);
          await ui("window.waitSamplingIdle()");
          assert.equal((await ui("window.managedState()")).busy, false);
        },
      );
      await check(
        "text plus image, explicit system prompt, token limit, advisory model hints",
        async () => {
          // [契约] 图片走内容块而不是独立字段，base64 原样透传；模型桩只校验数据被编码进消息，不校验像素。
          // systemPrompt 与模型偏好提示是建议性的：模型桩固定返回同一模型，用于证明提示不能覆盖会话绑定的模型。
          const image = {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
          };
          const reply = await sample("image", {
            ...request,
            messages: [{ role: "user", content: [request.messages[0].content, image] }],
            systemPrompt: "Teach basic maths.",
            maxTokens: 17,
            modelPreferences: { hints: [{ name: "unavailable-model" }] },
            includeContext: "none",
          });
          assert.equal(reply.result.model, "gpt-4o");
          const sent = env.model.requests.history.at(-1).body;
          assert.equal(sent.model, "gpt-4o");
          assert.equal(sent.messages[0].content, "Teach basic maths.");
          assert.ok(JSON.stringify(sent.messages).includes(`data:image/png;base64,${image.data}`));
          assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 17);
        },
      );
      await check(
        "unsupported content/options and non-actionable task fail before provider",
        async () => {
          // [失败路径] 非法选项必须在到达模型桩之前被拒绝；先记录请求数，最后比对数量未变，才说明没有偷偷发出请求。
          // [契约] 温度、停止序列、全量上下文、空工具列表与非音频内容块都在过滤名单上，放宽任何一项都会让应用拿到未定义的采样语义。
          // 关闭采样开关后同一请求必须失败，重新打开不改变之前失败的判定。
          // 供应商字段属于非协议字段，官方 SDK 会先剥离；直接走宿主接口时则必须被拒绝，两条路径的期望不能混为一谈。
          const count = env.model.requests.history.length;
          for (const invalid of [
            { temperature: 0.5 },
            { stopSequences: ["END"] },
            { includeContext: "allServers" },
            { tools: [] },
            {
              messages: [
                { role: "user", content: { type: "audio", mimeType: "audio/wav", data: "AAAA" } },
              ],
            },
          ]) {
            assert.ok(
              (await sample("invalid", { ...request, ...invalid })).error,
              JSON.stringify(invalid),
            );
          }
          await ui("window.setSamplingEnabled(false)");
          assert.ok((await sample("read-only")).error);
          await ui("window.setSamplingEnabled(true)");
          assert.equal(env.model.requests.history.length, count);
          // 官方 SDK 在宿主 handler 前过滤非协议字段；它们不能覆盖绑定模型。
          assert.equal(
            (await sample("ignored-provider", { ...request, providerId: "other" })).result.model,
            "gpt-4o",
          );
          await assert.rejects(() =>
            env.agent.call("mcp/uiSampling", {
              ...binding("injected-provider"),
              request: { ...request, providerId: "other" },
            }),
          );
        },
      );
      await check("SDK cancellation aborts HTTP, frees busy state, and never replays", async () => {
        // [并发] 延迟计划让请求停在模型桩上，取消必须同时中断传输与清理忙碌状态。
        // 取消后等待中断事件与 bridge 事件各一次，证明取消是从页面经宿主传到模型层的单一路径。
        // 释放计划后仍断言该 key 只出现一次，防止取消被实现成重试。
        env.model.plans.push({ key: "cancel", delayed: true });
        const result = sample("cancel");
        await env.model.requests.wait((e) => e.plan?.key === "cancel");
        await page("window.cancelSample('cancel')");
        assert.ok((await result).error);
        await env.model.aborted.wait((key) => key === "cancel");
        await env.events.wait((e) => e.type === "bridge" && e.method === "cancelSampling");
        env.model.release("cancel");
        assert.equal(env.model.requests.history.filter((e) => e.plan?.key === "cancel").length, 1);
      });
      await check(
        "pending sampling survives twenty inline-sidebar moves and prevents recycle",
        async () => {
          env.model.plans.push({ key: "move", delayed: true });
          const result = sample("move");
          await env.model.requests.wait((e) => e.plan?.key === "move");
          // [并发] 采样挂起期间反复切换锚点，模拟侧边栏二十次布局变化；guest、句柄与监听器集合必须逐项不变。
          // 视图数量固定为一，重复挂载会在此处暴露。
          // 事件历史中的读取计数不变，说明重排没有触发额外的会话读取。
          // 挂起时再次发起采样必须失败，且挂起接口返回 false，证明忙碌判定不是前端独有。
          const guestId = env.guests.get(win.webContents.id)!.id;
          const before = await ui("window.managedState()");
          const reads = env.agent.events.history.filter((e) => e.type === "read").length;
          assert.equal(before.busy, true);
          assert.equal(await ui("window.suspendManaged()"), false);
          assert.ok((await sample("concurrent")).error);
          for (let i = 0; i < 20; i++) await ui(`window.setAnchors(${i % 2 === 0},${i % 2 !== 0})`);
          const after = await ui("window.managedState()");
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          assert.deepEqual(after.handle, before.handle);
          assert.deepEqual(after.listeners, before.listeners);
          assert.equal(after.views, 1);
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, reads);
          env.model.release("move");
          assert.equal((await result).result.content.text, "answer:move");
          await ui("window.waitSamplingIdle()");
          assert.equal((await ui("window.managedState()")).busy, false);
        },
      );
      await check(
        "Agent pre-admission cancellation, duplicate operation and forged credential",
        async () => {
          const before = env.model.requests.history.length;
          // [契约] 未接纳的请求取消返回 false 而不是抛错，随后真正的采样调用必须被拒绝。
          // 同一操作 id 第二次提交必须失败；伪造凭证与错误服务器名分别命中不同的校验分支。
          // 整段结束后只允许新增一次 `modelRequest`，其余非法调用在准入阶段被拦。
          const cancelled = binding("cancel-before");
          assert.equal((await env.agent.call("mcp/uiCancelSampling", cancelled)).cancelled, false);
          await assert.rejects(() => env.agent.call("mcp/uiSampling", { ...cancelled, request }));
          const complete = binding("complete-once");
          await env.agent.call("mcp/uiSampling", { ...complete, request });
          await assert.rejects(() => env.agent.call("mcp/uiSampling", { ...complete, request }));
          assert.equal((await env.agent.call("mcp/uiCancelSampling", complete)).cancelled, false);
          await assert.rejects(() =>
            env.agent.call("mcp/uiSampling", {
              ...binding("forged"),
              instance: { ...complete.instance, token: "forged" },
              request,
            }),
          );
          await assert.rejects(() =>
            env.agent.call("mcp/uiSampling", {
              ...binding("wrong-server"),
              serverName: "different",
              request,
            }),
          );
          assert.equal(env.model.requests.history.length, before + 1);
        },
      );
      await check(
        "current model is frozen for admitted request and changes on the next call",
        async () => {
          // [契约] 模型在请求被接纳的瞬间冻结，挂起期间切换会话模型不影响本次结果。
          // 下一次调用才读取新模型，最终请求体会带上新模型标识。
          env.model.plans.push({ key: "model-change", delayed: true });
          const result = sample("model-change");
          await env.model.requests.wait((e) => e.plan?.key === "model-change");
          await env.agent.call("session/setModel", {
            sessionId: scope.sessionId,
            model: { ...env.model.selection, modelId: "gpt-4o-mini" },
          });
          env.model.release("model-change");
          assert.equal((await result).result.model, "gpt-4o");
          assert.equal((await sample("new-model")).result.model, "gpt-4o-mini");
          assert.equal(env.model.requests.history.at(-1).body.model, "gpt-4o-mini");
        },
      );
      await check(
        "same source in another window isolates credentials and cancellation",
        async () => {
          // [并发] 第二个窗口来自同一页面源，但凭据与取消必须彼此隔离；两边的实例凭证不允许相等。
          // 销毁第二个窗口的 guest 后，第一个窗口的采样仍保持忙碌，说明回收判定按窗口维度而非全局。
          // [资源] 清理顺序为先断开锚点再清空受管连接，随后等待销毁事件，避免用到已释放的 webContents。
          const second = await env.createWindow(scope, "sampling");
          env.model.plans.push({ key: "isolated", delayed: true });
          const result = sample("isolated");
          await env.model.requests.wait((e) => e.plan?.key === "isolated");
          assert.notEqual(
            env.handles.get(second.webContents.id).instance.token,
            binding("unused").instance.token,
          );
          const reply = await env.evalPage(
            second,
            `window.sample('second',${JSON.stringify(request)})`,
          );
          assert.ok(reply.result);
          const guest = env.guests.get(second.webContents.id)!;
          const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
          await second.webContents.executeJavaScript(
            "window.setAnchors(false,false).then(() => window.clearManaged())",
          );
          await destroyed;
          second.destroy();
          assert.equal((await ui("window.managedState()")).busy, true);
          env.model.release("isolated");
          assert.equal((await result).result.content.text, "answer:isolated");
        },
      );
      await check(
        "finish reason is preserved and sampling never appends main conversation",
        async () => {
          // [契约] 结束原因由模型桩给出，长度截断必须映射为 maxTokens，而不是统一成正常结束。
          // 同时确认通知流里没有模型请求相关事件，采样不进入主对话的事件链路。
          env.model.plans.push({ key: "length", delayed: false, finishReason: "length" });
          assert.equal((await sample("length")).result.stopReason, "maxTokens");
          const after = await env.agent.call("session/read", { sessionId: scope.sessionId });
          assert.deepEqual(after.messages, mainBefore.messages);
          assert.equal(env.agent.approvals.history.length, 0);
          const forbidden = env.agent.notifications.history.filter((e) =>
            /ModelRequest|ModelComplete|model_request/.test(JSON.stringify(e)),
          );
          assert.equal(forbidden.length, 0);
        },
      );
      await check(
        "connection revocation aborts provider and rejects the old credential",
        async () => {
          env.model.plans.push({ key: "revoke", delayed: true });
          const result = sample("revoke");
          await env.model.requests.wait((e) => e.plan?.key === "revoke");
          const old = binding("old");
          // [失败路径] 断开连接要中止进行中的请求，并让旧凭据立即失效；两者缺一都会留下可用的悬挂通道。
          // 旧凭据在断开后再次提交必须被拒绝，而不是返回空结果。
          env.agent.disconnect("sampling");
          assert.ok((await result).error);
          await env.model.aborted.wait((key) => key === "revoke");
          await assert.rejects(() => env.agent.call("mcp/uiSampling", { ...old, request }));
        },
      );
      await check(
        "window teardown releases guests, feeds, and listeners after existing keep-warm deadline",
        async () => {
          await ui(
            "window.setAnchors(false,false).then(() => { window.clearManaged(); return window.waitConnectionsReleased(); })",
          );
          // [资源] 销毁窗口前先清空受管连接，再等待连接释放；顺序反过来会留下无法回收的 guest。
          // guest 计数归零是最后的资源断言，任何泄漏都会让它非零。
          // keep-warm 截止时间仍然生效，这里不缩短也不绕过等待。
          win.destroy();
          assert.equal(env.countGuests(), 0);
        },
      );
      await checkSamplingExtras(env, root, check);
      await writeFile(
        join(root, "sampling-results.json"),
        JSON.stringify(
          {
            coldPageMs,
            checks,
            modelRequests: env.model.requests.history.length,
            approvals: env.agent.approvals.history.length,
            remainingGuests: env.countGuests(),
          },
          null,
          2,
        ),
      );
    } finally {
      // [资源] 结果文件在关闭环境之前写出，避免环境释放后统计数据被清零。
      // finally 保证异常路径同样关闭 agent 与模型进程；关闭自身失败会掩盖原始错误，需从日志区分。
      // 进程退出码由成功路径的零与兜底路径的一分别决定，断言框架之外的失败不会被吞成成功。
      await env.close();
    }
    app.exit(0);
  })
  // [失败路径] 兜底只输出栈并返回非零退出码，不做任何重试；外部测试框架依赖退出码判断结果。
  // 这里不覆盖结果文件，保留第一次失败转储，防止后续错误掩盖真实根因。
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
