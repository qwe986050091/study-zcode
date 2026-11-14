// INV-01 模块入口 useModelSelectionServiceView 是唯一订阅点 — 守住位置：只在此处调用 onDidChange 与 getView。改错故障：多一处订阅会让事件顺序与请求序号失效。
// INV-02 owner 四元组 service/enabled/inputKey/unavailableReason — 守住位置：ownerMatches 与 effect 内 retainedReady 逐项比对。改错故障：少比一项就把别的 Target 的 ready 当成本 Owner 结果。
// INV-03 inputKey 是参数内容快照 — 守住位置：effect 依赖数组与 stableInput 记忆都锚在它上面。改错故障：改回对象引用依赖会让每次 render 重订阅并丢弃已保留目录。
// INV-04 generationRef 单调递增 — 守住位置：effect 启动与 cleanup 各加一，commit 与 read 首行校验。改错故障：卸载后的迟到响应会写回已废弃 Owner 的 state。
// INV-05 requestId 请求序号 — 守住位置：read 内自增，then 两个分支都比对。改错故障：并发重读时旧成功覆盖新结果。
// INV-06 latestRevision 水位 — 守住位置：commit 拒收 revision 低于水位的候选。改错故障：乱序事件使版本回退，界面闪回旧目录。
// INV-07 retainedCatalog 仅在 owner 一致时保留目录 — 守住位置：service/enabled/unavailableReason 三项相等才继续。改错故障：跨 Host 复用目录会让新 Host 展示错误的 Provider 列表。
// INV-08 retainedCatalog 绝不返回旧 effectiveSelection — 守住位置：只取 revision 与 providers 两个字段。改错故障：把旧选择当成新选择的解析结果，选中态错挂。
// INV-09 retainedReady 需整组 owner 匹配且状态为 ready — 守住位置：effect 内条件表达式。改错故障：仅 input 变化就误保留旧 view，掩盖新输入的读取。
// INV-10 首读失败重试上限两次 — 守住位置：INITIAL_READ_RETRY_DELAYS 与 retryCount 配对消费。改错故障：无界重试在 Host 永久不可用时空转并刷日志。
// INV-11 仅瞬时错误才重试 — 守住位置：isTransientReadError 白名单。改错故障：对权限或参数错误重试只是延迟暴露失败。
// INV-12 hasReadyView 区分已就绪与首读 — 守住位置：失败分支先判 hasReadyView 再决定写回执还是写 error。改错故障：已有 view 时写 error 会清空菜单，用户丢失可见目录。
// INV-13 refreshError 与 latestRevision 绑定 — 守住位置：setOwned 内写入刷新失败回执。改错故障：成功重读不清回执或错绑版本，界面持续显示过期错误。
// INV-14 失败必须继续 reject — 守住位置：read 的 rejection 分支结尾抛出。改错故障：吞掉 rejection 会让等待它的 Composer 悬空。
// INV-15 无 input 时事件可直接 commit — 守住位置：onDidChange 回调的 stableInput 判断。改错故障：有输入时直接接管公共事件结果，等于无视调用者原意图。
// INV-16 有 input 时事件只推进水位并触发重读 — 守住位置：先 Math.max 更新 latestRevision 再 read。改错故障：不推进水位会让重读结果被旧 revision 拒收。
// INV-17 cleanup 清 readRef 前先确认仍是自己的 read — 守住位置：readRef.current 与局部 read 比对。改错故障：新 effect 注册的 read 被旧 cleanup 置空，refresh 永久 reject。
// INV-18 外层 hook 组合 Target 与连接状态 — 守住位置：hasTarget 与 remoteWaiting 决定 enabled 与不可用原因。改错故障：远端等待期读 Local Host，会把错误 Host 的模型当作候选。
//
// 模块职责：把 IModelSelectionService 的 View 读取、事件订阅与显式刷新收敛为一份只读展示状态，对外只暴露 state、reload、refresh。
// 状态所有权：展示状态归属本 hook，服务层只提供 view 快照，调用方不得缓存该状态或另建第二条写入路径。
// 阅读顺序：先看 INV 不变量，再看 useModelSelectionServiceView 的 effect 主体，最后看 useModelSelectionView 的 Target 判定。
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

type ModelSelectionCatalog = Pick<ModelSelectionView, "revision" | "providers">;

export type ModelSelectionState =
  | { status: "loading"; catalog?: ModelSelectionCatalog }
  | { status: "ready"; view: ModelSelectionView; refreshError?: { revision: number; error: Error } }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };

export type ModelSelectionRefreshResult =
  | { kind: "ready"; view: ModelSelectionView }
  | { kind: "superseded" };

// 对外契约只有 state、reload、refresh 三项，组件不得绕过 hook 直接持有 service
// reload 通过 reducer 自增版本号重跑订阅，用于 Host 已切换等强失效场景
// refresh 返回 ready 或 superseded，调用方据此区分本次结果有效与已被后续请求取代
// superseded 不是失败，不能渲染成错误提示，否则并发刷新会给出误导性的报错
// 四种 status 必须穷举处理，unavailable 是正常态而非错误，远端等待与缺少 Target 都走这一支
export interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
  refresh(): Promise<ModelSelectionRefreshResult>;
}

// service、enabled、unavailableReason、inputKey 共同定义 owner，任一不同即视为不同订阅
// state 是最后一次由该 owner 写入的展示状态，不代表服务层的全局事实
// inputKey 用字符串快照而非对象引用，避免调用方每次 render 新建参数对象时反复订阅
// unavailableReason 参与 owner 比较，因为它决定 loading 之外的分支走向
// owner 结构不存 revision 水位，水位属于每次 effect 的局部变量，随代际一起丢弃
interface OwnedModelSelectionState {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: "remote-waiting" | "missing-target";
  inputKey: string | undefined;
  state: ModelSelectionState;
}

// 首读的临时 IO 失败未必产生 Provider 变化事件；只重读两次，不轮询业务状态或重试写操作。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;
// 只识别网络层瞬时错误码与 fetch 失败文案，业务错误一律不重试
// 未知形态的 cause 直接判为非瞬时，宁可让上层看到失败也不做无界重试
// 重试次数与延迟由 INITIAL_READ_RETRY_DELAYS 固定，不随失败次数放大等待
// 首读失败只做有限重读，Provider 变化依赖事件通知而不是定时轮询
function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

// enabled 且有 service 才进入 loading，其余情况统一落到 unavailable
// 传入 catalog 时把目录带进 loading，让菜单在首读期间保持已有条目
// catalog 用条件展开而非显式 undefined，避免可选字段被写成空值
// unavailableReason 由调用方决定，本函数不推断远端或 Target 语义，也不产生副作用
function initialState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
  catalog?: ModelSelectionCatalog,
): ModelSelectionState {
  return enabled && service
    ? { status: "loading", ...(catalog ? { catalog } : {}) }
    : { status: "unavailable", reason: unavailableReason };
}

function retainedCatalog(
  previous: OwnedModelSelectionState,
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
): ModelSelectionCatalog | undefined {
  if (
    previous.service !== service ||
    previous.enabled !== enabled ||
    previous.unavailableReason !== unavailableReason
  )
    return undefined;
  // 调档/换模型只改变解析输入；清空同 Host 目录会让菜单收缩闪烁。
  // 仅保留目录，绝不把旧 effectiveSelection 当作新选择的解析结果。
  if (previous.state.status === "ready") {
    const { revision, providers } = previous.state.view;
    return { revision, providers };
  }
  return previous.state.status === "loading" ? previous.state.catalog : undefined;
}

/** 订阅明确 Host Service；返回状态在同一次 render 即绑定新 owner，不暴露旧 Host View。 */
// service 允许 undefined，归一成 null 后再比较，避免空值形式抖动被当成换 owner
// unavailableReason 默认 remote-waiting，缺省语义是还在等远端而不是没有目标
// input 未传时事件可以直接提交，传了则事件只能触发重读，这是两种不同的信任级别
// hook 内不读取全局 store，依赖全部由参数注入，保证可测试且不产生第二份业务状态
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: "remote-waiting" | "missing-target" = "remote-waiting",
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  // 归一化必须发生在 owner 比较之前，否则服务实例在空值形式间抖动会误判换 owner
  // inputKey 是订阅依赖的唯一代表，stableInput 只是按内容记忆的缓存外壳
  // useMemo 以 inputKey 为依赖，等价于按参数内容而不是按对象引用记忆
  // reloadVersion 来自 reducer 自增，确保 reload 一定重跑 effect 而不是命中缓存
  const normalizedService = service ?? null;
  // 调用方可每次 render 创建参数对象；所有权按选择内容绑定，不按对象引用反复订阅。
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialState(normalizedService, enabled, unavailableReason),
  }));
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const generationRef = useRef(0);
  const readRef = useRef<(() => Promise<ModelSelectionRefreshResult>) | null>(null);
  const ownerMatches =
    owned.service === normalizedService &&
    owned.enabled === enabled &&
    owned.inputKey === inputKey &&
    owned.unavailableReason === unavailableReason;
  const visibleState = ownerMatches
    ? owned.state
    : initialState(
        normalizedService,
        enabled,
        unavailableReason,
        retainedCatalog(owned, normalizedService, enabled, unavailableReason),
      );

  // effect 开头先递增代际，让上一轮仍挂起的 Promise 立刻失效
  // previous 从 ownedRef 读取，ref 在 render 阶段同步赋值，保证拿到最新已提交状态
  // catalog 在换 owner 时会被 retainedCatalog 丢弃，避免跨 Host 复用目录
  // setOwned 必须在新订阅建立前完成，否则首帧会闪空或写入上一轮 owner 的状态
  // enabled 关闭或 service 缺失时提前 return，本轮不建立订阅也不发起读取
  // cleanup 必须覆盖代际、readRef、重试定时器与订阅四项，遗漏任一项都会泄漏
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const catalog = retainedCatalog(previous, normalizedService, enabled, unavailableReason);
    const retainedReady =
      previous.service === normalizedService &&
      previous.enabled === enabled &&
      previous.inputKey === inputKey &&
      previous.unavailableReason === unavailableReason &&
      previous.state.status === "ready"
        ? previous.state
        : null;
    setOwned({
      service: normalizedService,
      enabled,
      unavailableReason,
      inputKey,
      state: retainedReady ?? initialState(normalizedService, enabled, unavailableReason, catalog),
    });
    if (!enabled || !normalizedService) return;

    let latestRevision = retainedReady?.view.revision ?? catalog?.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    let requestId = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    // commit 同时校验代际与 revision 水位，分别防跨代写入与乱序回退
    // revision 相等允许提交，服务层可能在同一 revision 上补齐字段
    // 提交前取消重试，成功结果不应再被定时器覆盖
    // commit 只写 ready，失败路径由 read 的 rejection 分支独占，避免出现两条写入路径
    const commit = (candidate: ModelSelectionView): void => {
      if (generation !== generationRef.current || candidate.revision < latestRevision) return;
      latestRevision = candidate.revision;
      hasReadyView = true;
      cancelRetry();
      setOwned({
        service: normalizedService,
        enabled,
        unavailableReason,
        inputKey,
        state: { status: "ready", view: candidate },
      });
    };
    // read 先取消重试再自增请求序号，保证同一时刻只有最新请求能落地
    // 取消定时器放在自增之前，防止旧定时器在新请求发起后又触发一次读取
    // then 的两个分支都先校验代际与请求序号，迟到结果只能返回 superseded
    // success 分支调用 commit 而不是直接写 state，避免绕过水位检查
    // read 闭包捕获本轮 owner，effect 重跑后旧闭包即使被调用也写不进新 owner
    const read = (): Promise<ModelSelectionRefreshResult> => {
      cancelRetry();
      const request = ++requestId;
      return normalizedService.getView(stableInput).then(
        (candidate) => {
          if (generation !== generationRef.current || request !== requestId)
            return { kind: "superseded" };
          commit(candidate);
          return { kind: "ready", view: candidate };
        },
        (cause: unknown) => {
          // 原因：旧读取虽不能写展示 state，其 rejection 仍会被等待它的 Composer 当成当前失败。
          // owner 明确返回已被取代回执；仅当前读取失败才发布失败并拒绝。
          if (generation !== generationRef.current || request !== requestId)
            return { kind: "superseded" };
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          // 原因：保留旧 ready 不能吞掉新 revision 的失败，否则连接切换会永久等待。
          // 失败与当前 service/input 及事件 revision 绑定；保留旧目录，成功重读清除回执。
          if (hasReadyView) {
            setOwned((previous) =>
              previous.state.status === "ready"
                ? {
                    ...previous,
                    state: { ...previous.state, refreshError: { revision: latestRevision, error } },
                  }
                : previous,
            );
          } else {
            setOwned({
              service: normalizedService,
              enabled,
              unavailableReason,
              inputKey,
              state: { status: "error", error },
            });
            const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
            if (delay !== undefined && isTransientReadError(cause)) {
              retryCount += 1;
              retryTimer = setTimeout(() => {
                void read().catch(() => {});
              }, delay);
            }
          }
          throw error;
        },
      );
    };
    // 原因：相同目录不会再发事件；显式重读与订阅读取共享请求序号，迟到旧失败不能覆盖重试。
    readRef.current = read;
    const subscription = normalizedService.onDidChange((candidate) => {
      if (generation !== generationRef.current) return;
      if (stableInput === undefined) commit(candidate);
      else {
        // 公共事件没有某个调用者的原意图；只能用它触发当前输入重读，不能直接接管结果。
        latestRevision = Math.max(latestRevision, candidate.revision);
        void read().catch(() => {});
      }
    });
    void read().catch(() => {});
    return () => {
      generationRef.current += 1;
      if (readRef.current === read) readRef.current = null;
      cancelRetry();
      subscription.dispose();
    };
  }, [enabled, normalizedService, reloadVersion, unavailableReason, inputKey, stableInput]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    refresh: useCallback(
      () =>
        readRef.current
          ? readRef.current()
          : Promise.reject(new Error("Model selection owner unavailable")),
      [],
    ),
  };
}

/** 模型候选只来自明确 Workspace Target；等待远端时不读取 Local/Base Host。 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    input,
  );
}
