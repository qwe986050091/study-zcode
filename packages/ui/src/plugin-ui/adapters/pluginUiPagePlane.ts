// 锚点由 React 侧注册注销，承载表面由本模块按布局规则挑选、迁移与定位。
// 宿主只感知可见性变化与崩溃回调，其余状态收敛在闭包内部。
//
// INV-01 承载根在整个文档里只创建一次；守住位置：parkingRoot 的既有节点查询；改错故障：叠加多个全屏定位层，页面点击被静默吞掉。
// INV-02 承载根挂在停车容器而不是锚点内部；守住位置：模块初始化时的根节点插入；改错故障：正文滚动时插件页面与锚点错位。
// INV-03 同一时刻只允许一个锚点拥有承载表面；守住位置：layout 里的 current 比对；改错故障：两个插件页面互相叠画，键盘输入落到错误页面。
// INV-04 承载层可见性由选中锚点与预览态共同决定；守住位置：layout 的 visibility 调用；改错故障：切走标签页后旧页面仍然占位可见。
// INV-05 可见性回调只在布尔值翻转时触发；守住位置：visibility 辅助函数的相等短路；改错故障：宿主收到重复通知，状态栏与任务徽标抖动。
// INV-06 已挂载 webview 的迁移必须走 moveBefore；守住位置：move 的 frame 分支；改错故障：Electron guest 被断开重建，插件 preload 状态全丢。
// INV-07 保留式迁移能力缺失时直接失败而不是降级；守住位置：move 的 moveBefore 与 connectedMoveCallback 检查；改错故障：页面看似正常但热区与渲染错位，难以排查。
// INV-08 每次选主前重置容器样式，容器只负责定位不接管输入；守住位置：resetStyle；改错故障：透明容器盖住错误态按钮，用户点不动重试。
// INV-09 绝对定位需按 CSS zoom、滚动量与 clientTop 换算；守住位置：position 的 top 与 left 计算；改错故障：系统缩放或滚动后页面漂移到锚点之外。
// INV-10 非 fixed 场景下宽高也要除以 zoom；守住位置：position 的 width 与 height 计算；改错故障：高分屏上插件页面被裁掉一圈。
// INV-11 尺寸监听只观察锚点，承载层自身不参与观察；守住位置：track 的 ResizeObserver；改错故障：popover 开合触发尺寸回环，渲染线程卡死。
// INV-12 进入 layout 先判断 disposed 短路；守住位置：layout 首行的销毁检查；改错故障：卸载后仍重建 DOM，留下无法回收的 webview。
// INV-13 选主只接受已连接、可见且非零尺寸的锚点；守住位置：candidates 的过滤条件；改错故障：隐藏标签页抢走承载表面，前台页面空白。
// INV-14 sidebar 锚点优先，其余取最后注册者；守住位置：chosen 的查找顺序；改错故障：侧边栏页面被正文页面顶掉，用户看到错误内容。
// INV-15 没有可用锚点时承载层迁回停车区并置为 inert；守住位置：layout 的未选中分支；改错故障：隐藏页面继续抢焦点，快捷键被后台页面截获。
// INV-16 执行态下保留零透明可执行表面；守住位置：layout 的 executionActive 分支；改错故障：真正隐藏后 rAF 停摆，插件后台任务永久挂起。
// INV-17 预览层是 manual popover 且全局唯一；守住位置：preview 与 endPreview 的配对；改错故障：多次预览叠加，关闭后仍有幽灵层拦截点击。
// INV-18 卸载按 handleId 校验并先摘事件再删节点；守住位置：prepareUnmount 与 unmount；改错故障：旧沙箱的崩溃事件误伤新页面，宿主被错误置为崩溃态。
//
import { autoUpdate } from "@floating-ui/dom";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
// 放置契约是唯一的入参形状：kind、node、container、layer 都由调用方给出。
// 本模块不推断页面该放在哪，只负责把给定契约落到真实 DOM 上。
import type { SandboxPagePlacement } from "../contract.js";

// 停车容器是承载根的退役位置：没有可用锚点时页面迁到这里，仍保持连接。
// 它全屏覆盖但关闭指针事件，保证既参与布局又不抢输入。
// 懒创建，首次调用才插入 body，避免模块加载阶段触碰 DOM。
function parkingRoot(): HTMLElement {
  const existing = document.querySelector<HTMLElement>("[data-sandbox-page-parking]");
  if (existing) return existing;
  const root = document.createElement("div");
  root.dataset.sandboxPageParking = "true";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:visible";
  document.body.append(root);
  return root;
}

// 刻意不用浮层跟随坐标：`root` 与正文同滚动树，滚动天然同步。
// 代价是承载层必须随锚点切换改变父节点，迁移逻辑因此成为核心复杂度。
/** 实例与锚点分离；普通内联与正文在同一滚动树内，不用屏幕坐标追赶滚动。 */
// 工厂返回受控句柄，宿主拿不到内部 DOM，只能通过方法影响页面平面。
// 两个回调是唯一的上行出口：可见性通知与崩溃通知。
// 句柄生命周期由调用方掌握，dispose 之后所有方法都应视为无效。
export function createPluginUiPagePlane(events: {
  onVisibility(visible: boolean): void;
  onCrash(): void;
}) {
  // 用 Symbol 作为注册令牌，同一 node 多次注册互不覆盖，注销只影响自己那一份。
  // visible 由 IntersectionObserver 写入，是布局选主的输入而非结果。
  // 注册顺序决定兜底优先级，因为后排的锚点更可能是最新打开的页面。
  const anchors = new Map<symbol, { placement: SandboxPagePlacement; visible: boolean }>();
  const root = document.createElement("div");
  root.dataset.sandboxPageRoot = "true";
  root.style.display = "none";
  parkingRoot().append(root);
  let frame: HTMLElement | null = null;
  let handleId: string | null = null;
  let current: symbol | undefined;
  let stopLayout: (() => void) | undefined;
  let stopPreview: (() => void) | undefined;
  let preview: HTMLElement | null = null;
  let executionActive = false;
  let backgroundSize = { width: 640, height: 480 };
  // `disposed` / `loaded` / `pluginLoaded` / `visible` 四个布尔共享一次声明，语义各自独立。
  // 拆开写会更清晰，此处与初始化顺序保持一致，新增字段需同步重置。
  let disposed = false,
    loaded = false,
    pluginLoaded = false,
    visible = false;
  const visibility = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    events.onVisibility(next);
  };
  // 迁移是幂等的：父节点相同直接返回，避免无意义的重排与 guest 扰动。
  // 未挂载 webview 前承载层可以自由移动，挂载后必须依赖浏览器的保留式迁移。
  // 迁移失败不能吞掉，否则后续所有定位都会建立在错误的父坐标系上。
  const move = (parent: HTMLElement) => {
    if (root.parentElement === parent) return;
    if (!frame) parent.append(root);
    else {
      // appendChild 会触发 Electron guest 的断开重建。preload 为沙箱注册移动回调后才允许迁移。
      if (
        typeof parent.moveBefore !== "function" ||
        typeof (frame as HTMLElement & { connectedMoveCallback?: unknown })
          .connectedMoveCallback !== "function"
      )
        // 这是明确的失败路径：能力缺失说明运行环境版本过低或 preload 未注入。
        // 直接抛出比静默降级更安全，降级会让页面错位却看似正常。
        throw new Error("Sandbox retained moves are unavailable; restart the desktop app");
      parent.moveBefore(root, null);
    }
  };
  // 每次选主先回到中性样式，避免上一个锚点残留的定位、层级与尺寸污染新页面。
  // 容器不接收指针事件，交互一律交给内部 webview 显式承担。
  const resetStyle = () => {
    // webview 释放后容器仍可能覆盖错误态按钮；容器只负责定位，点击由 webview 显式接收。
    root.style.cssText =
      "display:flow-root;position:relative;width:100%;height:100%;margin:0;border:0;padding:0;overflow:hidden;pointer-events:none";
  };
  // fixed 与 absolute 走两套坐标系：前者用视口矩形，后者用容器矩形叠加滚动量。
  // zIndex 由放置契约提供，默认层级只是兜底，不参与优先级竞争。
  // 圆角从锚点计算样式复制，保证承载层视觉与锚点边界一致。
  const position = (node: HTMLElement, container: HTMLElement, fixed: boolean, layer: number) => {
    const rect = node.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    const zoom = (container as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
    Object.assign(root.style, {
      position: fixed ? "fixed" : "absolute",
      inset: "auto",
      zIndex: String(layer),
      top: `${fixed ? rect.top : (rect.top - parent.top) / zoom + container.scrollTop - container.clientTop}px`,
      left: `${fixed ? rect.left : (rect.left - parent.left) / zoom + container.scrollLeft - container.clientLeft}px`,
      width: `${rect.width / (fixed ? 1 : zoom)}px`,
      height: `${rect.height / (fixed ? 1 : zoom)}px`,
      borderRadius: getComputedStyle(node).borderRadius,
    });
  };
  const endPreview = () => {
    stopPreview?.();
    stopPreview = undefined;
    if (root.matches(":popover-open")) root.hidePopover();
    root.removeAttribute("popover");
    preview = null;
  };
  // 返回停止函数，让调用方能一次性摘掉监听与观察，避免半释放。
  // 只观察锚点：观察承载层会在 popover 切换时形成尺寸回环。
  // 尺寸或位置任一变都会重新定位，更新逻辑由调用方注入。
  const track = (node: HTMLElement, update: () => void) => {
    // 承载层尺寸完全由锚点决定；反向观察承载层会在 popover 切换时形成 ResizeObserver 回环。
    const stop = autoUpdate(node, root, update, { elementResize: false });
    const resize = new ResizeObserver(update);
    resize.observe(node);
    return () => {
      resize.disconnect();
      stop();
    };
  };
  // 布局是纯派生动作，可以重复调用，结果只取决于当前锚点集合与执行态。
  // 选中锚点未变时提前返回，避免打断已建立的监听与预览。
  // 选主变化时按固定顺序收尾：停监听、结束预览、重置样式、再重新挂载定位。
  const layout = () => {
    if (disposed) return;
    // forceMount 的隐藏 tab 仍连接 DOM，但尺寸为零；不能让它夺走后台初始化的承载表面。
    const candidates = [...anchors].filter(([, a]) => {
      const node = a.placement.node;
      const rect = node.getBoundingClientRect();
      return (
        node.isConnected &&
        node.checkVisibility({ visibilityProperty: true }) &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    // 侧边栏是常驻入口，`placement.kind === "sidebar"` 优先；其余取 `at(-1)` 近似最新页面。
    // 选择结果决定 current，进而决定承载层的父节点与坐标系。
    const chosen = candidates.find(([, a]) => a.placement.kind === "sidebar") ?? candidates.at(-1);
    visibility(Boolean(chosen && (chosen[1].visible || preview)));
    if (chosen && chosen[0] === current) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0)
      backgroundSize = { width: bounds.width, height: bounds.height };
    current = chosen?.[0];
    stopLayout?.();
    stopLayout = undefined;
    endPreview();
    resetStyle();
    // `chosen` 为空意味着没有前台页面：承载层回到 `parkingRoot()`，隐藏并禁用交互。
    // 隐藏前先记录上一次有效尺寸，供执行态复用，避免零尺寸传播给插件。
    // 该分支必须保持可重复进入，页面频繁切换时会多次命中。
    if (!chosen) {
      move(parkingRoot());
      root.style.display = "none";
      root.inert = true;
      // 执行态下插件仍需运行，只是不可见：真正隐藏会停掉编辑器依赖的动画帧。
      // 因此保留一个 fixed 定位、极小透明度的表面，尺寸取上一次有效值。
      // 该表面保持 inert，既不接收输入，也不会抢走前台焦点。
      if (executionActive) {
        // display:none 会停止编辑器依赖的 rAF；保留的 MCP 页面始终需要可执行且不接收输入的表面。
        Object.assign(root.style, {
          display: "block",
          position: "fixed",
          top: "0",
          left: "0",
          width: `${backgroundSize.width}px`,
          height: `${backgroundSize.height}px`,
          opacity: "0.001",
        });
      }
      return;
    }
    root.inert = false;
    const { node, kind, container, layer = 10 } = chosen[1].placement;
    const parent = kind === "sidebar" ? parkingRoot() : (container ?? node);
    move(parent);
    if (kind !== "flow" && parent !== node)
      stopLayout = track(node, () => {
        const rect = node.getBoundingClientRect();
        if (!node.checkVisibility({ visibilityProperty: true }) || !rect.width || !rect.height) {
          layout();
          return;
        }
        position(node, parent, kind === "sidebar", layer);
      });
  };
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries)
      for (const a of anchors.values())
        if (a.placement.node === entry.target) a.visible = entry.isIntersecting;
    layout();
  });
  const ready = () => {
    loaded = true;
  };
  const frameReady = (event: Event) => {
    if (!(event as Event & { isMainFrame?: boolean }).isMainFrame) pluginLoaded = true;
  };
  // 只有同构导航才算正常换页，外壳与插件层的越界导航都判定为崩溃。
  // 就地导航被放行，因为插件内部的哈希跳转不应销毁宿主状态。
  const navigation = (event: Event) => {
    const nav = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
    if (!nav.isInPlace && ((loaded && nav.isMainFrame) || (pluginLoaded && !nav.isMainFrame)))
      events.onCrash();
  };
  const prepareUnmount = (expectedId?: string) => {
    if (expectedId && expectedId !== handleId) return;
    frame?.removeEventListener("render-process-gone", events.onCrash);
    frame?.removeEventListener("dom-ready", ready);
    frame?.removeEventListener("did-start-navigation", navigation);
    frame?.removeEventListener("did-frame-finish-load", frameReady);
    loaded = false;
    pluginLoaded = false;
  };
  const unmount = (expectedId?: string) => {
    if (expectedId && expectedId !== handleId) return;
    prepareUnmount(expectedId);
    frame?.remove();
    frame = null;
    handleId = null;
  };
  return {
    setExecutionActive(active: boolean) {
      if (executionActive === active) return;
      executionActive = active;
      layout();
    },
    // 注册返回注销函数，让调用方用同一令牌成对释放，避免泄漏。
    // 同一节点可能被多份契约引用，只有最后一份注销后才停止观察。
    // 注销后立刻重排而不是排到下一帧，React 卸载顺序不允许异步补位。
    bind(placement: SandboxPagePlacement) {
      const token = Symbol();
      anchors.set(token, { placement, visible: true });
      intersection.observe(placement.node);
      layout();
      return () => {
        anchors.delete(token);
        if (![...anchors.values()].some((a) => a.placement.node === placement.node))
          intersection.unobserve(placement.node);
        // 必须同步迁移，再让 React 删除锚点；不能放到 RAF / passive effect。
        layout();
      };
    },
    preview(node: HTMLElement | null) {
      endPreview();
      resetStyle();
      if (!node) {
        current = undefined;
        layout();
        return;
      }
      preview = node;
      root.setAttribute("popover", "manual");
      root.showPopover();
      const update = () => position(node, document.documentElement, true, 45);
      stopPreview = track(node, update);
      visibility(true);
    },
    captureBounds(gutter = 0) {
      if (!frame || !visible) throw new Error("Sandbox is not visible");
      const rect = frame.getBoundingClientRect();
      return {
        viewportSize: { width: rect.width, height: rect.height },
        captureRect: {
          x: gutter,
          y: gutter,
          width: rect.width - gutter * 2,
          height: rect.height - gutter * 2,
        },
      };
    },
    focus() {
      frame?.focus();
    },
    // 同一 sandboxId 重复挂载直接复用，这是重复注册的幂等边界。
    // 换句柄时先完整卸载旧实例，再按新地址与分区重建 webview。
    // 事件在插入 DOM 前注册，避免首帧加载事件漏接。
    // webview 属性一次性写全，后续改动只允许走卸载重建路径。
    mount(handle: PluginSandboxHandle) {
      if (handleId === handle.sandboxId) return;
      unmount();
      handleId = handle.sandboxId;
      frame = document.createElement("webview");
      frame.setAttribute("data-zcode-retained-sandbox", "");
      frame.setAttribute("src", handle.shellUrl);
      frame.setAttribute("partition", handle.partition);
      frame.setAttribute("data-testid", "plugin-ui-webview");
      frame.style.cssText =
        "display:flex;width:100%;height:100%;border:0;background:transparent;pointer-events:auto";
      frame.addEventListener("render-process-gone", events.onCrash);
      frame.addEventListener("dom-ready", ready);
      frame.addEventListener("did-frame-finish-load", frameReady);
      frame.addEventListener("did-start-navigation", navigation);
      root.append(frame);
    },
    prepareUnmount,
    unmount,
    // 销毁顺序固定：先置位，再停预览与布局，最后移除节点并清空注册表。
    // 置位必须最先执行，其他异步回调依赖它短路。
    dispose() {
      disposed = true;
      endPreview();
      stopLayout?.();
      unmount();
      intersection.disconnect();
      anchors.clear();
      root.remove();
    },
  };
}
