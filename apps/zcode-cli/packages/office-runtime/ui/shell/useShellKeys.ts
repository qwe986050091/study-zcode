// 面板全局快捷键：⌘F 查找、⌘Enter 加入对话、⌘±/⌘0 缩放，以及 Esc 逐层关闭最上层界面。
// 边界：只把按键映射成一次动作回调，不直接改文档/查看器状态；输入控件内除 Esc 外的按键一律放行。
// 副作用：仅在 window 注册一个 keydown 监听，卸载时移除；不读写存储、不改变文档内容。
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentPointer, LoadedDoc, Picked } from "#ui/shell/state.ts";
import type { DrawerTab } from "#ui/shell/panes.tsx";
import type { PageState, ViewerHandle } from "#ui/viewers/types.ts";

// 快捷键契约：只在 window 冒泡阶段监听；已被处理的按键（defaultPrevented）不再二次处理；
// 输入类控件内的按键（input/textarea/contenteditable）除 Esc 外一律放行，避免抢输入。
// Esc 按“最上层优先”逐层关闭：选择 → 抽屉（仅浮层）→ 查找 → Agent 气泡，都没开就不拦截。
// 副作用：仅注册/注销一个 keydown 监听，不读写文档状态；所有动作通过回调交给 Shell。
/**
 * 面板快捷键：⌘F、⌘Enter、⌘± / ⌘0、翻页键，以及 Esc 逐层关闭最上层界面。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为与依赖项与拆分前一致。
 */
// 输入是各动作回调与 UI 开关状态；输出无返回值，只把按键映射成最上层的一次动作。
// 副作用：window 上注册单个 keydown（capture 阶段用于 Esc 逐层关闭），卸载时移除；不修改文档状态。
// 输入框/可编辑区域内的按键不拦截，保证用户正常输入；组合键需 platform 修饰键匹配。
export function useShellKeys({
  docRef,
  viewer,
  picked,
  addReference,
  openFind,
  closeFind,
  clearSelection,
  paged,
  page,
  goToPage,
  drawer,
  setDrawer,
  docked,
  find,
  agent,
  setAgent,
}: {
  docRef: RefObject<LoadedDoc | null>;
  viewer: RefObject<ViewerHandle | null>;
  picked: Picked | null;
  addReference(): Promise<void>;
  openFind(): void;
  closeFind(): void;
  clearSelection(): void;
  paged: boolean;
  page: PageState | null;
  goToPage(n: number): void;
  drawer: { open: boolean; tab: DrawerTab };
  setDrawer: Dispatch<SetStateAction<{ open: boolean; tab: DrawerTab }>>;
  docked: boolean;
  find: { open: boolean };
  agent: AgentPointer | null;
  setAgent: Dispatch<SetStateAction<AgentPointer | null>>;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 已被内层组件（菜单/查找框）处理的按键不再重复响应。
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      // 焦点在可编辑元素内时不抢普通键（Esc 除外，用于退出输入态）。
      const typing = (event.target as Element)?.closest?.("input, textarea, [contenteditable]");
      const key = event.key.toLowerCase();
      // 没有文档时不响应 ⌘F，避免打开一个永远空结果的查找条。
      if (mod && key === "f" && docRef.current) {
        event.preventDefault();
        openFind();
      } else if (mod && event.key === "Enter" && picked) {
        event.preventDefault();
        void addReference();
      } else if (mod && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        viewer.current?.zoom(1);
      } else if (mod && event.key === "-") {
        event.preventDefault();
        viewer.current?.zoom(-1);
      } else if (mod && event.key === "0") {
        event.preventDefault();
        viewer.current?.fit("width");
      } else if (
        !mod &&
        !typing &&
        paged &&
        page &&
        ["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)
      ) {
        event.preventDefault();
        // 左/上翻回上一页，右/下前进一页；边界由查看器自行夹取（page.current 可能与实际不同步）。
        const back = event.key === "ArrowLeft" || event.key === "PageUp";
        goToPage(page.current + (back ? -1 : 1));
      } else if (event.key === "Escape" && !typing) {
        // 逐层关闭：选择优先，其次浮层抽屉（停靠抽屉不关，因为它是常驻布局），再查找，最后 Agent 气泡。
        if (picked) clearSelection();
        else if (drawer.open && !docked) setDrawer((state) => ({ ...state, open: false }));
        else if (find.open) closeFind();
        else if (agent?.visible) setAgent({ ...agent, visible: false });
        // 没有可关闭的层时不拦截 Esc，交给宿主或浏览器默认行为。
        else return;
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    picked,
    addReference,
    openFind,
    closeFind,
    clearSelection,
    paged,
    page,
    goToPage,
    drawer.open,
    docked,
    find.open,
    agent,
    docRef,
    viewer,
    setDrawer,
    setAgent,
  ]);
}
