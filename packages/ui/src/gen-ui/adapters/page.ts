// Gen UI 页面适配器：把一张 Gen UI 卡片（沙箱 webview 加 MCP AppBridge）封装成可订阅的页面对象。
// 职责边界：负责实例生命周期、桥接握手、状态持久化串行化与设计参数投影；不负责生成 HTML，也不决定卡片在时间线中的排版与可见性判定。
// 承载与定位由 plugin-ui 的 page plane 完成，本文件只调用 bind、preview、focus、captureBounds，不直接改写沙箱容器尺寸或滚动位置。
//
// INV-01 断言：页面快照只通过整体替换发布，订阅者读到的是一份自洽字段 —— 守住它的位置：update 中的合并与赋值 —— 改错故障：原地改字段让 React 跳过重渲染，高度或错误文案卡在旧值。
// INV-02 断言：disposed 置位后不再产生任何快照更新与监听回调 —— 守住它的位置：update 的首要判定与 dispose 的首行 —— 改错故障：已卸载组件被重新回调，快速切换卡片时出现幽灵渲染。
// INV-03 断言：所有桥接回调先过 current 再走 assertCurrent —— 守住它的位置：onopenlink 与四个请求处理器 —— 改错故障：旧实例的请求落到新沙箱，状态写进错误的卡片。
// INV-04 断言：ready 相位只能由 oninitialized 置位 —— 守住它的位置：active 初始化完成回调 —— 改错故障：提前置 ready 会让宿主在 guest 未就绪时允许追问，消息被静默丢弃。
// INV-05 断言：握手超时只改相位，不销毁沙箱也不关闭桥 —— 守住它的位置：handshake 定时器回调 —— 改错故障：在定时器里回收资源会与 dispose 重复释放，进程句柄二次关闭报错。
// INV-06 断言：状态写入全部串行经过 saves 链 —— 守住它的位置：状态方法处理器中的链式续接 —— 改错故障：并发落盘让后到的旧值覆盖新值，重开页面看到过期预览。
// INV-07 断言：同一时刻只允许一个 followUp 在途 —— 守住它的位置：followUp 开头的 sending 判定与 finally 复位 —— 改错故障：连点发送会向同一会话投递两条追问，模型并发重写同一文件。
// INV-08 断言：等待落盘之后必须重跑 assertCurrent 并比对社会引用 —— 守住它的位置：followUp 的中段校验 —— 改错故障：落盘期间会话切换后仍向旧绑定发送，消息进错会话。
// INV-09 断言：交给 SDK 的 hostContext 必须是每次新建的浅拷贝 —— 守住它的位置：AppBridge 构造第四个参数与 pushContext —— 改错故障：共享引用让 SDK 的差异比较永远认为无变化，主题与尺寸不再推送。
// INV-10 断言：端口事件必须同时匹配 sandboxId 与 initId —— 守住它的位置：端口订阅回调首行过滤 —— 改错故障：同沙箱重启时接到旧端口，两个桥争抢请求导致响应错配。
// INV-11 断言：准备期间被丢弃的沙箱必须显式回收 —— 守住它的位置：preparation 中 disposed 后的释放分支 —— 改错故障：句柄未写入 handle，主 dispose 流程扫不到，留下常驻沙箱进程。
// INV-12 断言：迟到的状态查询结果不能覆盖期间收到的通知 —— 守住它的位置：revision 与 stateRevision 的比较 —— 改错故障：旧快照回写让刚编辑的控件值回跳，用户看到值自己变回去。
// INV-13 断言：上报高度夹紧在 0 到 10000 并向上取整，全屏时不写入 —— 守住它的位置：尺寸变化回调分支 —— 改错故障：异常高度撑爆正文流，或退出预览时时间线跳动。
// INV-14 断言：外部链接只放行 http 与 https 且必须消费用户手势 —— 守住它的位置：打开链接回调的协议判定与手势消费 —— 改错故障：file 或 javascript 链接可被卡片触发，造成本机文件或脚本执行。
// INV-15 断言：预览原稿时投影的是空变更集 —— 守住它的位置：projectTweaks 中的 previewOriginal 分支 —— 改错故障：预览态仍带改动，guest 无法还原初始外观，对比功能失效。
// INV-16 断言：dispose 必须先标记再解绑、最后释放 —— 守住它的位置：dispose 的语句顺序与 finally —— 改错故障：先释放沙箱会触发崩溃回调，把已卸载页面重新写成 error 相位。
//
// 时序：工厂同步返回对象，preparation 异步读文档、准备沙箱并挂载，端口订阅建桥，初始化完成回调置 ready，任一环节失败都经 fail 收口。
// 相位只进不退：loading 到 ready 或 loading 到 error，error 之后不再自愈，恢复依赖宿主重建整张卡片。
// 忙碌口径为 preparing 或 sending 或 operations 大于零，仅供宿主禁用输入，不代表沙箱内部是否可交互。
import { AppBridge, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import type { IGenUiService } from "@zcode/services";
import type { PluginSandboxPlatformPort, PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import {
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_TWEAK_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  GEN_UI_STATE_CONTEXT_KEY,
  GEN_UI_TWEAK_CONTEXT_KEY,
  buildGenUiStateKey,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
  genUiTweakMessageSchema,
  genUiTweakResultSchema,
  type GenUiTweakValues,
} from "@zcode/shared/gen-ui";
import {
  createPluginUiPagePlane,
  createPluginUiMessagePortTransport,
  getPluginUiSessionActions,
} from "@/plugin-ui/hostPrimitives.js";
import type { GenUiCardTarget, GenUiPage, GenUiPageSnapshot } from "../contract.js";
import { EMPTY_GEN_UI_SNAPSHOT } from "../contract.js";
import { readGenUiStyleContext } from "./theme.js";
import { createGenUiTweakRegistry } from "../app/tweaks.js";

// [契约] 每张 Gen UI 卡片创建一个页面实例，files 与 state 虽同为 IGenUiService，读 HTML 与读写状态却必须走同一服务，分开注入会拿到不同工作区视图
// [契约] confirm 返回空串表示用户取消，实现方不要用 null 之外的哨兵值表示「确认原样发送」，followUp 会 trim 后判空
export interface GenUiPageInput {
  target: GenUiCardTarget;
  files: IGenUiService;
  state: IGenUiService;
  platform: PluginSandboxPlatformPort;
  openExternal(url: string): void | Promise<void>;
  confirm(prompt: string): Promise<string | null>;
  onVisibility?(visible: boolean): void;
  onSettled?(): void;
}
// [契约] 工厂同步返回句柄，内部初始化全部异步；调用方可以立即 bind 节点，承载层会等沙箱挂载后再接管可见性
// [并发] 返回对象上的方法都可能被 React 在卸载与重挂之间调用，因此每个入口都要自行判定 disposed，不能依赖调用方顺序
// [权衡] 不接 React 状态或 store 订阅，只用 listeners 加 getSnapshot，避免嵌套 Provider 在多个卡片之间产生第二份业务状态
export function createGenUiPage(input: GenUiPageInput): GenUiPage {
  // [事务] 注册表按实例隔离，guest 的注册与选择都留在本页，跨卡片不共享，防止一张卡片的选择态泄漏到另一张
  // 宿主侧滑块修改通过 setTweaks 回灌，不直接改注册表内部映射，注册表里只放 guest 上报的注册代次
  const tweaks = createGenUiTweakRegistry();
  const { target, platform } = input;
  // stateTarget 是可变副本：准备前会回填 readDocument 解析出的规范化 path，而身份字段保持 target 初值以便状态键匹配
  // [契约] 不能用 target 直接替换，target 是宿主传入的只读卡片标识，回填后仍需保留其 workspaceIdentity 与 sessionId 语义
  let stateTarget = {
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    sessionId: target.sessionId,
    path: target.path,
  };
  const listeners = new Set<() => void>();
  // [契约] 初始相位必须是 loading，宿主据此显示骨架；从空快照复制而不是直接引用，避免后续替换污染共享常量
  // 快照字段只增不改语义：新增字段必须同时进空快照常量，否则首帧读到 undefined 会让订阅组件抛错
  let snapshot: GenUiPageSnapshot = { ...EMPTY_GEN_UI_SNAPSHOT };
  // [并发] disposed 一旦置位不再回退，所有异步回调以它为第一道闸门；它比可见性更早生效，卸载期间不应再看承载层状态
  // [并发] visible 由承载层按锚点真实尺寸推导，sending 只覆盖追问单飞；三者不可合并成一个忙碌布尔，否则复制图片会被追问判定误挡
  // [契约] 这三个标记只在主线程读写，不做跨线程同步，桥回调与 React 事件都排在同一条任务队列上
  let disposed = false,
    visible = false,
    sending = false;
  // [资源] handle 代表已准备好的沙箱进程，bridge 代表已连上的消息通道；两者生命周期不同步，重建桥时不能顺手清掉 handle
  // [失败路径] handle 为空时仍可能有桥在，就绪判定用 handle，避免向尚未挂载的沙箱派发指令
  let handle: PluginSandboxHandle | null = null;
  let bridge: AppBridge | null = null;
  let stopState: { dispose(): void } | null = null;
  // [失败路径] 握手计时器只负责在 15 秒后把相位打成 error，不回收沙箱也不关闭桥，回收仍由 dispose 统一执行
  // [并发] 每次端口事件重建桥前都必须清理计时器，否则上一轮的计时器会把已经 ready 的新实例误判成超时
  // [权衡] 用固定超时而非重试：沙箱进程崩溃会由承载层上报，重试会掩盖真正的加载失败
  let handshake: ReturnType<typeof setTimeout> | undefined;
  // [并发] saves 是一条串行链，每次状态上报接在链尾，保证后到的写入不会被先到的覆盖，也不并发打同一个 IPC
  // [事务] 链上单次失败不能中断后续：新任务先吞掉前序异常再续接，否则一次写入失败会让本页后续状态永久不再落盘
  // [失败路径] 被吞的只是前序链接口，当前这次写入的异常仍要冒泡，交给 guest 决定是否重试
  let saves: Promise<void> = Promise.resolve();
  let operations = 0;
  let preparing = true;
  // [契约] 唯一发布通道：先合并出新对象再整体替换，最后同步通知监听者，监听者读到的必须是新值
  // [资源] 卸载后静默丢弃且不再遍历监听集合，避免已卸载组件被回调重新挂载或测试里泄漏
  // [权衡] 同步通知而非微任务批处理：桥回调本就低频，批处理会让宿主在一次事件里看到中间态
  const update = (next: Partial<GenUiPageSnapshot>) => {
    if (!disposed) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    }
  };
  const fail = (error: unknown) =>
    update({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  // [契约] 可见性回调是承载层的事实，页面只转存并透传宿主，不据此改写相位
  // [失败路径] 崩溃回调只把相位打成 error，这里不销毁沙箱，销毁时机交给宿主调用 dispose，避免回调中重入卸载
  const plane = createPluginUiPagePlane({
    onVisibility: (value) => {
      visible = value;
      input.onVisibility?.(value);
    },
    onCrash: () => fail(new Error("Gen UI page stopped")),
  });
  // [契约] context 是本页唯一的可变主题投影，显示模式由宿主布局改写，主题与样式变量由根元素观察器刷新
  // [契约] 传给 SDK 时必须浅拷贝，SDK 会保留上一份用于差异比较，共享同一对象会让它认为没有变化而跳过推送
  // [权衡] 初始显示模式固定为内联，等 bind 或 preview 时再改写，避免首帧把正文卡片渲染成全屏
  const context: McpUiHostContext = {
    displayMode: "inline",
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    ...readGenUiStyleContext(),
  };
  const pushContext = () => {
    bridge?.setHostContext({ ...context });
  };
  // [契约] 四个条件缺一不可：未卸载、承载层可见、沙箱句柄存在、相位为 ready
  // [契约] 不要因为「用户已经点了按钮」就跳过可见性判定，标签页切走后 webview 仍会被隐藏，此时发追问会让消息落到不可见的卡片上
  // [失败路径] 统一抛固定文案，宿主按字符串判断是否需要重建卡片，改动文案会破坏调用方的错误分支
  const assertCurrent = () => {
    if (disposed || !visible || !handle || snapshot.phase !== "ready")
      throw new Error("Gen UI is no longer active");
  };
  // [失败路径] 先判定会话可写再置单飞标记，只读或已断开的会话在这里直接失败，不会留下悬空的标记
  // [并发] 手势校验跨进程，返回时卡片可能已隐藏或重建，所以取回结果后要重新判定当前实例并比对会话动作引用
  // [事务] 必须等落盘链落定再发送：追问携带的是旧状态时会让模型基于过期预览重写页面
  const followUp = async (prompt: string, title?: string, hostGesture = false) => {
    assertCurrent();
    if (sending) throw new Error("A follow-up is already pending");
    const actions = getPluginUiSessionActions(target);
    if (!actions) throw new Error("This session is read-only or disconnected");
    sending = true;
    try {
      if (!hostGesture && !(await platform.consumeUserGesture(handle!.sandboxId))) {
        const confirmed = await input.confirm(prompt);
        if (!confirmed?.trim()) throw new Error("Follow-up cancelled");
        prompt = confirmed.trim();
      }
      await saves;
      assertCurrent();
      if (getPluginUiSessionActions(target) !== actions) throw new Error("Session binding changed");
      await actions.sendFollowUp({
        prompt,
        source: { kind: "genUi", path: stateTarget.path, title },
      });
    } finally {
      sending = false;
      input.onSettled?.();
    }
  };
  // [并发] 端口事件可能来自上一代沙箱，必须同时比对 sandboxId 与 initId，只比 sandboxId 会在同沙箱重启时接错端口
  // [资源] 每次建桥前先关旧桥，旧传输不会自动失效，留着会让两个桥同时抢同一份请求
  // [契约] 该订阅在 dispose 时注销，否则隐藏窗口里的残留端口会持续重建桥并触发失败回调
  const offPorts = platform.onPorts((event) => {
    if (disposed || event.sandboxId !== handle?.sandboxId || event.initId !== handle.initId) return;
    void bridge?.close();
    // SDK 持有上一份上下文用于差异比较，不能与可写投影共享同一对象。
    // [契约] 第三个参数声明本宿主暴露给 guest 的能力集合，新增能力要同时改这里与 guest 侧声明，单边声明会被 SDK 拒绝
    // [契约] 第四个参数必须新建浅拷贝，宿主 context 后续会被主题与尺寸改写，共享引用会让 SDK 的差异比较失效
    // [资源] active 先赋给外层 bridge 再挂回调，回调里用引用相等识别旧实例，顺序反过来会让首个请求被误判为过期
    const active = new AppBridge(
      null,
      { name: "zcode-gen-ui", version: "1" },
      { openLinks: {}, experimental: { "zcode/gen-ui": {} } },
      { hostContext: { ...context } },
    );
    bridge = active;
    active.onerror = fail;
    // [契约] ready 只在这里置位：guest 完成初始化前推送给它的上下文可能被丢弃
    // [并发] 清理计时器与置相位必须在同一段同步代码里完成，中间插入等待会让超时回调抢先把相位改成 error
    active.oninitialized = () => {
      clearTimeout(handshake);
      update({ phase: "ready" });
      pushContext();
    };
    // [契约] 高度上限 10000 且向上取整，防止 guest 上报无穷大或负值把正文撑爆
    // [权衡] 全屏预览时不写入高度：此时卡片不占正文流，回写会让退出预览后的时间线发生跳动
    active.onsizechange = ({ height }) => {
      // 预览使用独立视口；保持正文占位高度，避免遮罩下的时间线跳动。
      if (
        context.displayMode !== "fullscreen" &&
        typeof height === "number" &&
        Number.isFinite(height)
      )
        update({ height: Math.max(0, Math.min(10000, Math.ceil(height))) });
    };
    // [并发] 用 bridge 引用相等识别旧实例，重建后旧回调仍可能被 SDK 触发，这类请求必须整体丢弃而不是转发
    // [失败路径] 这里不检查可见性，可见性归 assertCurrent，两者职责分开避免每个回调重复写同一组条件
    const current = () => {
      if (disposed || bridge !== active) throw new Error("Gen UI instance was closed");
    };
    // [失败路径] 先解析再判协议，非法字符串会在这里抛错并被 SDK 转成错误响应，不要吞掉改成静默忽略
    // [契约] 只放行 http 与 https，javascript 与 file 协议即使来自可信卡片也必须拒绝
    // [失败路径] 手势校验是跨进程往返，返回后卡片可能已隐藏或换了实例，因此要再判定一次当前实例与就绪状态才真正打开
    active.onopenlink = async ({ url }) => {
      current();
      assertCurrent();
      const link = new URL(url);
      if (link.protocol !== "https:" && link.protocol !== "http:")
        throw new Error("External links require an absolute HTTP(S) URL");
      if (!(await platform.consumeUserGesture(handle!.sandboxId)))
        throw new Error("External links require a user gesture");
      // 手势校验跨进程返回时，卡片可能已隐藏或重建，不能执行旧页面的打开请求。
      current();
      assertCurrent();
      await input.openExternal(link.href);
      return {};
    };
    // [事务] 状态上报不回写页面快照，宿主展示以通知通道为准；这里写快照会让预览与持久化状态在时序上打架
    // [并发] operations 进入时加一、在 finally 里减一，异常路径也要减，否则一次失败会让忙碌判定永久为真
    // [事务] 落盘失败不改变本次请求的结果结构，异常冒泡给 guest，由 guest 决定是否重试
    active.setRequestHandler(
      GEN_UI_STATE_METHOD,
      { params: z.object({ state: genUiWidgetStateSchema }).strict(), result: z.object({}) },
      async ({ state }) => {
        current();
        operations++;
        // [并发] 前序失败已在链上被吞，这里只保证顺序；当前这次写入的异常仍然向上冒泡，不被链式兜底抹平
        // [契约] 每次写入都重新读 stateTarget，因为准备阶段可能已把 path 回填成规范化路径
        const save = saves
          .catch(() => undefined)
          .then(async () => {
            current();
            await input.state.setState({ target: stateTarget, state });
          });
        saves = save;
        try {
          await save;
        } finally {
          operations--;
          input.onSettled?.();
        }
        return {};
      },
    );
    active.setRequestHandler(
      GEN_UI_FOLLOW_UP_METHOD,
      { params: genUiFollowUpSchema, result: z.object({}) },
      async ({ prompt, title }) => {
        current();
        await followUp(prompt, title);
        return {};
      },
    );
    // [契约] 先交给注册表校验消息，非法注册代次或回调重复会直接抛错，不能在这里兜底成静默忽略
    // [事务] 控件值以「已有投影优先、否则取控件初值」合并，保证没有交互过的控件也有稳定投影
    // [权衡] 每次注册或更新都整体重算分组与取值，注册表上限只有 64 组，重算成本远低于做增量合并的复杂度
    active.setRequestHandler(
      GEN_UI_TWEAK_METHOD,
      {
        params: genUiTweakMessageSchema,
        result: genUiTweakResultSchema,
      },
      async (message) => {
        current();
        const result = tweaks.handle(message);
        const groups = tweaks.groups();
        const values = Object.fromEntries(
          groups.flatMap((group) =>
            group.controls.map((control) => [
              control.id,
              snapshot.tweakValues[control.id] ?? control.value,
            ]),
          ),
        );
        update({ tweak: groups[0] ?? null, groups, tweakValues: values });
        projectTweaks();
        return result;
      },
    );
    active.setRequestHandler(
      GEN_UI_PRESENTATION_METHOD,
      {
        params: z
          .object({ hovered: z.boolean().optional(), escape: z.literal(true).optional() })
          .strict(),
        result: z.object({}),
      },
      async ({ hovered, escape }) => {
        current();
        update({
          ...(hovered !== undefined ? { hovered } : {}),
          ...(escape ? { escapeSequence: snapshot.escapeSequence + 1 } : {}),
        });
        return {};
      },
    );
    clearTimeout(handshake);
    // 超时只报告握手失败，不参与同步或恢复。
    // [失败路径] 超时只改相位，不关桥也不销毁沙箱：此时 guest 可能只是慢，直接回收会丢掉已注册的控制器状态
    // [契约] 计时器句柄存外层变量，卸载与每次重建桥都要清理，否则已卸载页面的计时器仍会触发一次更新
    handshake = setTimeout(() => fail(new Error("Gen UI handshake timed out")), 15_000);
    void active.connect(createPluginUiMessagePortTransport(event.port)).catch(fail);
  });
  // [契约] 只观察根元素的 class、style 与 data-theme，这三者覆盖深浅主题切换与字号变量变更
  // [权衡] 不做节流：主题切换是低频人工操作，节流反而可能漏掉紧随其后的样式变量更新
  const themes = new MutationObserver(() => {
    context.theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    Object.assign(context, readGenUiStyleContext());
    pushContext();
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  // [失败路径] 整段用 catch 收口，读文档、准备沙箱、取状态任一失败都落到 error 相位，不会停在 loading
  // [并发] finally 里才清准备标记，宿主据此决定是否继续禁用发送，提前清会让用户对着空沙箱提交
  const preparation = (async () => {
    const document = await input.files.readDocument(stateTarget);
    stateTarget = { ...stateTarget, path: document.path };
    if (disposed) return;
    let stateRevision = 0;
    stopState = input.state.onStateChanged((change) => {
      if (buildGenUiStateKey(change.target) === buildGenUiStateKey(stateTarget)) {
        stateRevision++;
        context[GEN_UI_STATE_CONTEXT_KEY] = change.state;
        pushContext();
      }
    });
    const prepared = await input.state.prepareSandbox({
      ...stateTarget,
      html: document.html,
      instanceKey: target.instanceKey,
      ownerWebContentsId: await platform.getOwnerWebContentsId(),
    });
    // [资源] 准备期间被卸载时沙箱已经启动，必须主动释放，否则进程与分区会留到下次会话
    // [并发] 这里不能只返回，沙箱句柄没有写进外层引用，主卸载流程看不到它，回收责任只能落在本分支
    // [失败路径] 回收失败会向上冒泡到失败收口，此时页面已卸载，内部的更新会被卸载闸门静默丢弃
    if (disposed) {
      await platform.disposeSandbox(prepared.sandboxId, prepared.initId);
      return;
    }
    handle = prepared;
    // 登记 HTML 含状态快照；随后读取最新状态，且不以迟到查询覆盖期间已收到的通知。
    // [并发] 先取修订号再发查询，查询期间收到的通知会自增修订号，用它判断查询结果是否已经过期
    // [事务] 只有修订号未变时才写回查询结果，否则保留通知带回来的更新值，避免旧快照覆盖新状态
    // [契约] 这里不重试查询：通知通道已经携带最新值，再查一次只会引入新的竞态窗口
    const revision = stateRevision;
    const latest = await input.state.getState(stateTarget);
    if (revision === stateRevision) context[GEN_UI_STATE_CONTEXT_KEY] = latest;
    if (disposed) return;
    plane.mount(prepared);
  })()
    .catch(fail)
    .finally(() => {
      preparing = false;
      input.onSettled?.();
    });
  // [契约] 预览原稿时投影空变更集，让 guest 恢复到初始外观，而不是把改动暂存在别处
  // [契约] 投影后立即推送上下文，不等待下一次主题变更，否则滑块拖动要等别的副作用才生效
  const projectTweaks = () => {
    context[GEN_UI_TWEAK_CONTEXT_KEY] = tweaks.annotation(
      snapshot.previewOriginal ? {} : snapshot.tweakValues,
    );
    pushContext();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    bind(node, expanded) {
      context.displayMode = expanded ? "fullscreen" : "inline";
      pushContext();
      return plane.bind({ node, kind: "flow" });
    },
    preview(node) {
      plane.preview(node);
      context.displayMode = node ? "fullscreen" : "inline";
      pushContext();
    },
    focus: () => plane.focus(),
    // [契约] 截图边界预留 5 像素内边距，避免截到 webview 圆角外的透明像素
    // [资源] operations 在 finally 里回收，截图失败也要减，否则卡片会一直被认为是忙碌状态
    async copyImage() {
      assertCurrent();
      if (!platform.copyImage)
        throw new Error("Image capture is not supported by this desktop version");
      operations++;
      try {
        await platform.copyImage({
          sandboxId: handle!.sandboxId,
          initId: handle!.initId,
          ...plane.captureBounds(5),
        });
      } finally {
        operations--;
        input.onSettled?.();
      }
    },
    setTweaks(values) {
      update({ tweakValues: { ...snapshot.tweakValues, ...values }, previewOriginal: false });
      projectTweaks();
    },
    previewTweaks(original) {
      update({ previewOriginal: original });
      projectTweaks();
    },
    // [契约] 只提交当前快照里仍存在的控件，guest 已注销的控件即使有值也不能出现在重写指令里
    // [契约] 原值一并带上，模型需要知道改前改后才能写出可比较的差异，缺省会退化成整页重写
    // [权衡] 手势标记传真：这次提交由宿主界面直接触发，不再让用户二次确认，重复确认会让滑块提交变得不可用
    async submitTweaks(values: GenUiTweakValues) {
      const groups = snapshot.groups.map((group) => ({
        title: group.title,
        controls: group.controls
          .filter((control) => Object.hasOwn(values, control.id))
          .map((control) => ({
            label: control.label,
            reference: control.reference,
            original: control.value,
            value: values[control.id],
            ...(control.type === "slider" ? { unit: control.unit } : {}),
          })),
      }));
      await followUp(
        `Update the Gen UI file ${stateTarget.path} with these design settings:\n${JSON.stringify(groups)}`,
        snapshot.tweak?.title,
        true,
      );
    },
    isBusy: () => preparing || sending || operations > 0,
    // [资源] 顺序不可调换：先置卸载标记拦住新回调，再停端口订阅与状态订阅，最后才释放桥与沙箱
    // [并发] 必须等待准备流程：正在准备的沙箱还没写进外层引用，提前返回会把它漏成孤儿进程
    // [资源] 沙箱释放放在 try 里、承载层销毁放在 finally，保证释放失败时节点仍会被移除
    // [契约] 监听集合清空放在桥关闭之后，让关闭过程中触发的最后一次通知仍能到达订阅者
    async dispose() {
      disposed = true;
      clearTimeout(handshake);
      offPorts();
      stopState?.dispose();
      themes.disconnect();
      plane.prepareUnmount();
      await bridge?.close();
      await preparation;
      listeners.clear();
      try {
        if (handle) await platform.disposeSandbox(handle.sandboxId, handle.initId);
      } finally {
        plane.dispose();
      }
    },
  };
}
