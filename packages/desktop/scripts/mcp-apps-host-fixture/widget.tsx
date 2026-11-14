// INV-01 位置：App 单例构造处（name 为 host-fixture、version 为 1.0.0、tools 为空对象）；守住全夹具只有这一个客户端实例与一份连接；改错故障：多建实例会各自连接、各自注册通知处理器，资源与工具回调被重复触发。
// INV-02 位置：samplingCalls 以调用方传入的 key 为键存放 AbortController；守住取消句柄能被 cancelSample 按同一 key 找回；改错故障：键与 sample 入参不一致，取消落空，采样请求一直挂到宿主超时。
// INV-03 位置：sample 的 finally 中删除 samplingCalls 条目；守住成功、采样失败与取消三条路径共用同一清理出口；改错故障：残留条目让 cancelSample 拿到已结束请求的句柄，取消无效且取消表持续增长。
// INV-04 位置：sample 的 catch 分支返回错误对象而不向上抛出；守住页面对宿主的调用永不因异常中断；改错故障：异常穿透会让宿主侧 Promise 直接 reject，测试断言拿不到错误文本。
// INV-05 位置：cancelSample 中对查找结果的可选链式中止；守住 key 不存在时静默返回；改错故障：缺守卫会抛类型错误，测试在调用尚未开始时取消就会失败。
// INV-06 位置：sample、readResourceFixture、callTool 共用的返回形状；守住成功为 result 字段、失败为 error 字段；改错故障：某个入口改回裸结果，测试侧解构 result 得到 undefined，失败原因被吞。
// INV-07 位置：资源通知处理器中先入账再按长度取等待者；守住「事件先记录、再唤醒」的顺序；改错故障：先取等待者后入账会差一条，waitResources 永远等不到目标计数。
// INV-08 位置：resourceWaiters 以绝对累计条数作键而非增量；守住 waitResources 的 count 语义是「期望达到的总条数」；改错故障：按增量注册会让第二次等待的键错位，等待直接超时。
// INV-09 位置：waitResources 中长度已达标即提前返回的分支；守住已满足时同步完成；改错故障：删掉提前返回会让已发生的通知无法唤醒新等待者，测试侧死等。
// INV-10 位置：页工具调用的 delayed 分支；守住只有 delayed 为真才进入挂起等待；改错故障：普通调用也被挂住会让 page_edit 永不返回，宿主侧工具调用整体超时。
// INV-11 位置：abort 监听内先标记 aborted 再拒绝并唤醒；守住标记先于通知；改错故障：顺序颠倒会让 waitPageAbort 先看到未标记状态，等待落空后测试挂起。
// INV-12 位置：pageReleases.delete 在 delayed 等待结束之后执行；守住释放句柄不跨调用残留；改错故障：同名 key 第二次调用会误用旧释放函数，等待被提前结束。
// INV-13 位置：oncalltool 返回值中 structuredContent 的 key 字段；守住文本与结构化字段携带同一个 key；改错故障：只回文本不带结构化字段，依赖结构化内容的断言读到 undefined。
// INV-14 位置：ontoolinput 与 ontoolresult 分别写入 receivedFeed 的 input 与 result；守住两段事件的独立归属；改错故障：合并进同一数组会掩盖「先输入后结果」的时序退化。
// INV-15 位置：ontoolresult 中按服务端回传的 sequence 唤醒 feedWaiters；守住等待键是远端序号；改错故障：改用本地计数当键，序号不连续时等待永不结束。
// INV-16 位置：callTool 的 finally 中删除 calls 条目；守住每次调用结束后不留取消句柄；改错故障：残留句柄让 cancelTool 作用于已结束调用，取消静默失效且表持续增长。
// INV-17 位置：fixtureReady、starts 计数与 Counter 的 useLayoutEffect 就绪信号；守住就绪只在 React 首次挂载后发出、每次页面加载自增 starts；改错故障：模块顶层直接 resolve 会让宿主在挂载前断言，出现空白页。
// INV-18 位置：startStorageWriter 的递归写入，事务完成后再发起下一轮；守住并发写只发生在上一事务提交之后；改错故障：改为并行写入会让竞态断言读到不稳定的最后值，测试抖动。
//
// 模块职责：MCP Apps 宿主夹具页面，把 sampling、资源订阅、页工具调用、工具结果流与存储能力挂到 window 上，供端到端测试驱动并观察回调。
// 状态所有权：模块级持有单例客户端、各等待表与事件数组；页面状态只有 Counter 内的计数与输入文本，存储侧 localStorage 与 IndexedDB 各写一份。
// 阅读顺序：先看 18 条不变量，再按 sampling、资源、页工具、工具结果流、存储的顺序读，最后看 React 挂载与连接。
import { EmptyResultSchema } from "@modelcontextprotocol/core";
import { App } from "@modelcontextprotocol/ext-apps";
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
// 对外契约：整页只暴露一个 MCP Apps 客户端连接，后续所有 window 钩子都复用它。
// tools 传空对象是刻意的：夹具不注册客户端侧工具，工具清单全部由服务端下发。
// name 与 version 会随握手上报，改名会连带影响宿主侧按名称做的分组与断言。
// 构造必须早于任何 window 钩子赋值，否则回调会闭包住一个尚未初始化的客户端。
// 此处不做连接，连接放在模块末尾，确保处理器与等待表都已就位。
const app = new App({ name: "host-fixture", version: "1.0.0" }, { tools: {} });
const samplingCalls = new Map<string, AbortController>();
// 对外契约：按 key 发起一次采样，成功回 { result }，失败回 { error }，从不抛出。
// 每次调用新建 AbortController 并登记到 samplingCalls，供 cancelSample 精确定位。
// signal 随请求一并传入，宿主取消后由底层请求自行中止，这里不额外做竞速。
// finally 负责摘除句柄，成功与失败路径共用同一条清理出口。
// key 由调用方决定且必须唯一，重复 key 会覆盖上一个仍在飞行的取消句柄。
(window as any).sample = async (key: string, params: any) => {
  const cancel = new AbortController();
  samplingCalls.set(key, cancel);
  try {
    return { result: await app.createSamplingMessage(params, { signal: cancel.signal }) };
  } catch (error) {
    return { error: String(error) };
  } finally {
    samplingCalls.delete(key);
  }
};
(window as any).cancelSample = (key: string) => samplingCalls.get(key)?.abort();
(window as any).samplingCapabilities = () => app.getHostCapabilities();
// 资源更新事件按到达顺序累积，数组长度本身就是最新计数。
// 所以等待条件是「累计条数」而不是「新增条数」，两者混用会让等待键错位。
// waiters 以条目数作键，通知到达后按当前长度查找并清除，入账与唤醒是同一步。
// 两个结构必须同步更新：只入账不唤醒会挂起等待，只唤醒不入账会命中旧键。
// resourceEvents 直接暴露给页面，测试可读取全量历史而不只最后一条。
const resourceEvents: string[] = [];
const resourceWaiters = new Map<number, () => void>();
app.setNotificationHandler("notifications/resources/updated", (notification) => {
  resourceEvents.push(notification.params.uri);
  resourceWaiters.get(resourceEvents.length)?.();
  resourceWaiters.delete(resourceEvents.length);
});
(window as any).subscribeFixture = () =>
  app.request(
    { method: "resources/subscribe", params: { uri: "fixture://state" } },
    EmptyResultSchema,
  );
// 先判断再注册，避免通知先到时新建一个永远等不到的 Promise。
// 返回的 Promise 只在目标计数被唤醒时完成，没有超时兜底，超时由测试框架负责。
// count 传 0 会立即完成，调用方必须传期望达到的累计条数而非增量。
// 同一 count 只有一个等待者，后注册会覆盖先前注册者，多等待者要各传不同 count。
// 改写此分支时保留「先查后挂」的顺序，否则会出现丢唤醒的偶发失败。
(window as any).waitResources = (count: number) =>
  resourceEvents.length >= count
    ? Promise.resolve()
    : new Promise<void>((resolve) => resourceWaiters.set(count, resolve));
(window as any).resourceEvents = resourceEvents;
(window as any).readResourceFixture = async (uri: string) => {
  try {
    return { result: await app.readServerResource({ uri }) };
  } catch (error) {
    return { error: String(error) };
  }
};
// 对外契约：pageCalls 是页工具调用的完整流水，含 key 与是否已被中止。
// 三张表分工不同：pageWaiters 等调用发生、abortWaiters 等中止、pageReleases 负责放行。
// aborted 只在 abort 监听里置真，是「中止已生效」的唯一事实来源，不要另存副本。
// waitPageCall 与 waitPageAbort 都先扫已有记录再挂起，防止事件早于等待。
// 等待表用一次性键，唤醒后立即删除，避免旧等待者在后续同名调用中被再次触发。
const pageCalls: { key: string; aborted: boolean }[] = [];
const abortWaiters = new Map<string, () => void>();
(window as any).waitPageAbort = (key: string) =>
  pageCalls.some((c) => c.key === key && c.aborted)
    ? Promise.resolve()
    : new Promise<void>((resolve) => abortWaiters.set(key, resolve));
const pageWaiters = new Map<string, () => void>();
(window as any).waitPageCall = (key: string) =>
  pageCalls.some((c) => c.key === key)
    ? Promise.resolve()
    : new Promise<void>((resolve) => pageWaiters.set(key, resolve));
const pageReleases = new Map<string, () => void>();
(window as any).pageCalls = pageCalls;
(window as any).releasePageCall = (key: string) => pageReleases.get(key)?.();
app.onlisttools = async () => ({
  tools: [
    {
      name: "page_edit",
      description: "Fixture page tool",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" }, delayed: { type: "boolean" } },
        required: ["key"],
      },
      annotations: { readOnlyHint: false },
    },
  ],
});
// 这是宿主调用页工具的唯一入口，先登记调用再唤醒等待者，加载即被观测到。
// key 用 String 强转，参数缺失时得到 undefined 字面量，测试据此覆盖缺参分支。
// 只有 delayed 为真才进入挂起分支，普通调用立刻返回，避免所有调用都被挂住。
// 挂起期间监听 extra.mcpReq.signal：取消即标记 aborted 并拒绝，让宿主感知失败。
// 返回同时带文本与 structuredContent；放行后删除释放句柄，防止同名调用复用旧函数。
app.oncalltool = async (params, extra) => {
  const key = String(params.arguments?.key);
  const call = { key, aborted: false };
  pageCalls.push(call);
  pageWaiters.get(key)?.();
  pageWaiters.delete(key);
  if (params.arguments?.delayed)
    await new Promise<void>((resolve, reject) => {
      pageReleases.set(key, resolve);
      extra.mcpReq.signal.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          abortWaiters.get(key)?.();
          abortWaiters.delete(key);
          reject(new Error("page aborted"));
        },
        { once: true },
      );
    });
  pageReleases.delete(key);
  return { content: [{ type: "text", text: `page:${key}` }], structuredContent: { key } };
};
const receivedFeed = { input: [] as number[], result: [] as number[] };
const feedWaiters = new Map<number, () => void>();
(window as any).receivedFeed = receivedFeed;
(window as any).waitFeed = (n: number) =>
  receivedFeed.result.includes(n)
    ? Promise.resolve()
    : new Promise<void>((resolve) => feedWaiters.set(n, resolve));
// [边界] receivedFeed.input 只登记 sequence 序号，不在回调里校验：夹具要观测宿主原样行为。
// input 与 result 分开累积，用于验证「先输入后结果」的时序而不仅是最终值。
// ontoolinput 读 arguments，ontoolresult 读 structuredContent，字段名不同不可互换。
// waitFeed 命中已有结果就立即完成，未命中才登记，避免结果先到造成永久挂起。
// feedWaiters 按服务端回传序号唤醒，序号不连续时测试仍须按实际值等待。
app.ontoolinput = (input) => {
  receivedFeed.input.push(input.arguments!.sequence as number);
};
app.ontoolresult = (result) => {
  const n = result.structuredContent!.sequence as number;
  receivedFeed.result.push(n);
  feedWaiters.get(n)?.();
  feedWaiters.delete(n);
};
// 对外契约：callTool 按 key 发起工具调用，成功回 { result }，失败回 { error }。
// signal 交给底层调用，取消路径由 cancelTool 触发，本地不额外做竞速。
// finally 摘除句柄，与 samplingCalls 一致，保证取消表不随调用次数增长。
// cancelTool 对未知 key 静默返回，测试在调用真正开始前取消也不会抛错。
// 改这里要同步看 cancelTool：句柄键必须是同一次调用的 key，否则取消静默失效。
const calls = new Map<string, AbortController>();
(window as any).callTool = async (key: string, delayed = false) => {
  const abort = new AbortController();
  calls.set(key, abort);
  try {
    return {
      result: await app.callServerTool(
        { name: "edit", arguments: { key, delayed } },
        { signal: abort.signal },
      ),
    };
  } catch (error) {
    return { error: String(error) };
  } finally {
    calls.delete(key);
  }
};
(window as any).cancelTool = (key: string) => calls.get(key)?.abort();
let ready!: () => void;
(window as any).fixtureReady = new Promise<void>((resolve) => {
  ready = resolve;
});
(window as any).starts = ((window as any).starts ?? 0) + 1;
function Counter() {
  const [count, setCount] = useState(0);
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    ready();
  }, []);
  return (
    <>
      <button id="counter" onClick={() => setCount((n) => n + 1)}>
        {count}
      </button>
      <input id="input" value={text} onChange={(event) => setText(event.target.value)} />
      <div id="scroll" style={{ height: 80, overflow: "scroll" }}>
        <div style={{ height: 1000 }}>scroll fixture</div>
      </div>
    </>
  );
}
app.connect().then(() => createRoot(document.getElementById("root")!).render(<Counter />));
(window as any).storageRoundTrip = async (write: boolean) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("host-fixture");
    request.onupgradeneeded = () => request.result.createObjectStore("values");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (write) {
    localStorage.setItem("counter", "42");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("values", "readwrite");
      tx.objectStore("values").put(42, "counter");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction("values").objectStore("values").get("counter");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return { local: localStorage.getItem("counter"), indexed: value ?? null };
};

(window as any).saveWidget = (widgetState: unknown) =>
  app.request({ method: "ui/set-widget-state", params: { widgetState } }, EmptyResultSchema);
(window as any).readWidget = () => app.getHostContext()?.["zcode/widgetState"] ?? null;
(window as any).startStorageWriter = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("host-fixture");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const write = () => {
        localStorage.setItem("counter", "racing");
        const tx = db.transaction("values", "readwrite");
        tx.objectStore("values").put("racing", "counter");
        tx.oncomplete = () => {
          resolve();
          write();
        };
        tx.onerror = () => reject(tx.error);
      };
      write();
    };
  });
