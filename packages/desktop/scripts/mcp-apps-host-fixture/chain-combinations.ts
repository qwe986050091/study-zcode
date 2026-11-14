// INV-01 组合场景按固定顺序串行执行，前一场景失败即整批中止，不并发跑多个用例；守住位置：每个 await check 调用；改错故障：失败被后续 PASS 掩盖，结果文件与真实状态不符
// INV-02 审批等待只按调用键匹配，不看下标与到达顺序；守住位置：approval 闭包与首条用例；改错故障：并发审批互相串食，放行落到错误调用上
// INV-03 事件等待同时匹配 type 与 key，少一个条件就会提前放行；守住位置：event 闭包；改错故障：前一场景的残余事件满足后一场景，断言在有竞态时随机通过
// INV-04 执行次数一律取历史记录的实时过滤计数，且只接受 1；守住位置：executions 与各处断言；改错故障：漏执行或重放被当成正常结果
// INV-05 取消参数必须从调用流水反查原始入参，裁掉工具名与实参后原样下发；守住位置：cancel 闭包；改错故障：手写字段与生产形状漂移，取消打到不存在的调用
// INV-06 同一调用取消两次，第二次必须返回 false；守住位置：竞态循环与原始错误用例尾部；改错故障：取消不幂等，状态机出现二义
// INV-07 取消键在调用流水中只允许命中一条，找不到就抛错而不是静默跳过；守住位置：cancel 内的查找与解构；改错故障：取消落到 undefined，真实原因被藏成类型错误
// INV-08 moving 固定 12 次切换，偶数页与奇数页的读数必须分别与首轮快照一致；守住位置：moving 循环体；改错故障：页面被重挂载导致计数漂移却无人发现
// INV-09 首轮快照按页面侧缓存在 before 表里，之后每轮对照，而不是与硬编码常量比较；守住位置：moving 的首次写入分支；改错故障：页面初始计数一变，整组断言集体失效
// INV-10 12 次切换期间句柄与 guest 身份必须逐轮不变；守住位置：moving 内两条身份断言；改错故障：页面被重建，用户看到宿主侧句柄失效、操作无响应
// INV-11 切换期间的 read 事件总数必须与进入 moving 时的快照相等；守住位置：moving 的 reads 快照与尾部断言；改错故障：每次切换都重读资源，MCP 进程被无谓唤醒
// INV-12 注入动作只发生在第 5 轮，让动作落在切换序列中段；守住位置：moving 的 i 判断；改错故障：动作发生在稳态之外，竞态路径根本没被覆盖
// INV-13 审批挂起用例必须先断言执行数为 0 再放行，最后校验结果为 1；守住位置：首条用例；改错故障：审批前已经执行，权限闸门形同虚设
// INV-14 执行中用例必须等 executed 事件后再释放连接，且全程不得出现 cancelled；守住位置：第二条用例；改错故障：成功调用被误记成已取消，用户看到结果凭空消失
// INV-15 通知用例固定 5 轮投递与等待，input 与 result 都必须是 0 到 4 的完整序列；守住位置：第三条用例；改错故障：丢帧或重号被吞掉，通知链路看似通畅
// INV-16 三种竞态共用一套收尾断言：released 之后取消必须为 false，重放必须被拒；守住位置：ordering 循环尾部；改错故障：赢家不同导致收尾行为分叉，只有部分次序通过
// INV-17 跨窗口用例必须证明一侧 dispose 不影响另一侧 guest，且两侧执行数恒为 1；守住位置：two windows 用例；改错故障：跨窗口串页，用户看到别的窗口页面被关掉
// INV-18 伪造凭据按字段逐个提交，每次拒绝后立刻用真实 instance 复验；守住位置：forged credential 用例；改错故障：一次失败污染实例，后续合法调用也被牵连拒绝
//
// 本文件是被 chain-main 在身份矩阵之后调用的场景层：只做断言，不自建窗口也不自建 Agent。
// 组合维度只有三处显式枚举：移动轮次、竞态次序、伪造字段，数组顺序即执行顺序，改序等于改报告阅读顺序。
// 任何键名重复都会让审批等待与事件等待命中同一条记录，因此键一律带场景前缀，且全文件唯一。
// 输入契约固定为单个 context 对象，新增依赖只能从它取，不在文件内另立状态，避免与宿主侧两张表分叉。
import assert from "node:assert/strict";
import type { BrowserWindow, WebContents } from "electron";
import type { startAgent } from "./agent.js";

// 入参是单一 context 对象，十项依赖全部显式注入，不从模块作用域偷取
// 新增依赖必须同步回调用点的实参，漏传会在解构处立刻变成 undefined
// 本函数不建窗也不关窗，窗口生命周期归调用方，避免双重清理
export async function checkCombinations(context: {
  agent: Awaited<ReturnType<typeof startAgent>>;
  win: BrowserWindow;
  scope: any;
  handles: Map<number, any>;
  guests: Map<number, WebContents>;
  calls: any[];
  bridge: any;
  wire(params: any): any;
  evalPage(win: BrowserWindow, code: string): Promise<any>;
  createWindow(scope: any): Promise<BrowserWindow>;
  closeWindow(win: BrowserWindow): Promise<void>;
  check(name: string, run: () => Promise<void>): Promise<void>;
}) {
  // 一次性解构十项，是本文件唯一的依赖入口，后续全部走这些别名
  // handles 与 guests 都以宿主 webContents.id 为键，读写必须成对使用
  // calls 是调用入参的累计流水，取消与重放校验都从它反查原始形状
  const { agent, win, scope, handles, guests, calls, bridge, wire, evalPage, check } = context;
  // 审批等待只按参数里的键匹配，与到达先后无关，因此键必须全文件唯一
  // 谓词用可选链读入参，缺键的审批不会被误认成目标调用
  const approval = (key: string) => agent.approvals.wait((r) => r.params.input?.key === key);
  // 事件等待同时匹配类型与键，只看类型会让上一场景的残余事件提前放行
  // 谓词无副作用，重复等待不会消费历史记录
  const event = (type: string, key: string) =>
    agent.events.wait((e) => e.type === type && e.key === key);
  // 执行计数取历史记录的实时过滤值，不做本地累加，避免与真实流水分叉
  // 全文件只接受计数为 1，0 与 2 分别代表漏执行和重放
  const executions = (key: string) =>
    agent.events.history.filter((e) => e.type === "executed" && e.key === key).length;
  // 取消参数从调用流水反查后裁掉工具名与实参，只保留绑定字段
  // 用解构丢弃而不是删字段，保持入参对象不被就地修改
  // 键找不到时解构 undefined 会直接抛错，这是刻意的失败路径而非兜底
  const cancel = (key: string) => {
    const {
      toolName: _tool,
      arguments: _args,
      ...binding
    } = calls.find((c) => c.arguments.key === key);
    return bridge.cancelToolCall(binding);
  };
  // 身份与读数都在进入循环前取一次，循环内只比对不重取，才能证明页面没被重建
  // 每轮先把读数按偶奇两页写入 before，之后同页读数必须完全相等
  // 注入动作只挂在第 5 轮，动作与切换落在同一窗口，覆盖最易被忽略的时序
  // 每轮同时校验句柄、guest 身份与 read 总数，三条一起构成未重挂载的证据
  async function moving(action?: () => Promise<unknown>) {
    // 身份与读数在循环外取一次，循环内只比对，重挂会让句柄或 guest 失配
    const identity = handles.get(win.webContents.id);
    const guest = guests.get(win.webContents.id)!.id;
    const reads = agent.events.history.filter((e) => e.type === "read").length;
    const before = new Map<boolean, unknown>();
    for (let i = 0; i < 12; i++) {
      const move = win.webContents.executeJavaScript(`window.switchPage(${i % 2 === 0})`);
      if (i === 5 && action) await action();
      const { dispatchMs: _time, ...counts } = await move;
      const side = i % 2 === 0;
      if (!before.has(side)) before.set(side, counts);
      assert.deepEqual(counts, before.get(side));
      assert.deepEqual(handles.get(win.webContents.id), identity);
      assert.equal(guests.get(win.webContents.id)!.id, guest);
      assert.equal(agent.events.history.filter((e) => e.type === "read").length, reads);
    }
  }
  await check(
    // 场景键 move-approval 唯一，审批等待与执行计数都靠它定位
    // 先持有结果的 Promise 再等审批，保证请求确实已经在页面侧发出
    // 移动前断言执行数为 0、移动后断言为 1，中间夹着放行，顺序颠倒就测不到审批期间
    "approval pending and allow during 12 location changes preserves one invocation",
    async () => {
      const key = "move-approval";
      const result = evalPage(win, `window.callTool('${key}')`);
      const request = await approval(key);
      await moving(async () => {
        assert.equal(executions(key), 0);
        await agent.respond(request, "allow");
      });
      assert.equal((await result).result.structuredContent.key, key);
      assert.equal(executions(key), 1);
    },
  );
  await check(
    // 先写 widget 再发起调用，切换结束后才能校验目标状态没有被重置
    // 放行后等 executed 事件再进入移动，确保切换发生在真实执行期间
    // 释放连接后等 released 事件，末尾再确认 cancelled 事件从未出现
    "executing tool and result during 12 location changes preserves target and state",
    async () => {
      const key = "move-executing";
      await evalPage(win, "window.saveWidget({moving: 9})");
      const result = evalPage(win, `window.callTool('${key}',true)`);
      await agent.respond(await approval(key), "allow");
      await event("executed", key);
      await moving(async () => {
        agent.release("source-a", key);
        await event("released", key);
      });
      assert.equal((await result).result.structuredContent.key, key);
      assert.equal(executions(key), 1);
      assert.deepEqual(await win.webContents.executeJavaScript("window.savedWidget()"), {
        moving: 9,
      });
      assert.equal(
        agent.events.history.some((e) => e.type === "cancelled" && e.key === key),
        false,
      );
    },
  );
  await check(
    // 5 轮投递各自紧跟一次等待，逐轮同步，批量投递会掩盖丢帧
    // 末尾一次比对两个数组，缺号或重号都会在这里暴露
    "tool input and result notifications arrive during movement without remount",
    async () => {
      await moving(async () => {
        for (let n = 0; n < 5; n++) {
          await win.webContents.executeJavaScript(`window.deliverFeed(${n})`);
          await evalPage(win, `window.waitFeed(${n})`);
        }
      });
      assert.deepEqual(await evalPage(win, "window.receivedFeed"), {
        input: [0, 1, 2, 3, 4],
        result: [0, 1, 2, 3, 4],
      });
    },
  );
  // 三个次序是显式枚举的组合维度，数组顺序即执行顺序，增删会改变报告顺序
  // 场景键由前缀加次序拼成，保证三种竞态互不共享审批与事件
  // 循环体内先等 executed 再分支，让三种次序从同一个已执行状态出发
  for (const ordering of ["result-first", "cancel-first", "concurrent"]) {
    await check(`cancel/result race ${ordering} has one terminal and no replay`, async () => {
      const key = `race-${ordering}`;
      const result = evalPage(win, `window.callTool('${key}',true)`);
      await agent.respond(await approval(key), "allow");
      await event("executed", key);
      if (ordering === "result-first") {
        agent.release("source-a", key);
        assert.ok((await result).result);
        assert.equal((await cancel(key)).cancelled, false);
      } else if (ordering === "cancel-first") {
        assert.equal((await cancel(key)).cancelled, true);
        await event("cancelled", key);
        assert.ok((await result).error);
        agent.release("source-a", key);
      } else {
        // 并发分支同时发出取消与释放，不假设谁先到，也不加固定延时
        // 用取消回执的布尔值反推页面终态，错误结果与成功结果必须恰好互补
        // 互斥断言写在一起，任何一方为真而另一方也为真都会立即失败
        // 同一轮发出，允许任一合法赢家；以 Agent 的取消接纳结果核对页面终态。
        const cancellation = cancel(key);
        agent.release("source-a", key);
        // [并发] cancel 与 release 同轮发出：终态由 ack.cancelled 反推；两个断言必须互补，不假设谁先到达。
        const [ack, response] = await Promise.all([cancellation, result]);
        assert.equal(Boolean(response.error), ack.cancelled);
        assert.equal(Boolean(response.result), !ack.cancelled);
      }
      await event("released", key);
      assert.equal((await cancel(key)).cancelled, false);
      await assert.rejects(() =>
        agent.call("mcp/uiCallTool", wire(calls.find((c) => c.arguments.key === key))),
      );
      assert.equal(executions(key), 1);
      assert.equal(await win.webContents.executeJavaScript("window.pageBusy()"), false);
    });
  }
  // 原始错误结果不截断不改写，三个内容项与结构化字段、元数据全量比对
  // 执行计数仍为 1，证明错误结果同样只对应一次真实调用
  await check("raw MCP error and mixed content preserve result semantics", async () => {
    const key = "raw-error";
    const result = evalPage(win, `window.callTool('${key}')`);
    await agent.respond(await approval(key), "allow");
    const response = await result;
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, {
      isError: true,
      content: [
        { type: "text", text: "fixture error" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        {
          type: "resource",
          resource: { uri: "fixture://error", mimeType: "text/plain", text: "details" },
        },
      ],
      structuredContent: { key, source: "source-a" },
      _meta: { fixture: true },
    });
    assert.equal(executions(key), 1);
  });
  await check(
    // 第二个窗口复用同一 scope，但必须拿到独立 guest 与独立句柄
    // 用对方的沙箱与初始化标识发起 dispose，必须因代际不匹配被丢弃
    // 取消第一个调用后，第二个窗口页面仍应繁忙，证明两侧互不牵连
    // 收尾统一走关窗函数，断言中途失败也不留下窗口
    "two windows executing: cross-owner dispose and cancellation cannot touch peer",
    async () => {
      const second = await context.createWindow(scope);
      try {
        const firstResult = evalPage(win, "window.callTool('peer-first',true)");
        const secondResult = evalPage(second, "window.callTool('peer-second',true)");
        await agent.respond(await approval("peer-first"), "allow");
        await agent.respond(await approval("peer-second"), "allow");
        await Promise.all([event("executed", "peer-first"), event("executed", "peer-second")]);
        const other = handles.get(second.webContents.id);
        await win.webContents.executeJavaScript(
          `window.harness.dispose(${JSON.stringify(other.sandboxId)},${other.initId})`,
        );
        assert.ok(!guests.get(second.webContents.id)!.isDestroyed());
        assert.equal((await cancel("peer-first")).cancelled, true);
        assert.ok((await firstResult).error);
        await win.webContents.executeJavaScript("window.disposePage()");
        assert.equal(await second.webContents.executeJavaScript("window.pageBusy()"), true);
        agent.release("source-a", "peer-second");
        assert.equal((await secondResult).result.structuredContent.key, "peer-second");
        assert.equal(executions("peer-first"), 1);
        assert.equal(executions("peer-second"), 1);
        assert.equal((await cancel("peer-second")).cancelled, false);
        await win.webContents.executeJavaScript("window.restorePage(false)");
        await evalPage(win, "window.fixtureReady");
      } finally {
        await context.closeWindow(second);
      }
    },
  );
  // 两个窗口同源但地址不同，先断言主机相同、路径不同，界定测试前提
  // 资源地址由各自地址推导，不手写路径，避免绕过同源约束
  // 正负样本使用同一脚本，差别只在目标地址，排除脚本本身不可用的干扰
  await check("stable same-origin guest cannot load another instance script resource", async () => {
    const second = await context.createWindow(scope);
    try {
      const ownUrl = await evalPage(win, "location.href");
      const peerUrl = await evalPage(second, "location.href");
      assert.equal(new URL(ownUrl).host, new URL(peerUrl).host);
      assert.notEqual(ownUrl, peerUrl);
      // 使用 CSP 本来允许的 self script：避免 connect-src none 让正负样本都失败，掩盖 guest 校验。
      const ownAsset = new URL("__zcode__/alias.js", ownUrl).href;
      const peerAsset = new URL("__zcode__/alias.js", peerUrl).href;
      const loadAsset = (target: BrowserWindow, url: string) =>
        evalPage(
          target,
          `new Promise(resolve => { const s = document.createElement('script'); s.src = ${JSON.stringify(url)}; s.onload = () => { s.remove(); resolve(true); }; s.onerror = () => { s.remove(); resolve(false); }; document.head.append(s); })`,
        );
      assert.equal(await loadAsset(win, ownAsset), true);
      assert.equal(
        await loadAsset(win, `${peerAsset}?uncached=${crypto.randomUUID()}`),
        false,
        "uncached cross-guest request must be denied before checking the shared cache",
      );
      assert.equal(await loadAsset(win, peerAsset), false);
      assert.equal(await loadAsset(second, peerAsset), true);
    } finally {
      await context.closeWindow(second);
    }
  });
  await check(
    // 四个伪造维度逐个提交，每次都必须被拒，不允许合并成一次批量提交
    // 每次拒绝后立刻用真实实例复验，证明拒绝不会吊销合法实例
    "forged credential fields are rejected by real Agent without revoking valid instance",
    async () => {
      const instance = handles.get(win.webContents.id).instance;
      for (const patch of [
        { token: crypto.randomUUID() },
        { runtimeId: "forged" },
        { generation: instance.generation + 100 },
        { appIdentity: "b".repeat(64) },
      ]) {
        await assert.rejects(() =>
          agent.call("mcp/uiValidateInstance", { ...scope, instance: { ...instance, ...patch } }),
        );
        await agent.call("mcp/uiValidateInstance", { ...scope, instance });
      }
    },
  );
}
