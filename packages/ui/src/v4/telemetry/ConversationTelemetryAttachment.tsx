// INV-01 附件生命周期高于面板：守住位置 工作区附件组件；改错故障：面板关闭即销毁监督器，后台终端事件丢失。
// INV-02 监督器按会话、工作区与服务代际三键登记：守住位置 键构造；改错故障：少一维会让新旧代共用同一订阅。
// INV-03 同逻辑作用域换代时旧键立即出册：守住位置 登记前清理循环；改错故障：新旧两代同时订阅同一工作区，事件重复计数。
// INV-04 旧代仍有引用时只标记陈旧：守住位置 清理循环的引用判断；改错故障：立即销毁会让仍在使用的面板拿到已释放监督器。
// INV-05 引用计数归零且陈旧或已分离才销毁：守住位置 释放闭包；改错故障：归零即销毁会让后台保活期内的事件丢失。
// INV-06 释放是幂等的：守住位置 释放闭包的重入标记；改错故障：重复释放会让引用计数减成负数。
// INV-07 工作区分离由根标签裁决：守住位置 对账函数；改错故障：切标签被当作分离，会让仍在托盘的后台会话停止上报。
// INV-08 分离且零引用时立即销毁：守住位置 对账函数的分支；改错故障：残留监督器会继续持有订阅与计时器。
// INV-09 订阅是懒建立的：守住位置 订阅函数的早返回；改错故障：重复建立会让同一事实被处理多次。
// INV-10 订阅只在存在租约时建立：守住位置 副作用的提前返回；改错故障：无租约仍订阅会在销毁后继续回调。
// INV-11 销毁顺序固定：先出册、再释放订阅、最后销毁监督器，守住位置 销毁函数；改错故障：顺序颠倒会让回调在销毁过程中重入。
// INV-12 上下文值随作用域与服务变化重建：守住位置 值缓存依赖；改错故障：漏依赖会让面板持有旧会话的监督器。
// INV-13 依赖未就绪时不建立租约：守住位置 租约派生；改错故障：平台或代理缺失时抛错会阻断整个工作区界面。
// INV-14 Web 根附件不创建监督器：守住位置 上下文默认值；改错故障：在无平台环境建监督器会持续失败重试。
// INV-15 面板附件继承父级的启用态：守住位置 面板包装组件；改错故障：自行启用会在父级关闭时仍上报。
// INV-16 作用域比较忽略可选字段缺失：守住位置 作用域比较函数；改错故障：空与否被视为不同作用域，面板永远取不到监督器。
// INV-17 作用域键使用不可见分隔符拼接：守住位置 两个键函数；改错故障：用可打印分隔符会让含该字符的路径串键。
// INV-18 全局销毁只用于窗口或测试边界：守住位置 导出销毁函数；改错故障：在页面切换时调用会清掉仍存活工作区的订阅。
//
// 模块职责：在工作区级挂载会话遥测监督器，按服务代际登记、复用与释放，并向面板暴露作用域内实例。
// 状态所有权：登记表与代际编号是模块级状态；组件只持有租约与作用域记忆值。
// 阅读顺序：先看作用域与代际工具，再看登记与销毁，最后看三个组件与两个作用域查询 Hook。
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { resolveWorkspaceTelemetryDetail, type IPlatformService } from "@zcode/shared";
import { createConversationTelemetryService, type IServiceAccessor } from "@zcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

interface ConversationTelemetryAttachmentScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface ConversationTelemetryAttachmentValue {
  scope: ConversationTelemetryAttachmentScope;
  supervisor: ConversationTelemetrySupervisor;
  foregroundEnabled: boolean;
}

// 登记项把键、逻辑作用域、监督器与引用计数放在一起
// [失败路径] 缺少逻辑作用域就无法在工作区分离时做对账
// 订阅句柄可为空，表示尚未建立懒订阅
// 陈旧与分离是两种独立状态：前者因换代，后者因根标签移除
// 这两个标记只在释放或对账时被读取
interface SupervisorRegistryEntry {
  key: string;
  logicalScopeKey: string;
  supervisor: ConversationTelemetrySupervisor;
  refCount: number;
  subscription: { dispose(): void } | null;
  stale: boolean;
  workspaceDetached: boolean;
}

interface SupervisorLease {
  entry: SupervisorRegistryEntry;
  release(): void;
}

const serviceGenerationIds = new WeakMap<object, number>();
let nextServiceGenerationId = 1;
const supervisorRegistry = new Map<string, SupervisorRegistryEntry>();

// 服务代际按对象缓存，同一服务永远得到同一编号
// [失败路径] 每次重新分配会让同一服务被当成两代，触发无谓重建
// nextServiceGenerationId 单调递增，编号只表示代际新旧而不表达顺序语义
// serviceGenerationIds 是以 service 对象为键的 WeakMap，不阻止对象被 GC 回收
// serviceGenerationId 是 attachmentScopeKey 的一部分，必须廉价且对同一 service 幂等
function serviceGenerationId(service: object): number {
  const existing = serviceGenerationIds.get(service);
  if (existing !== undefined) return existing;
  const created = nextServiceGenerationId;
  nextServiceGenerationId += 1;
  serviceGenerationIds.set(service, created);
  return created;
}

function attachmentScopeKey(scope: ConversationTelemetryAttachmentScope, service: object): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [scope.remoteSessionId ?? "__base__", workspaceKey, serviceGenerationId(service)].join(
    "\u0000",
  );
}

function logicalAttachmentScopeKey(scope: ConversationTelemetryAttachmentScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [scope.remoteSessionId ?? "__base__", workspaceKey].join("\u0000");
}

function sameScope(
  left: ConversationTelemetryAttachmentScope,
  right: ConversationTelemetryAttachmentScope,
): boolean {
  return (
    (left.remoteSessionId ?? "__base__") === (right.remoteSessionId ?? "__base__") &&
    (left.workspaceIdentity?.trim() || left.workspacePath) ===
      (right.workspaceIdentity?.trim() || right.workspacePath)
  );
}

// 取用租约前先清理同逻辑作用域的其它代际
// [失败路径] 不清理会让新旧两代同时订阅同一工作区，事件重复
// 旧代 refCount 归零立即 disposeSupervisorEntry，否则只置 stale 等引用释放
// acquireSupervisor 命中 supervisorRegistry 现有键时只 refCount += 1，不重建监督器
// release 闭包用 released 标记保证 refCount 只减一次，重复调用直接返回
function acquireSupervisor(
  scope: ConversationTelemetryAttachmentScope,
  services: IServiceAccessor,
  platform: Pick<IPlatformService, "reportArmsCustomEvent" | "reportTelemetryEvent">,
): SupervisorLease {
  const logicalScopeKey = logicalAttachmentScopeKey(scope);
  const key = attachmentScopeKey(scope, services.zcodeAgentService);
  // service generation 换代时，零引用旧 supervisor 立即销毁；仍被 pane 使用的旧代标 stale，
  // 等末位 lease 释放再清理。不能让旧/新 generation 同时长期订阅同一 workspace。
  for (const [candidateKey, candidate] of supervisorRegistry) {
    if (candidate.logicalScopeKey !== logicalScopeKey || candidateKey === key) {
      continue;
    }
    supervisorRegistry.delete(candidateKey);
    candidate.stale = true;
    if (candidate.refCount === 0) disposeSupervisorEntry(candidate);
  }
  let entry = supervisorRegistry.get(key);
  if (entry) {
    entry.refCount += 1;
  } else {
    entry = {
      key,
      logicalScopeKey,
      supervisor: new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: key,
        workspaceTelemetryDetail: resolveWorkspaceTelemetryDetail(scope),
      }),
      refCount: 1,
      subscription: null,
      stale: false,
      workspaceDetached: false,
    };
    supervisorRegistry.set(key, entry);
  }
  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      if (entry.stale || entry.workspaceDetached) {
        disposeSupervisorEntry(entry);
      }
      // ref=0 的当前 generation 仍保留 live subscription。关闭 pane 不能等价于
      // workspace detach，否则超过 SessionDataLayer 30s keep-warm 的后台 terminal 会丢。
    },
  };
}

// disposeSupervisorEntry 先出册再释放 subscription，最后 dispose 监督器
// [失败路径] 顺序颠倒会让 subscription 回调在销毁过程中重入
// 出册前比对 supervisorRegistry.get(entry.key) === entry，避免误删接管者
// subscription 句柄置空，防止后续重复释放
// 该函数只由 disposeConversationTelemetrySupervisors 与登记表内部调用
function disposeSupervisorEntry(entry: SupervisorRegistryEntry): void {
  if (supervisorRegistry.get(entry.key) === entry) {
    supervisorRegistry.delete(entry.key);
  }
  entry.subscription?.dispose();
  entry.subscription = null;
  entry.supervisor.dispose();
}

/** 窗口/测试销毁边界；生产 page 生命周期结束时不保留 orphan subscription。 */
export function disposeConversationTelemetrySupervisors(): void {
  for (const entry of supervisorRegistry.values()) {
    disposeSupervisorEntry(entry);
  }
  supervisorRegistry.clear();
}

/**
 * Root tab 事实源裁决 workspace detach。切 task/切 tab 不会移除 scope；真正关闭最后一个
 * workspace tab 才标记 detached，零引用立即销毁，有存量 pane 则等其 release 后销毁。
 */
// 对账以根标签提供的作用域集合为权威
// [失败路径] 把切标签当作分离，会让后台会话停止上报
// reconcileConversationTelemetryWorkspaceScopes 只置 workspaceDetached，有引用时不销毁
// 分离且 refCount 为 0 才立即 disposeSupervisorEntry，避免残留订阅与计时器
// 该函数可重复调用，结果只取决于 attachedKeys 当前成员
export function reconcileConversationTelemetryWorkspaceScopes(
  scopes: readonly ConversationTelemetryAttachmentScope[],
): void {
  const attachedKeys = new Set(scopes.map(logicalAttachmentScopeKey));
  for (const entry of supervisorRegistry.values()) {
    entry.workspaceDetached = !attachedKeys.has(entry.logicalScopeKey);
    if (entry.workspaceDetached && entry.refCount === 0) {
      disposeSupervisorEntry(entry);
    }
  }
}

// 订阅是懒建立的：已有句柄即返回，天然幂等
// [失败路径] 重复建立会让同一事实被处理多次，指标翻倍
// 服务来自当前作用域，而不是登记时的快照
// 事实回调直接转交监督器，中间不做转换
// 可选身份仅在存在时透传，避免 schema 出现空值
function ensureSupervisorSubscription(
  entry: SupervisorRegistryEntry,
  scope: ConversationTelemetryAttachmentScope,
  services: IServiceAccessor,
): void {
  if (entry.subscription) return;
  const telemetryService = createConversationTelemetryService(services.zcodeAgentService);
  const factEvent = telemetryService.onFact({
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  });
  entry.subscription = factEvent((fact: ConversationTelemetryFact) =>
    entry.supervisor.handleFact(fact),
  );
}

const ConversationTelemetryAttachmentContext =
  createContext<ConversationTelemetryAttachmentValue | null>(null);

/**
 * 窗口 workspace/service attachment：生命周期高于 pane 和 SessionDataLayer keep-warm。
 * Web/mobile 不创建 supervisor，也不安装 reporter/subscription。
 */
// ConversationTelemetryWorkspaceAttachment 的生命周期比 pane 与 SessionDataLayer keep-warm 更长
// [失败路径] services 未就绪时抛错会连带阻断整个工作区界面，所以这里选择降级
// services 缺失或 enabled 为 false 时不建立租约，只渲染 children
// useMemo 依赖 scope 与 supervisor registry，foregroundEnabled 变化也会重建上下文值
// useEffect 只负责 acquireSupervisor 订阅与卸载时 release，不写任何全局状态
export function ConversationTelemetryWorkspaceAttachment({
  enabled,
  foregroundEnabled = true,
  services,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  children,
}: ConversationTelemetryAttachmentScope & {
  enabled: boolean;
  foregroundEnabled?: boolean;
  services: IServiceAccessor;
  children: ReactNode;
}) {
  const platform = useOptionalPlatform();
  const scope = useMemo<ConversationTelemetryAttachmentScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );
  const lease = useMemo(() => {
    const agentService = services.zcodeAgentService as object | null | undefined;
    if (!enabled || !platform || !agentService) return null;
    // Bug 根因：Root 的隔离渲染和远端 service 准备阶段可能尚无 PlatformProvider 或 agent service。
    // telemetry 是旁路能力，不能因依赖未就绪阻断 workspace 主界面；依赖齐备后再按 generation 建 lease。
    return acquireSupervisor(scope, services, platform);
  }, [enabled, platform, scope, services]);
  const supervisor = lease?.entry.supervisor ?? null;

  useEffect(() => {
    if (!lease) return undefined;
    ensureSupervisorSubscription(lease.entry, scope, services);
    return () => {
      lease.release();
    };
  }, [lease, scope, services]);

  const value = useMemo<ConversationTelemetryAttachmentValue | null>(
    () => (supervisor ? { scope, supervisor, foregroundEnabled } : null),
    [foregroundEnabled, scope, supervisor],
  );
  return (
    <ConversationTelemetryAttachmentContext.Provider value={value}>
      {children}
    </ConversationTelemetryAttachmentContext.Provider>
  );
}

/** pane 使用自己的 ready service/scope 覆盖 context；Web 根 attachment 为 null 时保持 no-op。 */
export function ConversationTelemetryPaneAttachment({
  services,
  scope,
  children,
}: {
  services: IServiceAccessor;
  scope: ConversationTelemetryAttachmentScope;
  children: ReactNode;
}) {
  const parentAttachment = useContext(ConversationTelemetryAttachmentContext);
  return (
    <ConversationTelemetryWorkspaceAttachment
      enabled={parentAttachment !== null}
      foregroundEnabled={parentAttachment?.foregroundEnabled ?? false}
      services={services}
      workspacePath={scope.workspacePath}
      workspaceIdentity={scope.workspaceIdentity}
      remoteSessionId={scope.remoteSessionId}
    >
      {children}
    </ConversationTelemetryWorkspaceAttachment>
  );
}

export function useScopedConversationTelemetrySupervisor(
  scope: ConversationTelemetryAttachmentScope,
): ConversationTelemetrySupervisor | null {
  const attachment = useContext(ConversationTelemetryAttachmentContext);
  return attachment && sameScope(attachment.scope, scope) ? attachment.supervisor : null;
}

export function useScopedConversationTelemetryForegroundEnabled(
  scope: ConversationTelemetryAttachmentScope,
): boolean {
  const attachment = useContext(ConversationTelemetryAttachmentContext);
  return Boolean(attachment && attachment.foregroundEnabled && sameScope(attachment.scope, scope));
}
