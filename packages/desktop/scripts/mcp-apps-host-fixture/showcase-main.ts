// MCP Apps 宿主 E2E 夹具入口：在真实 Electron 主进程里拉起受管环境，加载 Showcase 页面并逐项点按驱动。
// 职责是把「真实 Agent + 真实宿主 + 真实页面」串成一条可回放的验收链路，并输出截图与结果 JSON。
// 不负责：不实现被测页面与桥接协议，不伪造权限审批、工具调用或模型响应，也不替代单元测试。
// 不负责：不做断言库封装与重试框架，任何用例失败都直接抛错终止整轮。
// 观测口径：所有结论都来自真实进程边界（page、webContents、Agent 事件、provider 请求记录）。
// 运行前置：由宿主脚本按 root、profile、node、cli、serverScript 顺序传入参数，缺一不可。
//
// INV-01 断言：只放行 durationMs=10000 或 filter=all 或以 showcase-page 开头的权限请求 —— 守住它的位置：client.onRequest 白名单分支 —— 改错故障：放宽条件会让权限用例永远绿，真实越权不再暴露。
// INV-02 断言：会话必须显式携带 serverScript 与 ui://showcase/cases.html —— 守住它的位置：agent.session 调用参数 —— 改错故障：资源 URI 漂移会让页面取不到演示用例，全部用例以超时收场。
// INV-03 断言：会话模型必须取 env.model.selection —— 守住它的位置：session/setModel 调用 —— 改错故障：模型不一致会让采样断言匹配不到 gpt-4o 响应。
// INV-04 断言：同一窗口内反复切换布局不得重建页面 —— 守住它的位置：二十次 setAnchors 循环后的四项比对 —— 改错故障：重建会换掉 boot-id，页面堆、输入与滚动状态全部被重置。
// INV-05 断言：重新加载必须先等旧 guest 的 destroyed 事件再读新 boot-id —— 守住它的位置：retryManaged 之后的等待 —— 改错故障：抢读会拿到旧 id，存储重建用例变成假通过。
// INV-06 断言：写入后 localStorage 与 IndexedDB 必须回读到同一个值 —— 守住它的位置：storage-write 断言块 —— 改错故障：只校验一种后端会漏掉 IndexedDB 持久化回归。
// INV-07 断言：删除只允许清理实验样本，回读结果必须双双为 null —— 守住它的位置：storage-delete 断言 —— 改错故障：越界删除会污染同一 profile 下的其他目录。
// INV-08 断言：取消工具调用必须产生 cancelToolCall 桥事件 —— 守住它的位置：check-cancel 之后的事件等待 —— 改错故障：只等 UI 状态会把桥事件丢失掩盖成通过。
// INV-09 断言：取消后必须能再次发起并完成同一个工具 —— 守住它的位置：第二次 check-start 与 complete 断言 —— 改错故障：残留运行态会让第二次点击直接失败。
// INV-10 断言：采样只能改页面历史，不得写入主会话消息 —— 守住它的位置：before 与 after 的 session/read 比对 —— 改错故障：写穿主会话会污染后续轮次上下文。
// INV-11 断言：带图采样必须携带 data:image/png;base64 内容 —— 守住它的位置：最后一轮 messages 序列化断言 —— 改错故障：附件被裁掉时纯文本断言仍会通过。
// INV-12 断言：不支持的采样参数必须在触达 provider 之前被拒 —— 守住它的位置：sampling-reject 与请求计数比对 —— 改错故障：放行会消耗真实额度并掩盖校验缺失。
// INV-13 断言：采样取消必须中止 provider 且不写入失败历史 —— 守住它的位置：aborted 等待与空历史断言 —— 改错故障：失败条目入史会让用户看到幽灵回答。
// INV-14 断言：失败演示只预填工具提示词，不得自动发送 —— 守住它的位置：failure-prepare 之后读取输入框 —— 改错故障：自动发送会多出一轮真实请求，打乱后续计数。
// INV-15 断言：演示模式切到 pending 后用例数必须收敛为 2 —— 守住它的位置：case-mode 变更后的元素计数 —— 改错故障：过滤失效会让详情全部命中，无法定位单例。
// INV-16 断言：展示态切换不得重建页面，boot-id 必须保持不变 —— 守住它的位置：dark/zh-CN/320 断言段 —— 改错故障：重载会丢失页面内状态并让截图失真。
// INV-17 断言：320px 窄屏下文档不得出现横向溢出 —— 守住它的位置：scrollWidth 与 innerWidth 比较 —— 改错故障：溢出会让右侧按钮点不到，用例随机超时。
// INV-18 断言：页面工具的完成与取消都必须等到 turn.terminal 遥测 —— 守住它的位置：notifications.wait 过滤条件 —— 改错故障：提前断言会把异步收尾误判为成功。
// INV-19 断言：页面工具的取消分支不得改写 page-note —— 守住它的位置：两条分支共用的一条断言 —— 改错故障：取消也写入会让「取消失效」被掩盖。
// INV-20 断言：无论成败都必须先关闭环境再退出进程 —— 守住它的位置：外层 finally 与两处 app.exit —— 改错故障：跳过 close 会留下孤儿子进程并占用端口。
//
// 阅读顺序：先看文件头不变量，再按 check 注册顺序自上而下对照页面按钮 id。
// 失败定位：超时错误只带用例名，先看截图与结果 JSON，再回看该用例内的 phase 等待点。
// 全部等待都基于 DOM 变更、主进程事件或页面信号，禁止用固定睡眠掩盖时序问题。
import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";

const [root, profile, node, cli, serverScript] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // [资源] 受管环境持有一条 CLI 子进程与临时 profile，只能由最后的 finally 统一释放。
    // [资源] 这一行失败时 env 尚未赋值，外层 finally 不会执行 close，进程随 app.exit 一起退出。
    // [权衡] 不要为图稳提前在 catch 里手动 kill，重复释放会让真实退出码被吞掉。
    // [契约] root、node、cli 来自 argv 顺序解构，位置错一个就会把工作区指到别处。
    const env = await managedEnvironment(root, node, cli);
    const checks: string[] = [];
    try {
      // 独立 fixture 只批准本测试的两个演示工具；审批仍通过真实 Agent/宿主链路。
      // [契约] 这里只模拟「用户点了允许」，审批链路本身仍走真实 Agent，不做短路。
      // [契约] 白名单三个条件都是演示页固定的取值，任一放宽都会让权限用例失去区分度。
      // [失败路径] 未命中的请求保持挂起，用例会以超时暴露，而不是静默通过。
      // [权衡] 不要改成无条件放行，那会让「拒绝后才出现的行为」在 E2E 里永远观察不到。
      env.agent.client.onRequest((request) => {
        const input = (request.params as any)?.input;
        if (
          request.method === "interaction/requestPermission" &&
          (input?.durationMs === 10_000 ||
            input?.filter === "all" ||
            String(input?.key).startsWith("showcase-page"))
        )
          void env.agent.respond(request, "allow");
      });
      // [契约] serverScript 与 resourceUri 必须成对传入，页面内容由宿主按 URI 解析。
      // [契约] 工作区固定为 showcase-workspace，避免复用开发者本地目录产生脏数据。
      // [失败路径] URI 写错时页面空白，症状是元素数为 0 而不抛错，需要先看截图。
      // [权衡] 不要在此处额外开会话，一次用例只应有一个 scope 以稳定事件计数。
      const scope = await env.agent.session(
        join(root, "showcase-workspace"),
        "showcase",
        "showcase",
        undefined,
        {
          serverScript,
          resourceUri: "ui://showcase/cases.html",
        },
      );
      await env.agent.call("session/setModel", {
        sessionId: scope.sessionId,
        model: env.model.selection,
      });
      // [契约] 窗口创建后 guest 与 webContents.id 绑定，后续 guest 断言都以该 id 为锚。
      // [契约] 第二个参数决定采样能力声明，换档位会让 sampling-capability 文案断言失效。
      // [资源] 窗口由 env 统一托管，用例内不要手动 close，否则 finally 里会二次关闭。
      // [失败路径] 创建后立刻取 guest 可能为空，必须等页面就绪后再读取。
      const win = await env.createWindow(scope, "sampling");
      const page = (code: string) => env.evalPage(win, code);
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const click = (id: string) => page(`document.getElementById(${JSON.stringify(id)}).click()`);
      const value = (id: string, text: string) =>
        page(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(text)}`);
      const read = (id: string) =>
        page(`document.getElementById(${JSON.stringify(id)}).textContent`);
      // DOM 事件驱动观察实际按钮处理的终态，不用睡眠代替请求完成。
      // [契约] 该函数在页面内用 MutationObserver 等待 data-phase 命中目标值。
      // [契约] 命中后立即 disconnect，避免观察器泄漏影响后续用例的状态判断。
      // [失败路径] 若状态永远不达目标，Promise 不会自行结束，靠外层 check 的超时兜底。
      // [权衡] 不用轮询与睡眠，是为了让失败保留真实时序而不是被等待掩盖。
      const phase = (id: string, wanted: string) =>
        page(`new Promise(resolve => {
      const node=document.getElementById(${JSON.stringify(id)});
      const check=()=>{if(node.dataset.phase===${JSON.stringify(wanted)}){observer.disconnect();resolve(node.textContent)}};
      const observer=new MutationObserver(check);observer.observe(node,{attributes:true,childList:true,subtree:true});check();
    })`);
      // [失败路径] 每个用例有 20 秒硬超时，错误信息带用例名，直接对回下面的 check 调用。
      // [资源] 定时器在 finally 中清理，防止成功路径残留定时器拖住进程退出。
      // [契约] 只有成功才 push 到 checks 并打印 PASS，失败不会出现在结果 JSON 里。
      // [权衡] 不做重试，一次失败即中断，避免同一缺陷在多个用例里重复刷屏。
      const check = async (name: string, run: () => Promise<void>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 20_000);
            }),
          ]);
          checks.push(name);
          process.stdout.write(`PASS Showcase ${name}\n`);
        } finally {
          clearTimeout(timer);
        }
      };
      // [契约] 用例总数固定 53，前后各断言一次，避免筛选与渲染互相掩盖。
      // [契约] 逐个点击 SC01 到 SC53，且详情文本必须回显对应编号。
      // [失败路径] 用例缺失时详情会保留上一条，正则能抓住这种「貌似点击成功」的假象。
      // [权衡] 循环内不复位列表，依赖页面自身单选语义，改页面结构需同步改这里。
      await check("built HTML connects once and all 53 cases have reachable details", async () => {
        assert.equal(await page("document.querySelectorAll('[data-case-id]').length"), 53);
        assert.match(await read("connection"), /Connected|已连接/);
        assert.equal(await page("document.querySelectorAll('[data-case-id]').length"), 53);
        for (let index = 1; index <= 53; index++) {
          const id = `SC${String(index).padStart(2, "0")}`;
          await page(`document.querySelector('[data-case-id="${id}"]').click()`);
          assert.match(await read("case-detail"), new RegExp(id));
        }
        await value("case-mode", "pending");
        await page("document.getElementById('case-mode').dispatchEvent(new Event('change'))");
        assert.equal(await page("document.querySelectorAll('[data-case-id]').length"), 2);
        assert.equal(await page("document.getElementById('send-demo').disabled"), true);
        await value("case-mode", "all");
        await page("document.getElementById('case-mode').dispatchEvent(new Event('change'))");
      });
      // [并发] 二十次 setAnchors 交替切换内外布局，模拟真实拖拽带来的重排压力。
      // [契约] 结束后 guest id、boot-id、堆计数、输入值与滚动位置必须逐项保持。
      // [失败路径] 任一状态回退都说明页面被重建，只比 guest id 不够，必须全量比对。
      // [权衡] 不等待动画帧结束，断言的是终态而非过程，帧等待会引入不稳定。
      await check("page heap, input, local scroll and guest survive twenty moves", async () => {
        const boot = await read("boot-id");
        const guest = env.guests.get(win.webContents.id)!.id;
        await click("heap-bump");
        await value("heap-input", "retained by the actual Showcase page");
        await page("document.getElementById('heap-scroll').scrollTop=90");
        for (let i = 0; i < 20; i++) await ui(`window.setAnchors(${i % 2 !== 0},${i % 2 === 0})`);
        assert.equal(env.guests.get(win.webContents.id)!.id, guest);
        assert.equal(await read("boot-id"), boot);
        assert.equal(await read("heap-count"), "1");
        assert.equal(
          await page("document.getElementById('heap-input').value"),
          "retained by the actual Showcase page",
        );
        assert.equal(await page("document.getElementById('heap-scroll').scrollTop"), 90);
      });
      await check(
        "real storage buttons round-trip, rebuild and delete only lab samples",
        async () => {
          await value("storage-value", "persistent sample");
          await click("storage-write");
          assert.deepEqual(JSON.parse(await phase("storage-result", "complete")), {
            localStorage: "persistent sample",
            indexedDB: "persistent sample",
          });
          // [事务] 重新加载前先记录旧 boot 与旧 guest，作为「确实重建过」的证据。
          // [资源] destroyed 的 Promise 必须在触发前注册，避免事件早于监听导致永久挂起。
          // [契约] 新页面就绪以 waitManagedPhase 与 showcaseReady 两个信号为准。
          // [失败路径] 若新旧 boot 相同，说明重载没生效，存储断言会变成同进程内的假通过。
          const oldBoot = await read("boot-id");
          const oldGuest = env.guests.get(win.webContents.id)!;
          const destroyed = new Promise<void>((resolve) => oldGuest.once("destroyed", resolve));
          await ui("window.retryManaged()");
          await destroyed;
          await ui("window.waitManagedPhase('running')");
          await page("window.showcaseReady");
          assert.notEqual(await read("boot-id"), oldBoot);
          await click("storage-read");
          assert.deepEqual(JSON.parse(await phase("storage-result", "complete")), {
            localStorage: "persistent sample",
            indexedDB: "persistent sample",
          });
          await click("storage-delete");
          assert.deepEqual(JSON.parse(await phase("storage-result", "complete")), {
            localStorage: null,
            indexedDB: null,
          });
        },
      );
      await check(
        "actual App long-tool button cancels through Agent and can complete a new call",
        async () => {
          // [契约] 先取事件历史水位，再触发动作，最后只匹配该位置之后的 cancelToolCall。
          // [失败路径] 不做全量历史匹配，否则上一轮残留事件会让取消断言提前满足。
          // [契约] UI 状态先到 cancelled，桥事件随后到达，两者都要等齐。
          // [权衡] 顺序不可颠倒，先等事件再点取消会跨越到下一次调用。
          const after = env.events.history.length;
          await click("check-start");
          await phase("check-status", "running");
          await click("check-cancel");
          await phase("check-status", "cancelled");
          await env.events.wait(
            (event) => event.type === "bridge" && event.method === "cancelToolCall",
            after,
          );
          await click("check-start");
          assert.match(await phase("check-status", "complete"), /completed/);
        },
      );
      // [契约] 采样前后的主会话消息必须完全一致，这是「页面历史与主对话隔离」的唯一证据。
      // [契约] 两轮采样分别断言消息条数为 1 与 3，图像附件只加在第二轮。
      // [失败路径] 只断言页面历史会漏掉写穿，必须回到 session/read 比对。
      // [权衡] 重置后历史应为空字符串，不要断言长度，页面可能保留占位节点。
      const before = await env.agent.call("session/read", { sessionId: scope.sessionId });
      await check(
        "sampling buttons send completed page history and demo image, not main chat",
        async () => {
          for (let i = 0; i < 2; i++) {
            env.model.plans.push({ key: `showcase-${i}`, delayed: false });
            await value("sampling-prompt", `question ${i}`);
            if (i === 1) await click("sampling-image");
            await click("sampling-send");
            assert.match(await phase("sampling-status", "complete"), /gpt-4o/);
            assert.equal(env.model.requests.history.at(-1).body.messages.length, i * 2 + 1);
          }
          assert.match(
            JSON.stringify(env.model.requests.history.at(-1).body.messages),
            /data:image\/png;base64/,
          );
          assert.match(await read("sampling-history"), /answer:showcase-1/);
          const after = await env.agent.call("session/read", { sessionId: scope.sessionId });
          assert.deepEqual(after.messages, before.messages);
          await click("sampling-reset");
          assert.equal(await read("sampling-history"), "");
        },
      );
      await check(
        "actual sampling cancellation aborts provider and excludes failed history",
        async () => {
          env.model.plans.push({ key: "showcase-cancel", delayed: true });
          await value("sampling-prompt", "cancel this request");
          await click("sampling-send");
          await env.model.requests.wait((event) => event.plan?.key === "showcase-cancel");
          await click("sampling-cancel");
          await phase("sampling-status", "cancelled");
          await env.model.aborted.wait((key) => key === "showcase-cancel");
          env.model.release("showcase-cancel");
          assert.equal(await read("sampling-history"), "");
        },
      );
      await check("unsupported sampling controls reject before reaching the provider", async () => {
        // [契约] 三个非法参数依次尝试拒绝，每次都要回到 rejected 状态才继续下一项。
        // [契约] 结束后 provider 请求计数必须不变，证明拦截发生在发出之前。
        // [失败路径] 若计数增加说明校验缺失，会真实消耗额度并污染后续采样断言。
        // [权衡] 不校验错误文案，只校验未触达 provider，避免文案改动造成脆弱用例。
        const requests = env.model.requests.history.length;
        for (const invalid of ["temperature", "tools", "audio"]) {
          await value("sampling-invalid", invalid);
          await click("sampling-reject");
          await phase("sampling-status", "rejected");
        }
        assert.equal(env.model.requests.history.length, requests);
        assert.equal(await read("sampling-history"), "");
      });
      await check(
        "failure controls prepare the selected model tool without sending automatically",
        async () => {
          await value("failure-mode", "fullscreen");
          await click("failure-throw");
          await click("failure-prepare");
          // [契约] 失败演示只把工具名与参数填进输入框，发送动作留给人工或后续用例。
          // [契约] throwError 必须为字面 true，否则演示走不到抛错分支。
          // [失败路径] 一旦自动发送就会多出一次真实轮次，污染后面的模型请求计数。
          // [权衡] 这里直接读 DOM 值而不是读回显，是因为回显会被格式化。
          const prompt = await page("document.getElementById('demo-prompt').value");
          assert.match(prompt, /show_failure_fullscreen/);
          assert.match(prompt, /"throwError":true/);
        },
      );
      await check(
        "live host context switches Chinese/dark at 320px without horizontal overflow",
        async () => {
          const boot = await read("boot-id");
          await ui("window.setShowcasePresentation('dark','zh-CN',320)");
          assert.equal(await page("document.documentElement.lang"), "zh-CN");
          assert.equal(await page("document.documentElement.style.colorScheme"), "dark");
          assert.equal(
            await page("getComputedStyle(document.body).backgroundColor"),
            "rgb(23, 25, 28)",
          );
          assert.match(await read("connection"), /已连接/);
          assert.match(await read("case-detail"), /SC35/);
          assert.match(await read("sampling-capability"), /宿主声明/);
          assert.equal(await read("boot-id"), boot);
          assert.equal(
            await page("document.documentElement.scrollWidth <= window.innerWidth"),
            true,
          );
          await writeFile(
            join(root, "showcase-dark-320.png"),
            (await win.webContents.capturePage()).toPNG(),
          );
          await ui("window.setShowcasePresentation('light','en-US',400)");
        },
      );
      await check(
        "real model discovers page tool, completes on click and cancels without changing the note",
        async () => {
          const command = (type: string, payload: unknown) =>
            env.agent.call("v4/command", {
              commandId: randomUUID(),
              clientId: "showcase-e2e",
              sessionId: scope.sessionId,
              type,
              payload,
              issuedAt: Date.now(),
            });
          // [契约] 同一用例内跑完成与取消两条分支，确保工具注册表在取消后可复用。
          // [契约] 每轮都等 turn.terminal 遥测，并按水位过滤本会话事件。
          // [失败路径] 提前断言 page-note 会把异步收尾误判成功，取消分支尤其明显。
          // [并发] 模型计划按 key 延迟释放，取消分支依赖 stop 命令打断进行中的调用。
          for (const cancel of [false, true]) {
            const key = cancel ? "showcase-page-cancel" : "showcase-page-complete";
            const after = env.agent.notifications.history.length;
            env.model.plans.push({ key, delayed: true });
            const ack = await command("sendText", {
              text: key,
              modelSelection: env.model.selection,
              mode: "build",
            });
            assert.equal(ack.status, "accepted");
            await phase("page-tool-status", "running");
            if (cancel) {
              await command("stop", {});
              await phase("page-tool-status", "cancelled");
            } else {
              await click("page-tool-finish");
              await phase("page-tool-status", "complete");
            }
            await env.agent.notifications.wait(
              (event) =>
                event.method === "v4/telemetry/event" &&
                event.params.kind === "turn.terminal" &&
                event.params.sessionId === scope.sessionId,
              after,
            );
            assert.equal(await read("page-note"), "showcase-page-complete");
          }
        },
      );
      await check(
        "legacy dashboard still handshakes and its real refresh button renders four services",
        async () => {
          // [契约] 旧版 dashboard 用独立窗口创建，验证与主窗口并存的兼容性。
          // [契约] 刷新后表格固定四行，且 window.openai.callTool 必须存在。
          // [资源] 该窗口不在用例内关闭，交由 env.close 统一回收。
          // [失败路径] 双 requestAnimationFrame 只用于等绘制完成，不能挪到取数之前当等待用。
          const legacy = await env.createWindow(
            { ...scope, resourceUri: "ui://showcase/dashboard.html" },
            "sampling",
          );
          await env.evalPage(legacy, "window.zcode.ready()");
          await env.evalPage(
            legacy,
            `document.getElementById('refresh').click(); new Promise(resolve => {
        const rows=document.getElementById('rows');const check=()=>{if(rows.children.length===4){observer.disconnect();resolve(true)}};
        const observer=new MutationObserver(check);observer.observe(rows,{childList:true});check();
      })`,
          );
          assert.equal(
            await env.evalPage(legacy, "document.querySelectorAll('#rows tr').length"),
            4,
          );
          assert.equal(await env.evalPage(legacy, "typeof window.openai.callTool"), "function");
          await env.evalPage(
            legacy,
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          await writeFile(
            join(root, "showcase-legacy.png"),
            (await legacy.webContents.capturePage()).toPNG(),
          );
        },
      );
      await writeFile(
        join(root, "showcase-lab.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      // [资源] 结果 JSON 在 finally 之前写出，即使 close 抛错也保留已完成的用例清单。
      // [契约] checks 只包含通过的用例名，与 stdout 的 PASS 行一一对应。
      // [契约] 附带模型请求数与审批次数，便于判断失败是否由额外轮次引起。
      // [失败路径] 写盘异常会覆盖原始断言错误，排障时优先看 stderr 栈顶。
      await writeFile(
        join(root, "showcase-results.json"),
        JSON.stringify(
          {
            checks,
            modelRequests: env.model.requests.history.length,
            approvals: env.agent.approvals.history.length,
          },
          null,
          2,
        ),
      );
    // [资源] 无论用例是否抛错都执行 env.close，释放 guest、窗口与 CLI 子进程。
    // [资源] close 自身抛错会覆盖原始异常，定位时先判断是否为清理阶段失败。
    // [契约] 关闭完成后才允许退出进程，否则会留下孤儿进程占用端口。
    // [权衡] 不在 catch 里吞错，退出码统一由外层 catch 决定。
    } finally {
      await env.close();
    }
    // [契约] 正常结束使用退出码 0，失败路径由外层 catch 使用退出码 1。
    // [契约] 退出前环境已关闭，避免退出码正确但进程残留。
    // [失败路径] 用例失败不会走到这里，成功断言不能依赖本行之后的行为。
    // [权衡] 使用 app.exit 而不是 app.quit，是为了跳过关窗确认，保证 CI 不阻塞。
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
