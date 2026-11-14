// INV-01 唯一弹窗实例：守住位置 Provider 渲染的单个 Dialog；改错故障 多处入口各弹一层。
// INV-02 库存来自 hook：守住位置 useCodingPlanEntryPlanList；改错故障 弹窗自行请求套餐列表。
// INV-03 ref 镜像最新库存：守住位置 inventoryRef 赋值；改错故障 回调闭包拿到过期套餐。
// INV-04 入口守卫未就绪：守住位置 status !== "ready"；改错故障 列表未加载完就打开空弹窗。
// INV-05 已中止不再打开：守住位置 signal.aborted；改错故障 卸载后仍设置 target 造成泄漏。
// INV-06 错误态允许重试：守住位置 retry 分支；改错故障 首次失败后所有入口永久失效。
// INV-07 观察者单槽位：守住位置 opening ref；改错故障 并发点击时旧观察者收到新结果。
// INV-08 结果只回传一次：守住位置 finish 的身份比较；改错故障 关闭时重复回调。
// INV-09 abort 监听要移除：守住位置 removeEventListener；改错故障 信号释放后仍触发关闭。
// INV-10 卸载当作未打开：守住位置 空依赖 useEffect；改错故障 观察者永远等不到结果。
// INV-11 点击时冻结套餐列表：守住位置 funnelContext 展开；改错故障 埋点里列表与展示不一致。
// INV-12 openVersion 隔离 webview：守住位置 key 自增；改错故障 旧 dom-ready 确认新的观察请求。
// INV-13 上下文必须存在：守住位置 useCodingPlanUpgradeDialog 抛错；改错故障 购买入口静默失效。
// INV-14 可选上下文不抛错：守住位置 useOptionalCodingPlanUpgradeDialog；改错故障 独立挂载的会话面板崩溃。
//
// 模块职责：CodingPlanUpgradeDialogProvider 是升级弹窗的全局入口，就绪守卫与观察者回调都在这里。
// 阅读顺序：先看 context 形状，再看 openCodingPlanUpgrade 的守卫顺序，最后看 Provider 渲染。
import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CodingPlanUpgradeDialog,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/CodingPlanUpgradeDialog.js";

import {
  useCodingPlanEntryPlanList,
  type CodingPlanEntryInventory,
} from "@/hooks/useCodingPlanEntryPlanList.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { reportCodingPlanUpgradeClick } from "@/lib/codingPlanFunnelTelemetry.js";

interface CodingPlanUpgradeDialogContextValue {
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

const CodingPlanUpgradeDialogContext = createContext<CodingPlanUpgradeDialogContextValue | null>(
  null,
);

// Provider 只持有一个弹窗与一个待观察回调。
export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const inventory = useCodingPlanEntryPlanList();
  // 用 ref 镜像，避免回调依赖库存对象。
  const inventoryRef = useRef(inventory);
  inventoryRef.current = inventory;
  const [target, setTarget] = useState<CodingPlanUpgradeDialogTarget | undefined>(undefined);
  // 版本号用于重建 webview。
  const [openVersion, setOpenVersion] = useState(0);
  // opening 是单槽位 ref，只保存当前一次 openCodingPlanUpgrade 的观察者。
  const opening = useRef<((opened: boolean) => void) | null>(null);
  const handleOpenResult = useCallback((opened: boolean) => opening.current?.(opened), []);
  // 卸载时补一次未打开，防止调用方悬挂。
  useEffect(() => () => opening.current?.(false), []);
  // 所有入口共用这一条打开路径。
  const openCodingPlanUpgrade = useCallback(
    (
      nextTarget: CodingPlanUpgradeDialogTarget,
      observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
    ) => {
      // 所有入口统一守卫；查询完成后不自动重放之前被拦截的点击。
      const { status, entryPlanList } = inventoryRef.current;
      if (observation?.signal.aborted) return false;
      // 未就绪直接拒绝，不排队重放。
      if (status !== "ready") {
        if (observation && status === "error") inventoryRef.current.retry();
        return false;
      }
      opening.current?.(false);
      // 有观察者时才登记回调与中止监听。
      if (observation) {
        const finish = (opened: boolean) => {
          if (opening.current !== finish) return;
          opening.current = null;
          observation.signal.removeEventListener("abort", abort);
          if (!opened) setTarget(undefined);
          observation.onResult(opened);
        };
        // 中止等价于未打开。
        const abort = () => finish(false);
        opening.current = finish;
        observation.signal.addEventListener("abort", abort, { once: true });
      }
      // 原入口只携带当前卡片的套餐；在点击时冻结全连接列表，App 与 WebView 共用同一快照。
      // 这里把 entryPlanList 展开进 funnelContext，埋点侧读到的套餐集合与入口一致。
      nextTarget = nextTarget.funnelContext
        ? {
            ...nextTarget,
            funnelContext: { ...nextTarget.funnelContext, entryPlanList },
          }
        : nextTarget;
      if (nextTarget.funnelContext) {
        void reportCodingPlanUpgradeClick(platform, nextTarget.funnelContext);
      }
      setTarget(nextTarget);
      // 每次显式打开隔离旧 webview 事件，旧 dom-ready 不能确认新的观察请求。
      // 每次显式打开都换 key，断开旧 webview 事件。
      setOpenVersion((version) => version + 1);
      return true;
    },
    [platform],
  );
  const value = useMemo(
    () => ({ openCodingPlanUpgrade, inventory }),
    [openCodingPlanUpgrade, inventory],
  );

  return (
    <CodingPlanUpgradeDialogContext.Provider value={value}>
      {children}
      <CodingPlanUpgradeDialog
        key={openVersion}
        target={target}
        onClose={() => {
          handleOpenResult(false);
          setTarget(undefined);
        }}
        // onOpenResult 取 opening.current，只通知发起这次打开的那一个调用方。
        onOpenResult={opening.current ?? undefined}
        onReopen={setTarget}
      />
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  // useCodingPlanUpgradeDialog 在 Provider 之外调用会拿到 null，这里直接抛错而不是返回空实现。
  if (!context) {
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  }
  return context;
}

/**
 * 可独立挂载的 conversation pane 使用可选上下文；完整 App Root 仍会注入真实购买面板。
 */
export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
