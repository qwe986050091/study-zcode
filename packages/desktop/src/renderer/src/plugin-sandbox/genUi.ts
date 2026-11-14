// INV-01 守住位置：首屏状态只来自 DOM 内联的 zcode-gen-ui-initial-state 文本｜改错故障：改成异步补拉会让宿主先看到空 widget 再跳变
// INV-02 守住位置：initial 只解析一次，此后 state 仅由 host context 与 setWidgetState 两条通道改写｜改错故障：再次读 DOM 会覆盖用户本次会话的编辑
// INV-03 守住位置：App 以 autoResize 为 false 构造，尺寸上报权完全归本文件的 ResizeObserver｜改错故障：开着内建自适应会与自绘测量各发一次，宿主看到抖动
// INV-04 守住位置：内容高度只读取真实布局，绝不临时改写 html 或 body 的高度｜改错故障：测量引发溢出再触发测量，形成布局反馈环
// INV-05 守住位置：零子元素用 Range 选中 body 内容量高，单子元素用 scrollHeight 并补上顶部偏移｜改错故障：一律读 body 高度会漏掉浮动或绝对定位内容
// INV-06 守住位置：多子元素取各 bottom 相对 contentTop 的最大值，不做累加｜改错故障：累加会把并排布局算成两倍高度
// INV-07 守住位置：上报高度为内容高加 paddingTop 与 paddingBottom，宽与视口取 innerWidth 与 innerHeight｜改错故障：漏加上下内边距会让底部内容被宿主裁掉
// INV-08 守住位置：宽高与视口同步等量增长时直接返回，返回前已把 previous 写成 next｜改错故障：回传宿主造成的 vh 增长会引发互相推高
// INV-09 守住位置：schedule 用帧号做合并，pagehide 时必须取消待执行的帧｜改错故障：卸载后仍有回调，向已关闭的通道发尺寸
// INV-10 守住位置：roots 只含 body 直接子元素，并排除 SCRIPT、STYLE 与 role 为 tooltip 的节点｜改错故障：把 tooltip 计入高度会让悬停时反复推高画布
// INV-11 守住位置：refreshRoots 先对移出的旧节点解除观察，再观察新增节点，最后统一调度一帧｜改错故障：漏掉解除会让已移除节点继续触发上报
// INV-12 守住位置：tweak 回调先等 ready 结算再发请求，安装时机早于 connect｜改错故障：连接前发请求会因会话未建立而丢弃用户改动
// INV-13 守住位置：主题只在取值为 dark 或 light 时写入根元素的 dataset 与 colorScheme｜改错故障：透传缺失值会得到字符串 undefined 的主题名
// INV-14 守住位置：样式变量先展开宿主 variables 再展开控件 controls，后者覆盖前者，且只写以两个连字符开头的键｜改错故障：顺序反了会让宿主旧变量压过控件变量
// INV-15 守住位置：广播事件里的 widgetState 用结构化克隆隔离，标注缺失时显式给 null｜改错故障：直接传出 state 引用会让监听方改到内部快照
// INV-16 守住位置：connect 结算后立刻用宿主 context 补一次投影，再按 readyState 决定何时启动尺寸观测｜改错故障：先观测后投影会按旧主题测一次并上报
// INV-17 守住位置：saves 是串行链，每段先吞掉上一次失败再挂下一段｜改错故障：失败留在链上会让后续所有保存连带拒绝
// INV-18 守住位置：链接拦截只认左键与中键，跳过 hash 与空 href，未信任事件和 download 锚点不转外链｜改错故障：放行下载或误拦右键会破坏沙箱默认行为
//
// 模块职责：作为 gen UI widget 的沙箱入口，把宿主 context 投影成 DOM 主题与全局事件，并把内容尺寸、tweak、状态保存、外链打开四类能力收敛到 window.zcode。
// 状态所有权：widget 状态快照由宿主 Service 持有，本文件只保留 state 这一份只读投影与 saves 串行链，不缓存任何可回写的权威数据。
// 阅读顺序：先看 initial 与 App 构造，再看 observeContentSize 的三分支测量与 vh 去抖，随后是 update 投影、ready 时序，最后是 window.zcode 与链接/展示事件。
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import {
  GEN_UI_GLOBALS_EVENT,
  GEN_UI_STATE_CONTEXT_KEY,
  GEN_UI_TWEAK_CONTEXT_KEY,
  GEN_UI_STYLE_CONTEXT_KEY,
  genUiStyleVariablesSchema,
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_TWEAK_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
  type GenUiWidgetState,
  genUiTweakMessageSchema,
  genUiTweakResultSchema,
  genUiTweakAnnotationSchema,
} from "@zcode/shared/gen-ui";
import { installGenUiTweakRuntime } from "./genUiTweakRuntime.js";

// 宿主把序列化后的 widget 状态内联进 HTML，这段文本是首屏唯一的状态来源
// 缺元素时 textContent 退化为空值，再经空值合并落成字符串 null，最终得到 null
// schema 校验失败就抛出，宁可脚本中断也不让半成品状态进入渲染
// 这里只决定初值，之后 state 由 update 与 setWidgetState 两条路径接管
const initial = JSON.parse(
  document.getElementById("zcode-gen-ui-initial-state")?.textContent ?? "null",
) as unknown;
let state: GenUiWidgetState | null =
  initial === null ? null : genUiWidgetStateSchema.parse(initial);
// autoResize 显式关掉，尺寸上报权收归本文件的观察器
// 开启内建自适应会与自绘测量各发一次，宿主会看到高度来回抖动
// App 只承载协议请求通道，不挂宿主事件，避免出现两套回调入口
// name 与 version 参与握手，随意改动等于让宿主把 widget 当成新应用
const app = new App({ name: "zcode-gen-ui", version: "1" }, {}, { autoResize: false });

// 所有测量都在动画帧里执行，避免读布局与写 DOM 交错触发强制重排
// 只读几何值，绝不变更文档结构，保证测量本身无副作用
// 旧 SDK 靠临时改写根元素高度来量内容，测量自身就会制造溢出，这里不沿用
// 零子元素、单子元素、多子元素三分支的边界由 roots 实时集合决定，切换时不留残留观察
function observeContentSize() {
  const body = document.body;
  const range = document.createRange();
  let previous: { height: number; width: number; viewport: number } | undefined;
  let frame: number | undefined;
  let roots = new Set<Element>();
  const report = () => {
    frame = undefined;
    const style = getComputedStyle(body);
    const top = parseFloat(style.paddingTop) || 0;
    const bottom = parseFloat(style.paddingBottom) || 0;
    const contentTop = body.getBoundingClientRect().top + top;
    const children = [...roots];
    let extent = 0;
    // 旧 SDK 临时改写 html 高度来测量，测量自身会触发溢出布局；这里仅读取实际内容。
    if (children.length === 0) {
      range.selectNodeContents(body);
      extent = range.getBoundingClientRect().height;
    } else if (children.length === 1) {
      const child = children[0]!;
      const rect = child.getBoundingClientRect();
      extent = Math.max(child.scrollHeight, rect.height) + Math.max(0, rect.top - contentTop);
    } else {
      for (const child of children)
        extent = Math.max(extent, child.getBoundingClientRect().bottom - contentTop);
    }
    // next 冻结本帧的宽、高与视口三个读数，后续判断只比对这一份快照
    // previous 在比较之前就更新，任何提前返回都不会留下过期基线
    // 高差与视口差相等说明是宿主缩放带来的等量增长，不上报以免自激
    // 高度向上取整后发送，子像素抖动不会被宿主当成新尺寸反复确认
    const next = { height: extent + top + bottom, width: innerWidth, viewport: innerHeight };
    const last = previous;
    previous = next;
    // vh / 百分比高度会跟随宿主视口等量增长；不把宿主调整再反馈成新的内容增高。
    if (
      last &&
      next.width === last.width &&
      next.height - last.height === next.viewport - last.viewport
    )
      return;
    void app
      .sendSizeChanged({ width: next.width, height: Math.ceil(next.height) })
      .catch((error) =>
        window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
      );
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(report);
  };
  const sizes = new ResizeObserver(schedule);
  const refreshRoots = () => {
    const next = new Set(
      [...body.children].filter(
        (child) =>
          child.tagName !== "SCRIPT" &&
          child.tagName !== "STYLE" &&
          child.getAttribute("role") !== "tooltip",
      ),
    );
    for (const child of roots) if (!next.has(child)) sizes.unobserve(child);
    for (const child of next) if (!roots.has(child)) sizes.observe(child);
    roots = next;
    schedule();
  };
  sizes.observe(body);
  refreshRoots();
  const children = new MutationObserver(refreshRoots);
  children.observe(body, { childList: true });
  window.addEventListener("resize", schedule);
  window.addEventListener(
    "pagehide",
    () => {
      sizes.disconnect();
      children.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
    { once: true },
  );
}
// tweak 运行时在模块顶层安装，早于连接，保证首帧交互就有处理器
// 回调里先等 ready 结算，连接未建立时的请求会被通道静默丢弃
// 入参先过 schema 校验再进通道，脏数据止步于边界
// 返回值同样受 schema 约束，结构与宿主预期不符时立即失败而非降级
installGenUiTweakRuntime(async (_name, message) => {
  await ready;
  return app.request(
    { method: GEN_UI_TWEAK_METHOD, params: genUiTweakMessageSchema.parse(message) },
    genUiTweakResultSchema,
  );
});
// update 是宿主 context 的唯一写入点，可重复调用且结果只取决于入参
// 状态分支只认状态上下文键，null 表示显式清空而不是缺省忽略
// 主题与变量先落根元素，再广播 globals，监听方读到的已是新值
// 广播用自定义事件而不改共享全局对象，widget 与宿主之间不传可变引用
const update = (context: Record<string, unknown>) => {
  if (Object.hasOwn(context, GEN_UI_STATE_CONTEXT_KEY)) {
    const next = context[GEN_UI_STATE_CONTEXT_KEY];
    state = next === null ? null : genUiWidgetStateSchema.parse(next);
  }
  if (context.theme === "dark" || context.theme === "light") {
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.style.colorScheme = context.theme;
  }
  const variables = (context.styles as { variables?: Record<string, string> } | undefined)
    ?.variables;
  const controls = genUiStyleVariablesSchema.parse(context[GEN_UI_STYLE_CONTEXT_KEY] ?? {});
  for (const [name, value] of Object.entries({ ...variables, ...controls }))
    if (name.startsWith("--")) document.documentElement.style.setProperty(name, value);
  window.dispatchEvent(
    new CustomEvent(GEN_UI_GLOBALS_EVENT, {
      detail: {
        globals: {
          widgetState: structuredClone(state),
          theme: document.documentElement.dataset.theme,
          visualizationAnnotation:
            context[GEN_UI_TWEAK_CONTEXT_KEY] === undefined
              ? null
              : genUiTweakAnnotationSchema.parse(context[GEN_UI_TWEAK_CONTEXT_KEY]),
        },
      },
    }),
  );
};
// 上下文变更用单次赋值挂载，重复赋值会顶掉旧处理器而不是叠加监听
// 连接结算后主动补取一次上下文，避免首帧停留在默认主题
// 尺寸观测要等 DOMContentLoaded，脚本内联在头部时 body 尚未就绪
// 连接失败只上报错误事件，不阻断已经暴露的 window.zcode 调用方
app.onhostcontextchanged = update;
const ready = app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => {
  update(app.getHostContext() ?? {});
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", observeContentSize, { once: true });
  else observeContentSize();
});
void ready.catch((error) =>
  window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
);
// saves 是模块级串行链，保证多次保存按调用顺序抵达宿主
// 每段链先兜住上一次失败，一次写失败不阻塞后续写入
// 返回给调用方的是本段结果，失败归属仍落在发起那次调用的调用方
// 服务端通知才是状态的唯一投影，保存回执不回写本地 state
let saves = Promise.resolve();
const api = Object.freeze({
  get widgetState() {
    return structuredClone(state);
  },
  setWidgetState(value: unknown) {
    const next = genUiWidgetStateSchema.parse(value);
    const pending = saves
      .catch(() => undefined)
      .then(async () => {
        await ready;
        await app.request({ method: GEN_UI_STATE_METHOD, params: { state: next } }, z.object({}));
        // Service 通知是唯一状态投影；迟到的保存 ACK 不能覆盖另一窗口更新的快照。
      });
    saves = pending;
    return pending;
  },
  async sendFollowUpMessage(value: unknown) {
    const params = genUiFollowUpSchema.parse(value);
    await saves;
    await ready;
    await app.request({ method: GEN_UI_FOLLOW_UP_METHOD, params }, z.object({}));
  },
  async openExternal(value: unknown) {
    const { href } = z.object({ href: z.string() }).strict().parse(value);
    await ready;
    const result = await app.openLink({ url: href });
    if (result.isError) throw new Error("External link was denied");
  },
});
Object.defineProperty(window, "zcode", { value: api, writable: false, configurable: false });
// 拦截先看已被阻止的默认行为与按键，右键与拖拽手势不进入外链逻辑
// 锚点用事件路径查找，可穿透影子树，不依赖冒泡目标
// 空 href 与 hash 属于页面内跳转，交回浏览器原生处理
// 未信任事件与带 download 的锚点只阻止导航不转外链，保住浏览器默认下载
const openAnchor = (event: MouseEvent) => {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href")?.trim();
  if (!href || href.startsWith("#")) return;
  // 原生导航会被沙箱阻止；外链经宿主打开，下载和合成点击不借用剩余手势。
  event.preventDefault();
  if (!event.isTrusted || anchor.hasAttribute("download")) return;
  void api
    .openExternal({ href })
    .catch((error) =>
      window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
    );
};
window.addEventListener("click", openAnchor);
window.addEventListener("auxclick", openAnchor);
// guest 的 hover/键盘事件不会冒泡到宿主 DOM；只传展示事件，不增加 Agent 能力。
const presentation = (params: { hovered?: boolean; escape?: true }) => {
  void ready
    .then(() => app.request({ method: GEN_UI_PRESENTATION_METHOD, params }, z.object({})))
    .catch(() => {});
};
document.documentElement.addEventListener("pointerenter", () => presentation({ hovered: true }));
document.documentElement.addEventListener("pointerleave", () => presentation({ hovered: false }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) presentation({ escape: true });
});
