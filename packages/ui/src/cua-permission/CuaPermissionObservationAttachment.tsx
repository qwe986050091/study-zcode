// INV-01 观察对象只在回调作用域内消费，守住位置指其生命周期不越过 effect；改错故障是排队任务读到已切换 workspace 的旧授权
// INV-02 去重键由工作区、会话、事件与缺失权限共同构成，守住位置指键必须在入队前算好；改错故障是同一事件被重复弹窗
// INV-03 已处理集合只记录正常终态，守住位置指异常分支不得落库；改错故障是权限失败后再也无法重试
// INV-04 待处理集合在任务收尾阶段必被释放，守住位置指释放发生在去重写入之后；改错故障是键永久卡住导致静默丢弃
// INV-05 串行链保证同一时刻只有一个授权流程，守住位置指链的赋值发生在订阅回调内；改错故障是两次确认框互相抢焦点
// INV-06 缺失权限为空即视为无需引导，守住位置指空值判断在弹窗之前；改错故障是无缺失时仍打扰用户
// INV-07 确认之后必须重读真值，守住位置指第二次读取独立于第一次；改错故障是窗口切换后仍按过期结论打开设置
// INV-08 单次重试只能覆盖瞬态失败，守住位置指尝试上限固定为两次；改错故障是坏状态反复重试拖慢界面
// INV-09 Helper 重启与打开设置分离，守住位置指重启只由返回结果触发；改错故障是重启失败后又把用户弹回系统设置
// INV-10 用户取消属于正常终态，守住位置指取消不得计为失败；改错故障是取消被当成错误并触发重试
// INV-11 引导操作标识在发起时登记、结束时清理，守住位置指登记与清理成对出现；改错故障是卸载后取消到错误的操作
// INV-12 卸载边界先置位再释放订阅，守住位置指释放顺序不可交换；改错故障是已关闭的订阅仍触发旧工作区副作用
// INV-13 平台能力缺失时整段引导降级为空渲染，守住位置指能力检测在任何订阅之前；改错故障是缺失接口被调用后抛错并中断渲染
// INV-14 刷新只用于成功且从设置返回的分支，守住位置指刷新不参与流程判定；改错故障是把取消也当成授权成功
// INV-15 重试间隔是固定常量，守住位置指延迟只影响节奏不影响结论；改错故障是退避被误当成授权状态判断依据
// INV-16 订阅回调失败只记录日志不外抛，守住位置指异常在任务内部被吞掉；改错故障是单次失败导致整条串行链断裂
// INV-17 已处理集合设有容量上限并淘汰最旧项，守住位置指淘汰发生在写入之后；改错故障是长时间运行后内存单调增长
// INV-18 渲染结果恒为空，守住位置指组件不产生任何可见节点；改错故障是误插占位元素破坏宿主布局
//
// 模块职责：在动态权限观察到达时驱动一次性的授权引导，并在订阅清理时收回未完成的操作
// 状态所有权：观察数据与去重集合归 effect 私有，跨组件共享的只有服务层缓存的权限状态
// 阅读顺序：先看不变量，再看注入依赖与重试语义，最后看组件内的排队与清理
import { useEffect } from "react";
import type { CuaAccessibilitySettingsResult, CuaPermissionKind } from "@zcode/shared";
import { requiredCuaPermissionsForRequestAccessStatus } from "@zcode/shared/zcode-protocol-v4";
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatusResult,
  type ZCodeAgentCuaPermissionObservation,
} from "@zcode/services";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { shouldRestartHelperAfterCuaPermissionReturn } from "@/lib/cuaPermissionAction.js";
import { createCuaPermissionOnboardingOperationId } from "@/lib/cuaPermissionOnboardingOperation.js";
import { fetchCuaPermissionStatus } from "@/lib/cuaPermissionStatusStore.js";
import { logger } from "@/logger.js";
import { requiredCuaPermissionsForFreshStatus } from "@/settings/cuaPermissionPreparation.js";

// 这组依赖把授权流程与具体实现解耦，测试可注入假实现逐段验证分支
// 观察数据不进入依赖，组件回调时以参数传入，避免陈旧快照
// 确认、引导、重启各自独立，任一环节缺失都不应让整段流程静默通过
// isDisposed 是可选能力，老调用方未提供时按始终存活处理
// refresh 只负责失效缓存且不返回状态，因此不能当成判定依据
// 上述约定属于本文件不变量，改动前先确认没有绕过依赖直连服务
interface CuaPermissionPromptDependencies {
  getStatus(): Promise<CuaPermissionStatusResult>;
  confirm(required: CuaPermissionKind[]): Promise<boolean>;
  openOnboarding(required: CuaPermissionKind[]): Promise<CuaAccessibilitySettingsResult>;
  restartHelper(options: CuaPermissionRestartOptions): Promise<{ ok: boolean; reason?: string }>;
  refresh(): void;
  isDisposed?(): boolean;
}

// 常量固定为半秒，取值来自人工验证的经验值而非自适应策略
// 固定延迟让失败路径可预测，也避免重试与用户操作在同一帧竞争
// 改动此值只影响节奏，不改变尝试次数与最终结论
// 若未来扩展为退避，必须保持总尝试次数不变，否则去重语义被拖长
// 该常量只服务于授权引导链路，不应被其他模块复用为通用等待
// 调试时不要调大它来规避竞态，竞态应在串行化层面解决
const CUA_PERMISSION_RETRY_DELAY_MS = 500;

function assertCuaPermissionPromptActive(dependencies: CuaPermissionPromptDependencies): void {
  if (dependencies.isDisposed?.()) throw new Error("CUA permission prompt disposed");
}

// 语义是至多两次尝试：首次失败后等待固定间隔再试一次，随后必然放弃
// 每次尝试前后都校验生命周期，避免组件卸载后继续产生副作用
// failureReason 把业务失败折叠成异常，让重试逻辑保持单一形态
// 已释放时不重试，直接把异常抛回调用方，由上层决定是否记录
// 重试耗尽属于不可恢复状态，调用方不得依赖其内部循环变量
// 重试只吸收瞬态错误，权限被拒绝这类确定性失败应在弹窗阶段拦截
async function runWithOneRetry<T>(
  dependencies: CuaPermissionPromptDependencies,
  operation: () => Promise<T>,
  failureReason?: (result: T) => string | undefined,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertCuaPermissionPromptActive(dependencies);
    try {
      const result = await operation();
      assertCuaPermissionPromptActive(dependencies);
      const reason = failureReason?.(result);
      if (reason) throw new Error(reason);
      return result;
    } catch (error) {
      if (attempt === 1 || dependencies.isDisposed?.()) throw error;
      await new Promise((resolve) => setTimeout(resolve, CUA_PERMISSION_RETRY_DELAY_MS));
    }
  }
  throw new Error("CUA permission retry exhausted");
}

// 键的职责是把同一次授权诉求折叠成稳定字符串，供去重集合判定
// 工作区标识优先用规范化别名，缺失时回退到原始路径，保证跨窗口一致
// 缺少权限列表参与拼接，权限集合变化会被视为新的诉求
// 事件编号在没有轮次编号时兜底，避免不同事件共享同一键
// 分隔符选不可见字符，降低拼接歧义带来的误判
// 键必须在入队前计算，队列内部不再重新推导，防止观察对象被后续修改
export function cuaPermissionObservationKey(
  observation: ZCodeAgentCuaPermissionObservation,
): string {
  const workspaceKey = observation.workspaceIdentity?.trim() || observation.workspacePath;
  const missing = requiredCuaPermissionsForRequestAccessStatus(observation.permissionStatus);
  return [
    workspaceKey,
    observation.sessionId,
    observation.turnId ?? observation.eventId,
    missing.join(","),
  ].join("\0");
}

// 流程顺序固定：读真值、确认、再读真值、打开设置、按需重启、最后刷新
// 两次读取的差异代表确认期间状态可能变化，第二次结果才是决策依据
// 任一阶段读到空缺失列表即提前返回，避免对已授权状态重复打扰
// 用户拒绝确认视为正常结束，不记录失败也不触发重试
// 取消引导与打开失败被区别对待，前者静默返回，后者进入错误路径
// 刷新仅在成功且确实从系统设置返回时执行，其余分支保持缓存不变
export async function runCuaPermissionPrompt(
  dependencies: CuaPermissionPromptDependencies,
): Promise<void> {
  const readMissing = async () => {
    const status = await runWithOneRetry(dependencies, dependencies.getStatus);
    return isCuaPermissionStatusAvailable(status)
      ? requiredCuaPermissionsForFreshStatus(status)
      : [];
  };
  const beforeConfirm = await readMissing();
  if (beforeConfirm.length === 0) return;
  assertCuaPermissionPromptActive(dependencies);
  if (!(await dependencies.confirm(beforeConfirm))) return;
  assertCuaPermissionPromptActive(dependencies);

  // 原因：确认框停留期间可能已从另一窗口授权，打开设置前必须再读一次 Helper 真值。
  const afterConfirm = await readMissing();
  if (afterConfirm.length === 0) return;
  const result = await runWithOneRetry(
    dependencies,
    () => dependencies.openOnboarding(afterConfirm),
    (value) =>
      !value.success && !value.canceled
        ? `CUA permission onboarding failed: ${value.error ?? "unknown"}`
        : undefined,
  );
  if (result.canceled) return;
  if (shouldRestartHelperAfterCuaPermissionReturn(result)) {
    // 原因：Helper 重启失败时只能重试重启本身，重复打开系统设置会打断用户操作。
    await runWithOneRetry(
      dependencies,
      () =>
        dependencies.restartHelper({
          reason: "permission_granted",
          ...(result.sessionId ? { onboardingSessionId: result.sessionId } : {}),
        }),
      (value) => (value.ok ? undefined : `CUA Helper restart failed: ${value.reason ?? "unknown"}`),
    );
  }
  if (result.success && result.returnedFromSettings) {
    assertCuaPermissionPromptActive(dependencies);
    dependencies.refresh();
  }
}

export function CuaPermissionObservationAttachment() {
  const services = useServices();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { intl } = useZCodeIntl();

  useEffect(() => {
    const permissionService = services.cuaPermissionService;
    if (
      !permissionService ||
      !platform.openCuaPermissionOnboarding ||
      typeof services.zcodeAgentService.onDynamicCuaPermissionObservation !== "function"
    ) {
      return;
    }

    // 集合只在正常终态后写入，异常路径留空以便同一诉求再次进入
    // 容量上限用最旧淘汰控制内存，长期驻留页面也不会无界增长
    // 写入顺序应保持在释放待处理键之前，否则同一键存在瞬时重入窗口
    const handled = new Set<string>();
    const pending = new Set<string>();
    let chain = Promise.resolve();
    let activeOperationId: string | null = null;
    let disposed = false;
    const subscription = services.zcodeAgentService.onDynamicCuaPermissionObservation()(
      (observation) => {
        const missing = requiredCuaPermissionsForRequestAccessStatus(observation.permissionStatus);
        const key = cuaPermissionObservationKey(observation);
        if (disposed || missing.length === 0 || handled.has(key) || pending.has(key)) return;
        pending.add(key);

        chain = chain.then(async () => {
          if (disposed) return;
          try {
            await runCuaPermissionPrompt({
              getStatus: () =>
                permissionService.getStatus(
                  observation.workspacePath,
                  observation.workspaceIdentity,
                  { includeFunctionalProbes: false },
                ),
              confirm: () =>
                confirmDialog({
                  title: intl.formatMessage({ id: "cuaPermission.live.title" }),
                  description: intl.formatMessage({ id: "cuaPermission.live.description" }),
                  confirmLabel: intl.formatMessage({ id: "cuaPermission.live.confirm" }),
                  cancelLabel: intl.formatMessage({ id: "cuaPermission.live.cancel" }),
                }),
              openOnboarding: async (required) => {
                const operationId = createCuaPermissionOnboardingOperationId();
                activeOperationId = operationId;
                try {
                  return (
                    (await platform.openCuaPermissionOnboarding?.({
                      operationId,
                      initialPermission: required[0],
                      requiredPermissions: required,
                    })) ?? { success: false, error: "unavailable" }
                  );
                } finally {
                  if (activeOperationId === operationId) activeOperationId = null;
                }
              },
              restartHelper: (options) =>
                permissionService.restartHelper(
                  observation.workspacePath,
                  observation.workspaceIdentity,
                  options,
                ),
              refresh: () =>
                fetchCuaPermissionStatus({
                  service: permissionService,
                  workspacePath: observation.workspacePath,
                  workspaceIdentity: observation.workspaceIdentity,
                  options: { includeFunctionalProbes: false },
                }),
              isDisposed: () => disposed,
            });
            if (disposed) return;
            // 原因：只有正常终态（包括用户取消）才能去重；异常必须允许同一 observation 再次处理。
            handled.add(key);
            if (handled.size > 2_000) {
              const oldest = handled.values().next().value;
              if (typeof oldest === "string") handled.delete(oldest);
            }
          } catch (error: unknown) {
            if (!disposed) logger.warn("CUA 权限引导失败", { error });
          } finally {
            pending.delete(key);
          }
        });
      },
    );
    return () => {
      // 原因：先封闭生命周期边界，避免已排队任务在 subscription 释放后继续触发旧 workspace 副作用。
      // 卸载时先封闭生命周期，已排队的任务在下一个检查点直接返回
      // 随后释放订阅并撤销未完成的引导，顺序颠倒会留下悬挂的系统窗口
      // 清理过程不读取状态也不刷新缓存，避免卸载阶段触发新的服务请求
      disposed = true;
      subscription.dispose();
      if (activeOperationId) platform.cancelCuaPermissionOnboarding?.(activeOperationId);
    };
  }, [confirmDialog, intl, platform, services]);

  return null;
}
