// ============================================================================
// InlineEditableProviderCard —— 单个 Provider 的内联编辑卡片
//
// 职责边界：
//   维护名称/接口格式/Base URL/API Key 四类本地草稿，负责提交、幂等去重、
//   保存反馈、模型列表展示与拖拽顺序的 pending intent，以及卸载时的草稿兜底。
//   不负责 Provider 持久化、模型注册、连接测试实现与全局设置页面编排。
//
// 不变量（INV）：
//   INV-01 保存完成仅在 revision 未变时展示成功｜shouldApplyProviderSaveCompletion｜改错会把旧请求的成功提示贴到新草稿上
//   INV-02 删除进行中不得补保存草稿｜resolveProviderDraftCleanupAction 与 deleteRequestedRef｜改错会让已删除的 Provider 被 save 重新创建
//   INV-03 内部保存触发的卸载必须跳过 cleanup｜selfSaveRequestedRef 分支｜改错会覆盖刚提交的模型列表
//   INV-04 每次草稿修改必须递增 revision｜markDraftDirty｜改错会让过期保存覆盖用户新输入
//   INV-05 dirty 字段不得被外部刷新覆盖｜syncField 的 dirty 判断｜改错会把正在输入的 Key 回滚成旧值
//   INV-06 providerId 变化必须重置编辑态与 revision｜useEffect 的 providerIdRef 分支｜改错会把上一个 Provider 的名称草稿带过来
//   INV-07 名称提交必须声明 nameConfirmed｜commitPendingDraft 的 nameConfirmed 参数｜改错会把空名称当成有效标签提交
//   INV-08 Esc 之后发生的 blur 不得补发保存｜nameEditProviderIdRef 守卫｜改错会让取消操作变成提交
//   INV-09 IME 组合中的 Enter 不得触发提交｜resolveProviderNameEditKeyAction 与 isImeComposingKeyEvent｜改错会把拼音原始按键留在名称里
//   INV-10 同一草稿签名只提交一次｜lastSubmittedDraftSignatureRef｜改错会重复保存同一份草稿
//   INV-11 启用开关保存必须带上未提交的连接草稿｜handleProviderEnabledChange 的 draft 兜底｜改错会把刚输入的 Key 覆盖回旧值
//   INV-12 保存失败必须复位 selfSaveRequestedRef｜runSaveOperation 的 catch｜改错会让后续卸载永远跳过保存
//   INV-13 保存通知按 provider/model 去重 key｜runSaveOperation 的 dedupeKey｜改错会让多条提示互相覆盖
//   INV-14 draftOwnsRetry 时不得挂外部重试动作｜runSaveOperation 失败分支｜改错会让重试脱离当前编辑事务
//   INV-15 失败必须 rethrow｜runSaveOperation 的 catch 末尾｜改错会让调用方误判保存成功
//   INV-16 模型列表只保留拖拽排序这一份 pending intent｜useOptimisticReorder 与 projectModelsToOrder｜改错会让旧本地副本覆盖新 View
//   INV-17 模型提交必须携带 basedOnRevision｜handleModelCommit｜改错会覆盖并发编辑
//   INV-18 内置模型不得执行删除｜handleDeleteModel 的 builtin 分支｜改错会让用户删除系统模型
//   INV-19 未装配回调时必须显式抛错｜各 handle 的 guard｜改错会变成静默失败
//   INV-20 模型顺序投影必须保留未列出的模型｜projectModelsToOrder 的尾部拼接｜改错会让新增模型从列表消失
//   INV-21 卸载 effect 依赖必须稳定｜runSaveOperation 的空依赖数组｜改错会让 cleanup 触发循环保存
//   INV-22 本文件只新增注释，不改变任何运行时行为｜全文件｜违反即破坏注释工程只增不改约束
// ============================================================================
/* oxlint-disable eslint(max-lines) -- provider 卡片同时承载名称、连接、鉴权、模型和映射编辑；本阶段先维持单组件，后续再按表单域拆分。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getProviderFormApiKey,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
  type ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import {
  isApiKeyAccess,
  type ProviderApiType,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { resolvePendingProviderDraftSave, type ProviderDraftValues } from "./ProviderDraftSave.js";
import {
  ProviderApiKeySection,
  ProviderCardHeader,
  ProviderConnectionSection,
  ProviderModelsSection,
} from "./ProviderCardSections.js";
import { resolveModelProviderDisplayName } from "./constants.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";
import { MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS, useIdleTrigger } from "./useIdleTrigger.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";

export type ProviderNameEditKeyAction = "commit" | "cancel";
export type ProviderDraftCleanupAction = "commit" | "skip-delete";
interface ProviderSaveNotificationTarget {
  modelId?: string;
  operation?: "delete";
  /** 显式弹窗在原草稿中重试，不让外部通知另起一次脱离编辑事务的保存。 */
  draftOwnsRetry?: boolean;
}

export const PROVIDER_TEXT_INPUT_IDLE_SAVE_MS = MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS;

// [契约] 只有当前 revision 与发起保存时的 revision 相同，才允许展示成功/失败。
// 用户继续输入会递增 revision，旧请求的完成回调随即失效。
// 若改成总是展示，慢请求的成功提示会盖住新草稿的 pending 状态。
// 该函数是纯函数，便于单测覆盖，不要在里面读取 ref。
export function shouldApplyProviderSaveCompletion(
  currentRevision: number,
  completedRevision: number,
): boolean {
  return currentRevision === completedRevision;
}

export function resolveProviderDraftCleanupAction({
  deleteRequested,
}: {
  deleteRequested: boolean;
}): ProviderDraftCleanupAction {
  return deleteRequested ? "skip-delete" : "commit";
}

// [契约] 只把带 then 方法的对象视为 thenable，用于区分同步与异步删除。
// 删除回调的返回类型是 void 或 Promise，同步分支需要在同一次调用里复位守卫。
// 判错会让 Promise 被当成同步返回，守卫提前复位，卸载 cleanup 可能补保存已删除的 Provider。
function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// [事务] 删除开始前先置 deleteRequestedRef，结束时（含异步与异常）复位。
// 同步路径在 finally 语义里手动复位；异步路径用 finally 链复位。
// [失败路径] onDelete 抛错时先复位再重抛，不能把守卫永久留在删除态。
// 守卫存在的唯一目的：让卸载 cleanup 识别删除流程并跳过草稿保存。
// 若在删除前就保存草稿，删除完成后 Provider 会被重新创建。
export function runProviderDeleteWithDraftCleanupGuard({
  deleteRequestedRef,
  onDelete,
}: {
  deleteRequestedRef: { current: boolean };
  onDelete?: () => void | Promise<void>;
}) {
  if (!onDelete) {
    return;
  }

  deleteRequestedRef.current = true;
  try {
    const result = onDelete();
    if (isPromiseLike(result)) {
      void Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          deleteRequestedRef.current = false;
        });
      return;
    }
  } catch (error) {
    deleteRequestedRef.current = false;
    throw error;
  }

  deleteRequestedRef.current = false;
}

// [契约] 组合输入期间任何 Enter 都必须返回 null，交由输入法自行处理。
// 部分平台的 nativeEvent.isComposing 会提前变回 false，因此同时看本地 composition 状态。
// 漏判会让确认候选的 Enter 触发 blur，拼音原始按键被提交成名称。
// Escape 返回 cancel，与 Enter 的 commit 形成显式二态，其余按键不处理。
export function resolveProviderNameEditKeyAction(event: {
  key: string;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): ProviderNameEditKeyAction | null {
  // 中文输入法用 Enter 确认候选时仍处于 composition 阶段。
  // 部分平台的 keydown 标志会先恢复 false，因此同时读取本地 composition 状态，
  // 避免提前 blur 打断候选提交，导致拼音原始按键被留在名称里。
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  if (event.key === "Enter") {
    return "commit";
  }

  if (event.key === "Escape") {
    return "cancel";
  }

  return null;
}

// [契约] 交给编辑区的模型必须深拷贝，避免表单直接改到 Provider View 的对象。
// structuredClone 覆盖嵌套的 personalConfig 与 options，浅拷贝会留下共享引用。
// 该拷贝只发生在权威模型变化时，由 useMemo 缓存，不会每次输入都克隆。
function resolveVisibleProviderModelsForEdit(
  provider: ProviderSettingsFormProvider,
): ProviderSettingsFormModel[] {
  return provider.models.map((model) => structuredClone(model));
}

// [契约] 先按 modelIds 顺序投影，再把未列出的模型追加到尾部。
// 尾部拼接保证服务端新增的模型不会因为本地旧顺序而消失。
// 用 Map 建索引，复杂度与模型数线性相关，避免嵌套查找。
// 顺序来源只有拖拽 pending intent，不引入第二份本地模型副本。
// 重复 id 只会命中第一次，后续重复项被 Set 过滤掉。
function projectModelsToOrder(
  models: readonly ProviderSettingsFormModel[],
  modelIds: readonly string[],
): ProviderSettingsFormModel[] {
  const byId = new Map(models.map((model) => [model.modelId, model]));
  const ordered = modelIds.flatMap((modelId) => {
    const model = byId.get(modelId);
    return model ? [model] : [];
  });
  const orderedIds = new Set(ordered.map((model) => model.modelId));
  return [...ordered, ...models.filter((model) => !orderedIds.has(model.modelId))];
}

// [契约] 组件只接收数据与回调，不自行访问服务或 Store。
// 所有可写能力都是可选回调，缺失时对应入口应显式禁用或抛错。
// draftRevisionRef 与保存事务都在 InlineEditableProviderCard 内闭环，父层只接收 onSave 的持久化结果。
export function InlineEditableProviderCard({
  provider,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onTestModel,
  onReorderModelIds,
  readOnlyEndpoints,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  statusSection,
  nameEditable,
  headerVisible = true,
  headerActionsVisible,
  settingsRevision,
}: {
  provider: ProviderSettingsFormProvider;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormModel["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete?: () => void | Promise<void>;
  onTestModel?: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onReorderModelIds?: (modelIds: string[]) => Promise<void>;
  readOnlyEndpoints?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  statusSection?: ReactNode;
  nameEditable?: boolean;
  headerVisible?: boolean;
  headerActionsVisible?: boolean;
  settingsRevision?: number;
}) {
  const { intl } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  // [契约] editingName 只表达名称输入框是否处于编辑态，不承载草稿值。
  // 名称原文存在 nameValue 与 draftRef，编辑态切换不影响两者。
  // 切换 Provider 时由 effect 统一复位，事件回调不各自清理。
  // 不要用它推断是否已提交，提交语义由 nameEditProviderIdRef 决定。
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(getProviderFormLabel(provider));
  const [apiFormat, setApiFormat] = useState<ProviderApiType>(
    provider.config.api?.type ?? "anthropic-messages",
  );
  const [baseUrlValue, setBaseUrlValue] = useState(provider.config.api?.baseUrl ?? "");
  const [apiKeyValue, setApiKeyValue] = useState(getProviderFormApiKey(provider));
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  // [契约] 权威模型列表来自 Provider props，按 provider 引用缓存。
  // 缓存结果供顺序投影与提交基线使用，不能直接暴露给可写表单。
  // 拷贝发生在 useMemo 内，保证同一次渲染内多次读取得到同一引用。
  // 若把拷贝放到渲染体内的普通变量，每次渲染都会产生新对象，拖拽会抖动。
  const authoritativeModels = useMemo(
    () => resolveVisibleProviderModelsForEdit(provider),
    [provider],
  );
  const authoritativeModelIds = useMemo(
    () => authoritativeModels.map((model) => model.modelId),
    [authoritativeModels],
  );
  // [并发] 每次渲染同步刷新 ref，保证异步保存回调拿到最新的回调实现。
  // 直接捕获 props 会让拖拽保存使用上一次渲染的闭包，指向旧 Provider。
  // ref 只读写于本组件，不参与渲染输出，不会引发额外重渲染。
  const reorderModelIdsTargetRef = useRef(onReorderModelIds);
  reorderModelIdsTargetRef.current = onReorderModelIds;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const nameCompositionActiveRef = useRef(false);
  const nameEditProviderIdRef = useRef<string | null>(null);
  const technicalInputCompositionActiveRef = useRef(false);
  const deleteRequestedRef = useRef(false);
  const selfSaveRequestedRef = useRef(false);
  const providerIdRef = useRef(provider.providerId);
  const dirtyProviderFieldsRef = useRef(new Set<keyof ProviderDraftValues>());
  const draftRevisionRef = useRef(0);
  const lastSubmittedDraftSignatureRef = useRef<string | null>(null);
  const providerDisplayName = resolveModelProviderDisplayName(provider);
  const saveNotificationRef = useRef({
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  });
  saveNotificationRef.current = {
    providerId: provider.providerId,
    providerDisplayName,
    formatMessage: intl.formatMessage,
    dismissFeedback,
    showFeedback,
  };
  // [契约] draftRef 是提交时唯一可信的草稿源，state 只负责受控渲染。
  // 两者在同一事件里同步写入，避免异步保存读到落后一拍的 state。
  // 初始化值来自 Provider 当前配置，缺省字段在这里统一归一。
  // 不要在 render 中写 draftRef，只有事件回调与 effect 可以改它。
  const draftRef = useRef<ProviderDraftValues>({
    nameValue: getProviderFormLabel(provider),
    apiFormat: provider.config.api?.type ?? "anthropic-messages",
    baseUrlValue: provider.config.api?.baseUrl ?? "",
    apiKeyValue: getProviderFormApiKey(provider),
  });

  useEffect(() => {
    const resolvedApiFormat = provider.config.api?.type ?? "anthropic-messages";
    const resolvedBaseUrl = provider.config.api?.baseUrl ?? "";
    const resolvedApiKey = getProviderFormApiKey(provider);
    const resolvedLabel = getProviderFormLabel(provider);
    // [事务] 切换 Provider 时先重置编辑态、脏字段集合与已提交签名。
    // revision 递增让切换前发出的保存回调全部失效。
    // 不重置 dirty 集合会让新 Provider 的首个外部刷新被误判为用户输入。
    // 名称编辑身份清空，避免上一个卡片的 blur 回调落到新卡片。
    if (providerIdRef.current !== provider.providerId) {
      providerIdRef.current = provider.providerId;
      nameEditProviderIdRef.current = null;
      nameCompositionActiveRef.current = false;
      setEditingName(false);
      draftRevisionRef.current += 1;
      dirtyProviderFieldsRef.current.clear();
      lastSubmittedDraftSignatureRef.current = null;
    }
    // [权衡] 外部 Provider 刷新只同步未标记 dirty 的字段。
    // 字段被用户改过且值仍不同时直接跳过，保护正在输入的草稿。
    // 值相同则清掉 dirty 标记，让后续外部刷新重新接管该字段。
    // 四个字段共用同一套同步逻辑，新增字段必须同时接入这里。
    const syncField = <TKey extends keyof ProviderDraftValues>(
      key: TKey,
      value: ProviderDraftValues[TKey],
      apply: (next: ProviderDraftValues[TKey]) => void,
    ) => {
      // [并发] 用户改过且值仍不同的字段，外部刷新不得覆盖。
      // 值相同则继续走清标记流程，让外部刷新重新接管。
      // 该判断逐字段执行，四个字段互不影响。
      // 去掉这个守卫会让流式到达的 Provider 更新把正在输入的 Key 回滚。
      if (dirtyProviderFieldsRef.current.has(key) && draftRef.current[key] !== value) return;
      dirtyProviderFieldsRef.current.delete(key);
      draftRef.current[key] = value;
      apply(value);
    };
    syncField("nameValue", resolvedLabel, setNameValue);
    syncField("apiFormat", resolvedApiFormat, setApiFormat);
    syncField("baseUrlValue", resolvedBaseUrl, setBaseUrlValue);
    syncField("apiKeyValue", resolvedApiKey, setApiKeyValue);
  }, [provider]);

  // [契约] 任何用户输入都要标记 dirty、递增 revision 并清掉旧保存反馈。
  // selfSaveRequestedRef 置 false：用户继续编辑后，下一次卸载仍需保存。
  // 递增 revision 是让在途保存失效的唯一手段，不能只在保存前读一次。
  // 清反馈按 provider-save key，避免旧成功提示与新输入并存。
  const markDraftDirty = useCallback((field: keyof ProviderDraftValues) => {
    dirtyProviderFieldsRef.current.add(field);
    selfSaveRequestedRef.current = false;
    draftRevisionRef.current += 1;
    saveNotificationRef.current.dismissFeedback(`provider-save:${providerIdRef.current}`);
  }, []);

  const runSaveOperation = useCallback(
    async (operation: () => Promise<void>, target: ProviderSaveNotificationTarget = {}) => {
      // [事务] 保存开始即打上内部保存标记，供卸载 cleanup 识别。
      // 标记在保存成功、失败与 revision 过期三条路径上分别复位。
      // 若只在成功路径复位，失败后的真实卸载会跳过兜底保存。
      // 该标记不参与 revision 判断，两者职责不同。
      selfSaveRequestedRef.current = true;
      // [事务] 保存开始即占用一个新 revision，作为本次事务的版本号。
      // 完成时用该 revision 与当前值比较，判断期间是否有新编辑。
      // 不在保存结束时再递增，否则完成判断永远失配。
      const revision = draftRevisionRef.current + 1;
      draftRevisionRef.current = revision;
      const notification = saveNotificationRef.current;
      // [契约] 通知 key 按 Provider 或 Provider+Model 区分，不跨作用域复用。
      // 模型级保存与 Provider 级保存可能并发，共用 key 会互相覆盖。
      // key 由 providerId 而非展示名构成，重命名不会产生两条提示。
      const dedupeKey = target.modelId
        ? `model-save:${notification.providerId}:${target.modelId}`
        : `provider-save:${notification.providerId}`;
      const messageValues = {
        provider: notification.providerDisplayName,
        model: target.modelId ?? "",
      };
      const messageIds = target.modelId
        ? target.operation === "delete"
          ? {
              pending: "settings.modelProvider.modelDeleting",
              success: "settings.modelProvider.modelDeleteSuccess",
              failure: "settings.modelProvider.modelDeleteFailure",
            }
          : {
              pending: "settings.modelProvider.modelSaving",
              success: "settings.modelProvider.modelSaveSuccess",
              failure: "settings.modelProvider.modelSaveFailure",
            }
        : {
            pending: "settings.modelProvider.providerSaving",
            success: "settings.modelProvider.providerSaveSuccess",
            failure: "settings.modelProvider.providerSaveFailure",
          };
      notification.showFeedback({
        key: dedupeKey,
        message: notification.formatMessage(
          {
            id: messageIds.pending,
          },
          messageValues,
        ),
        state: "pending",
        durationMs: 0,
      });
      try {
        // [失败路径] operation 抛错时进入 catch，由后者展示失败反馈并 rethrow。
        // 这里不吞异常，保证调用方（卸载兜底、拖拽提交）能感知失败。
        // 成功分支还要再做一次 revision 校验，避免旧结果覆盖新状态。
        await operation();
        // [并发] revision 已推进说明期间有新的草稿修改，本次成功提示必须丢弃。
        // 静默 return 而不是展示成功，避免用户以为新输入已经保存。
        // shouldApplyProviderSaveCompletion 只决定是否弹成功提示，服务端的写入已经完成、不回滚。
        if (!shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision)) return;
        notification.showFeedback({
          key: dedupeKey,
          message: notification.formatMessage(
            {
              id: messageIds.success,
            },
            messageValues,
          ),
          state: "success",
        });
      } catch (error) {
        selfSaveRequestedRef.current = false;
        // [失败路径] 失败提示同样受 revision 约束，过期失败不得干扰新草稿。
        // 先复位 selfSaveRequestedRef，保证后续卸载仍会尝试保存。
        // 失败后必须 rethrow，调用方据此决定是否回滚乐观状态。
        // 重试动作仅在 draftOwnsRetry 为假时挂载，模型草稿由自身事务重试。
        if (shouldApplyProviderSaveCompletion(draftRevisionRef.current, revision)) {
          notification.showFeedback({
            key: dedupeKey,
            message: notification.formatMessage(
              {
                id: messageIds.failure,
              },
              {
                ...messageValues,
                error: error instanceof Error ? error.message : String(error),
              },
            ),
            state: "failure",
            durationMs: 8_000,
            ...(target.draftOwnsRetry
              ? {}
              : {
                  actionLabel: notification.formatMessage({ id: "common.retry" }),
                  onAction: () => {
                    void runSaveOperation(operation, target).catch(() => undefined);
                  },
                }),
            dismissible: true,
            dismissLabel: notification.formatMessage({ id: "common.close" }),
          });
        }
        throw error;
      }
    },
    // runSaveOperation 参与卸载保存 effect 的依赖链。intl/provider 随渲染换引用时，
    // 回调也换引用会先执行旧 effect cleanup，进而再次保存并形成循环；通知身份通过 ref 读取。
    [],
  );

  // [契约] 拖拽顺序提交包在 runSaveOperation 里，复用统一的反馈与 revision 语义。
  // 回调每次从 ref 读取，避免依赖 props 造成不必要的 useCallback 重建。
  // 复制 modelIds 后再传，防止调用方持有可变数组并在异步期间修改。
  // 未装配回调时抛错，让上层明确知道入口未接好。
  const persistModelOrder = useCallback(
    async (modelIds: readonly string[]) => {
      const target = reorderModelIdsTargetRef.current;
      if (!target) throw new Error("当前设置入口未装配 Model 调序能力");
      await runSaveOperation(async () => {
        await target([...modelIds]);
      });
    },
    [provider.providerId, runSaveOperation],
  );
  const optimisticModelOrder = useOptimisticReorder({
    authoritativeIds: authoritativeModelIds,
    persist: persistModelOrder,
  });

  // 成员与配置只有 Host View 一份事实。旧本地副本在异步成功/失败时会覆盖新 View，
  // 甚至短暂移除正在编辑的模型。只保留拖拽顺序这一份明确的 pending intent。
  // [权衡] 成员与配置只有 Host View 一份事实，本地只保留拖拽顺序这一份 pending intent。
  // 旧实现保存了本地模型副本，异步成功/失败时会覆盖新 View，甚至短暂移除正在编辑的模型。
  // 投影本身无副作用，只按 renderedIds 重排，不增删模型对象。
  // 依赖只包含权威模型与 renderedIds，避免每次渲染都重新投影。
  const models = useMemo(
    () => projectModelsToOrder(authoritativeModels, optimisticModelOrder.renderedIds),
    [authoritativeModels, optimisticModelOrder.renderedIds],
  );

  // [契约] Provider 保存统一走 runSaveOperation，失败时记录 warn 并触发 onFailure。
  // onFailure 用于复位幂等签名，让用户下次操作可以重新提交同一份草稿。
  // 错误必须 rethrow，否则调用方无法区分成功与失败。
  // 依赖包含 onSave 与 providerId，Provider 切换时重建回调。
  const saveProviderWithCleanupGuard = useCallback(
    async (nextProvider: ProviderSettingsFormProvider, onFailure?: () => void): Promise<void> => {
      const operation = async () => {
        await onSave(nextProvider);
      };
      await runSaveOperation(operation).catch((error) => {
        logger.warn("[ModelProviderSection] 自动保存 Provider 草稿失败", {
          providerId: provider.providerId,
          error,
        });
        onFailure?.();
        throw error;
      });
    },
    [onSave, provider.providerId, runSaveOperation],
  );

  const cancelIdleDraftSaveRef = useRef<() => void>(() => undefined);

  // [事务] 提交前先取消空闲定时器，避免同一草稿被空闲触发再次提交。
  // 解析结果为空表示无需保存（只读端点或没有有效变更），直接返回。
  // 签名比较在日志与保存之前，重复提交不会产生噪音日志。
  // 切换/卸载前的兜底提交依赖该函数，任何早退都必须保持无副作用。
  const commitPendingDraft = useCallback(
    async (reason: string, nameConfirmed = false): Promise<void> => {
      cancelIdleDraftSaveRef.current();
      const nextProvider = resolvePendingProviderDraftSave({
        provider,
        draft: draftRef.current,
        readOnlyEndpoints,
        nameConfirmed,
        now: Date.now,
      });
      if (!nextProvider) {
        return;
      }
      // [契约] 签名由四个草稿字段与名称确认标记共同决定。
      // 名称未确认时用当前 Provider 标签参与签名，避免把未确认输入当成已提交。
      // JSON 键顺序固定为草稿对象展开顺序，字段增删需同步评估签名稳定性。
      // 签名只用于进程内去重，不持久化，可安全包含明文草稿长度等元信息。
      const signature = JSON.stringify({
        ...draftRef.current,
        nameValue: nameConfirmed ? draftRef.current.nameValue : getProviderFormLabel(provider),
      });
      // [契约] 同一签名只提交一次，避免空闲触发与 blur 重复保存。
      // 签名变更说明用户又改了草稿，必须允许再次提交。
      // 去重发生在日志与保存之前，重复调用不产生副作用。
      // 失败路径会清空签名，让用户重试时仍可提交同一份草稿。
      if (lastSubmittedDraftSignatureRef.current === signature) return;
      lastSubmittedDraftSignatureRef.current = signature;

      // Linux 下点击左侧供应商切换时，输入框 blur 与 Popover 关闭顺序不稳定，
      // 连接草稿可能在组件卸载前还没走到 blur 保存。这里在切换/卸载前兜底提交，
      // 避免“新供应商接口地址一切走就恢复为空”。
      logger.info("[ModelProviderSection] 切换前保存未提交的供应商草稿", {
        providerId: provider.providerId,
        reason,
      });
      // [失败路径] 保存失败时，仅当签名仍是本次提交的签名才清空记录。
      // 若期间用户又改了草稿，签名已变化，不能误清新签名的记录。
      // 失败回调不吞错，外层 catch 继续记录日志并 rethrow。
      await saveProviderWithCleanupGuard(nextProvider, () => {
        if (lastSubmittedDraftSignatureRef.current === signature) {
          lastSubmittedDraftSignatureRef.current = null;
        }
      });
    },
    [provider, readOnlyEndpoints, saveProviderWithCleanupGuard],
  );

  // [资源] 空闲保存只服务 Base URL 与 API Key 两类文本输入。
  // 触发时忽略失败：用户在连续输入，错误提示会闪烁。
  // 定时器在卸载、提交与开关保存前统一取消，避免多次提交竞争。
  // 空闲保存与 blur 保存共用 commitPendingDraft，签名去重兜住重复。
  const idleDraftSave = useIdleTrigger(() => {
    void commitPendingDraft("idle").catch(() => undefined);
  });
  cancelIdleDraftSaveRef.current = idleDraftSave.cancel;
  const scheduleIdleDraftSave = idleDraftSave.schedule;
  const cancelIdleDraftSave = idleDraftSave.cancel;

  // [并发] savingEnabled 作为本地互斥，开关保存期间忽略重复点击。
  // 保存前取消空闲定时器，避免开关提交与空闲提交竞争同一草稿。
  // 失败时不做乐观回滚：权威 enabled 只来自 Provider View。
  // finally 复位 savingEnabled，异常路径同样解锁。
  const handleProviderEnabledChange = async (enabled: boolean) => {
    if (savingEnabled) return;
    cancelIdleDraftSave();
    setSavingEnabled(true);
    // 同一次保存带上尚未提交的连接草稿，避免开关保存把刚输入的 Key 覆盖回旧值。
    // [契约] 开关保存必须携带尚未提交的连接草稿，否则会把刚输入的 Key 覆盖回旧值。
    // 没有待提交草稿时回落到当前 Provider，保证 enabledUpdate 有完整载体。
    // 该兜底只读 draftRef，不修改它，空闲保存仍可独立触发。
    // 解析失败（只读端点）时同样回落，避免开关保存丢掉 enabled 变更。
    const draft =
      resolvePendingProviderDraftSave({
        provider,
        draft: draftRef.current,
        readOnlyEndpoints,
        now: Date.now,
      }) ?? provider;
    try {
      await saveProviderWithCleanupGuard({ ...draft, enabledUpdate: enabled });
    } catch {
      // 统一保存入口已记录错误及可重试反馈；不乐观覆盖权威 enabled。
    } finally {
      setSavingEnabled(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelIdleDraftSave();
      // [事务] 卸载 cleanup 先取消空闲定时器，再判定是否需要兜底保存。
      // 删除流程优先于保存：两者同时成立时必须跳过保存。
      // 内部保存触发的刷新同样跳过，避免用旧草稿覆盖刚提交的模型列表。
      // 其余情况才提交 cleanup 草稿，且忽略失败，卸载路径不能抛错。
      const cleanupAction = resolveProviderDraftCleanupAction({
        deleteRequested: deleteRequestedRef.current,
      });
      if (cleanupAction === "skip-delete") {
        // 确认删除会触发详情卡片卸载；如果 cleanup 继续补保存草稿，
        // 被删除的 provider 会在 delete 后又被 save 重新创建。
        logger.info("[ModelProviderSection] 删除中的供应商跳过 cleanup 草稿保存", {
          providerId: provider.providerId,
        });
        return;
      }
      // [契约] selfSaveRequestedRef 标记本次卸载由内部保存引发。
      // 读取后立即复位，避免影响下一次挂载。
      // 跳过保存只针对 cleanup，不影响用户主动触发的保存。
      // 若此处不复位，后续真实卸载会永远跳过兜底保存。
      if (selfSaveRequestedRef.current) {
        selfSaveRequestedRef.current = false;
        // 模型编辑会先保存新的有效模型列表，随后父层乐观更新会触发本组件 cleanup。
        // 此时如果再用旧草稿补保存，会覆盖刚提交的模型列表。
        logger.info("[ModelProviderSection] 内部保存触发的刷新跳过 cleanup 草稿保存", {
          providerId: provider.providerId,
        });
        return;
      }
      void commitPendingDraft("cleanup").catch(() => undefined);
    };
  }, [cancelIdleDraftSave, commitPendingDraft, provider.providerId]);

  // [契约] 名称输入同时写 draftRef 与 state，并标记 dirty。
  // 名称不走空闲保存，只能由 blur、Enter 或卸载兜底提交。
  // 标记 dirty 后，外部 Provider 刷新不会覆盖用户正在输入的名称。
  // 该回调不递增除 revision 之外的任何版本号，避免影响模型编辑。
  const handleNameValueChange = useCallback(
    (value: string) => {
      markDraftDirty("nameValue");
      draftRef.current.nameValue = value;
      setNameValue(value);
    },
    [markDraftDirty],
  );

  const handleBaseUrlValueChange = useCallback(
    (value: string) => {
      markDraftDirty("baseUrlValue");
      draftRef.current.baseUrlValue = value;
      setBaseUrlValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  const handleApiKeyValueChange = useCallback(
    (value: string) => {
      markDraftDirty("apiKeyValue");
      draftRef.current.apiKeyValue = value;
      setApiKeyValue(value);
      scheduleIdleDraftSave();
    },
    [markDraftDirty, scheduleIdleDraftSave],
  );

  // [契约] 只有仍处于名称编辑身份时才处理 blur，Esc/切换 Provider 后的 blur 必须忽略。
  // 处理前清空编辑身份，保证同一轮 blur 只触发一次。
  // 去空白后与当前标签比较，相同则回填并清除 dirty，不发起保存。
  // 不同才提交，且声明 nameConfirmed，让解析器接受新名称。
  const handleNameBlur = useCallback(() => {
    // Esc/切换供应商先取消编辑意图，随后发生的 blur 不得补发保存。
    // [并发] 编辑身份与 Provider 绑定，防止跨卡片 blur 误提交。
    // 该守卫必须放在最前面，任何副作用之前执行。
    // 身份为 null 表示 Esc 或已提交，直接返回。
    if (nameEditProviderIdRef.current !== provider.providerId) return;
    nameEditProviderIdRef.current = null;
    setEditingName(false);
    const trimmed = draftRef.current.nameValue.trim();
    const currentLabel = getProviderFormLabel(provider);
    if (trimmed && trimmed !== currentLabel) {
      void commitPendingDraft("name-blur", true).catch(() => undefined);
    } else {
      draftRef.current.nameValue = currentLabel;
      setNameValue(currentLabel);
      dirtyProviderFieldsRef.current.delete("nameValue");
    }
  }, [commitPendingDraft, provider]);

  const handleNameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = resolveProviderNameEditKeyAction({
        key: event.key,
        compositionActive: nameCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      });
      if (action === "commit") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      } else if (action === "cancel") {
        event.preventDefault();
        nameEditProviderIdRef.current = null;
        nameCompositionActiveRef.current = false;
        const label = getProviderFormLabel(provider);
        draftRef.current.nameValue = label;
        dirtyProviderFieldsRef.current.delete("nameValue");
        setNameValue(label);
        setEditingName(false);
      }
    },
    [provider],
  );

  const handleStartEditName = useCallback(() => {
    nameEditProviderIdRef.current = provider.providerId;
    nameCompositionActiveRef.current = false;
    setEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [provider.providerId]);

  const saveConnection = useCallback(
    () => void commitPendingDraft("connection-blur").catch(() => undefined),
    [commitPendingDraft],
  );

  // [事务] 切换接口格式立即提交，因为格式变化会让旧 Base URL 与 Key 语义失效。
  // 写入 draftRef 与 state 后再提交，保证提交读到新格式。
  // 失败时保留草稿，用户可继续修改后重试。
  // 该路径不走空闲定时器，格式切换必须即时生效。
  const handleApiFormatChange = useCallback(
    (value: ProviderApiType) => {
      markDraftDirty("apiFormat");
      draftRef.current.apiFormat = value;
      setApiFormat(value);
      void commitPendingDraft("api-format-change").catch(() => undefined);
    },
    [commitPendingDraft, markDraftDirty],
  );

  const handleApiKeyBlur = useCallback(() => {
    void commitPendingDraft("api-key-blur").catch(() => undefined);
  }, [commitPendingDraft]);

  // [契约] 技术输入框只把非组合态的 Enter 当作提交，其余按键放行。
  // 组合态判定同时看本地 ref 与 nativeEvent，覆盖 Electron/macOS 的时序差异。
  // 提交方式是 blur，复用统一的 blur 保存链路，不另开保存入口。
  // 若直接调用保存，会绕过名称/连接各自的确认语义。
  const handleTextCommitKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    // 候选确认的 Enter 不能被当作表单提交。本地 ref 覆盖
    // Electron/macOS 上 nativeEvent.isComposing 过早变回 false 的时序。
    if (
      isImeComposingKeyEvent({
        compositionActive: technicalInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    // [失败路径] 主动 blur 会触发表单的 blur 保存；这是设计内的提交方式。
    // 不要改成 preventDefault 后直接保存，否则会跳过输入法结束事件。
    // blur 失败（元素已卸载）时无副作用，保存仍由卸载兜底接管。
    event.currentTarget.blur();
  }, []);
  const handleTechnicalInputCompositionStart = useCallback(() => {
    technicalInputCompositionActiveRef.current = true;
  }, []);
  const handleTechnicalInputCompositionEnd = useCallback(() => {
    technicalInputCompositionActiveRef.current = false;
  }, []);

  // [事务] 连接测试前必须先 flush 本卡片唯一的 Provider 草稿。
  // 测试使用正式 providerId/modelId，草稿未落库会测到旧连接参数。
  // 不做额外的模型快照重存：那会绕过模型草稿的 revision 边界。
  // 未装配 onTestModel 时返回失败结构，不抛错，保持 UI 可继续操作。
  const handleTestModel = useCallback(
    async (model: string): Promise<ModelConnectivityResult> => {
      if (!onTestModel) {
        return Promise.resolve({
          success: false,
          error: { message: "Model connectivity test is unavailable" },
        });
      }

      // 连接测试曾把 Renderer 模型快照交给外层重新保存，绕过了模型草稿的
      // revision 边界。现在只 flush 本卡片唯一的 Provider 草稿；Service 会等待同一 Provider
      // 操作队列和 Registry 刷新完成，再按正式 providerId/modelId 创建 Model。
      await commitPendingDraft("connectivity-test");
      // [契约] 草稿 flush 完成后才发起连接测试，保证测试对象与界面一致。
      // Service 内部等待同一 Provider 的操作队列与 Registry 刷新。
      // 返回结果原样透传，不在卡片内改写成功/失败结构。
      return onTestModel(provider.providerId, model);
    },
    [commitPendingDraft, onTestModel, provider.providerId],
  );

  // [事务] 模型编辑以 basedOnRevision 作为并发基线，提交的是增量草稿而非整表。
  // handleModelCommit 先按 originalModelId 定位原模型，找不到就直接抛错以免写出半张表。
  // 新列表先本地比对，完全一致时直接返回，不产生无意义写入。
  // 个人配置深拷贝后再提交，避免 UI 后续修改影响在途请求。
  const handleModelCommit = useCallback(
    async (
      originalModelId: string,
      nextModel: ProviderSettingsFormModel,
      basedOnRevision: number,
    ): Promise<void> => {
      const trimmed = nextModel.modelId.trim();
      const index = models.findIndex((model) => model.modelId === originalModelId);
      const currentModel = models[index];
      // [失败路径] 任一前置条件不满足都抛错，让上层明确感知入口或输入非法。
      // 不静默 return，否则用户会以为改名已生效。
      // 错误文案固定，便于调用方与测试断言。
      if (!currentModel || !trimmed || !onSavePersonalModelDraft) {
        throw new Error("当前设置入口未装配原子 Model Draft 保存能力");
      }
      // [契约] 用副本替换目标项，不修改 models 数组或模型对象。
      // modelId 去空白后写入，hasPersonalConfig 强制为真表示已落到个人配置。
      // 副本只用于本地差异比较，服务端事实仍以提交结果为准。
      const next = [...models];
      next[index] = { ...nextModel, modelId: trimmed, hasPersonalConfig: true };
      // [权衡] 结构化比较用于跳过无变化提交；模型对象字段顺序由同一构造路径保证。
      // 若模型含函数或循环引用，此处会失效，当前模型结构为纯数据。
      // 比较失败（误判不等）只会多一次提交，不会丢数据。
      if (JSON.stringify(next) === JSON.stringify(models)) {
        return;
      }
      await runSaveOperation(
        async () => {
          await onSavePersonalModelDraft({
            providerId: provider.providerId,
            originalModelId: currentModel.modelId,
            nextModelId: trimmed,
            personalConfig: structuredClone(nextModel.personalConfig),
            ...(nextModel.useRecommendedConfig === undefined
              ? {}
              : { useRecommendedConfig: nextModel.useRecommendedConfig }),
            basedOnRevision,
          });
        },
        { modelId: trimmed, draftOwnsRetry: true },
      );
    },
    [models, onSavePersonalModelDraft, provider.providerId, runSaveOperation],
  );

  // [事务] 删除个人模型走 runSaveOperation，复用 pending/成功/失败反馈。
  // handleDeleteModel 的删除分支只处理个人模型，builtin 的模型一律不进 runSaveOperation。
  // 删除失败时记录 warn，但不再向用户弹二次错误，统一入口已提示。
  // 删除结果不乐观移除本地模型，等待 Provider View 刷新。
  const handleDeleteModel = useCallback(
    (modelId: string) => {
      const index = models.findIndex((model) => model.modelId === modelId);
      const model = models[index];
      if (!model) {
        return;
      }
      // [契约] model.builtin 为真时直接跳过，内置模型属于产品能力不能由用户删除。
      // 该判断必须在调用服务前完成，不能依赖服务端拒绝。
      // 模型不存在时上一个分支已返回，这里无需再判空。
      // 删除携带 operation=delete，用于选择失败文案与反馈类型。
      if (!model.builtin) {
        void runSaveOperation(
          async () => {
            if (!onDeletePersonalModel)
              throw new Error("当前设置入口未装配 Personal Model 删除能力");
            await onDeletePersonalModel(provider.providerId, model.modelId);
          },
          { modelId: model.modelId, operation: "delete" },
        ).catch((error) => {
          logger.warn("[ModelProviderSection] 删除 Personal Model 失败", {
            providerId: provider.providerId,
            modelId: model.modelId,
            error,
          });
        });
        return;
      }
    },
    [models, onDeletePersonalModel, provider.providerId, runSaveOperation],
  );

  const handleModelEnabledChange = useCallback(
    async (modelId: string, enabled: boolean) => {
      if (!onSetPersonalModelEnabled) throw new Error("当前设置入口未装配 Model 启停能力");
      await runSaveOperation(
        () =>
          onSetPersonalModelEnabled(provider.providerId, modelId, enabled).then(() => undefined),
        { modelId },
      );
    },
    [onSetPersonalModelEnabled, provider.providerId, runSaveOperation],
  );

  // [事务] 新增模型先归一 modelId，空 id 直接返回，不产生请求。
  // 个人配置深拷贝后提交，避免表单卸载后对象被复用修改。
  // useRecommendedConfig 仅在显式定义时透传，undefined 表示交给服务端默认。
  // 新增与编辑共用 runSaveOperation，反馈 key 按 modelId 区分。
  const handleAddModel = useCallback(
    async (model: ProviderSettingsFormModel) => {
      if (!onAddPersonalModel) throw new Error("当前设置入口未装配 Personal Model 添加能力");
      const added = { ...model, modelId: model.modelId.trim(), hasPersonalConfig: true };
      if (!added.modelId) return;
      await runSaveOperation(
        async () => {
          await onAddPersonalModel(
            provider.providerId,
            added.modelId,
            structuredClone(added.personalConfig),
            added.useRecommendedConfig,
          );
        },
        { modelId: added.modelId, draftOwnsRetry: true },
      );
    },
    [onAddPersonalModel, provider.providerId, runSaveOperation],
  );

  // [契约] 拖拽顺序交给 useOptimisticReorder 提交，卡片不维护第二份顺序。
  // 未装配 onReorderModelIds 时直接返回，不产生本地假顺序。
  // 提交失败记录 warn，乐观顺序由 hook 自行回滚。
  // 该回调不参与草稿保存，顺序与四类草稿字段相互独立。
  const handleReorderModelIds = useCallback(
    (modelIds: string[]) => {
      if (!onReorderModelIds) return;
      void optimisticModelOrder.commit(modelIds).catch((error) => {
        logger.warn("[ModelProviderSection] 保存 Personal Model 顺序失败", {
          providerId: provider.providerId,
          error,
        });
      });
    },
    [onReorderModelIds, optimisticModelOrder, provider.providerId],
  );

  // [事务] 删除 Provider 必须先建立删除守卫，再调用外部删除。
  // 守卫覆盖同步与异步删除，保证卸载 cleanup 能识别删除流程。
  // 该回调不直接清理草稿：删除流程本身会销毁 Provider。
  const handleDeleteProvider = useCallback(() => {
    runProviderDeleteWithDraftCleanupGuard({
      deleteRequestedRef,
      onDelete,
    });
  }, [onDelete]);

  const headerProviderName = providerDisplayName;
  const isAccountProvider = provider.config.access?.type === "zhipu-account";
  const isApiKeyProvider = isApiKeyAccess(provider.config.access);
  // [契约] 外部提供 statusSection 时隐藏内置标题栏，避免出现两个标题。
  // headerVisible 只控制是否展示，不改变编辑态与草稿逻辑。
  // 该计算在渲染前完成，JSX 中不再重复判断。
  const effectiveHeaderVisible = headerVisible && statusSection === undefined;

  return (
    <div className="space-y-3">
      {effectiveHeaderVisible ? (
        <ProviderCardHeader
          providerName={headerProviderName}
          logo={provider.config.logo}
          editingName={editingName}
          nameValue={nameValue}
          nameInputRef={nameInputRef}
          nameEditable={nameEditable}
          onNameChange={handleNameValueChange}
          onNameBlur={handleNameBlur}
          onNameKeyDown={handleNameKeyDown}
          onNameCompositionStart={() => {
            nameCompositionActiveRef.current = true;
          }}
          onNameCompositionEnd={() => {
            nameCompositionActiveRef.current = false;
          }}
          onStartEditName={handleStartEditName}
          onDelete={onDelete ? handleDeleteProvider : undefined}
          actionsVisible={headerActionsVisible}
          providerToggle={
            isAccountProvider ? undefined : (
              <ControlHintTooltip
                standalone
                title={intl.formatMessage({
                  id: provider.enabled
                    ? "settings.modelProvider.disableProvider"
                    : "settings.modelProvider.enableProvider",
                })}
              >
                {/* Tooltip 的 data-state 不能覆盖 Switch 的 checked 状态，否则轨道样式会消失。 */}
                <span className="inline-flex">
                  <Switch
                    // 共享开关左右各扩展 12px，会覆盖相邻菜单；本标题栏仅保留 4px 横向热区。
                    className="after:-inset-x-1"
                    data-testid="model-provider-enabled-switch"
                    aria-label={intl.formatMessage({
                      id: provider.enabled
                        ? "settings.modelProvider.disableProvider"
                        : "settings.modelProvider.enableProvider",
                    })}
                    checked={provider.enabled}
                    disabled={savingEnabled}
                    onCheckedChange={(enabled) => {
                      void handleProviderEnabledChange(enabled);
                    }}
                  />
                </span>
              </ControlHintTooltip>
            )
          }
        />
      ) : null}

      {statusSection}

      <div className="space-y-3">
        {isAccountProvider ? null : (
          <ProviderConnectionSection
            provider={provider}
            readOnly={readOnlyEndpoints}
            apiFormat={apiFormat}
            baseUrlValue={baseUrlValue}
            onApiFormatChange={handleApiFormatChange}
            onBaseUrlChange={handleBaseUrlValueChange}
            onBaseUrlBlur={saveConnection}
            onBaseUrlKeyDown={handleTextCommitKeyDown}
            onBaseUrlCompositionStart={handleTechnicalInputCompositionStart}
            onBaseUrlCompositionEnd={handleTechnicalInputCompositionEnd}
          />
        )}

        {isApiKeyProvider ? (
          <ProviderApiKeySection
            apiKeyValue={apiKeyValue}
            apiKeyVisible={apiKeyVisible}
            presetApiKeyUrl={presetApiKeyUrl}
            onOpenPresetApiKey={onOpenPresetApiKey}
            onApiKeyChange={handleApiKeyValueChange}
            onApiKeyBlur={handleApiKeyBlur}
            onApiKeyKeyDown={handleTextCommitKeyDown}
            onApiKeyCompositionStart={handleTechnicalInputCompositionStart}
            onApiKeyCompositionEnd={handleTechnicalInputCompositionEnd}
            onToggleApiKeyVisibility={() => setApiKeyVisible((value) => !value)}
          />
        ) : null}

        <ProviderModelsSection
          // 不同 Provider 可以有同名模型；不能复用上一供应商的打开中草稿和版本。
          key={provider.providerId}
          providerId={provider.providerId}
          providerName={getProviderFormLabel(provider)}
          providerEnabled={provider.enabled}
          providerAccess={provider.config.access}
          models={models}
          onTestModel={onTestModel ? handleTestModel : undefined}
          onModelCommit={handleModelCommit}
          onModelEnabledChange={handleModelEnabledChange}
          onDeleteModel={handleDeleteModel}
          onAddModel={handleAddModel}
          onReorderModelIds={onReorderModelIds ? handleReorderModelIds : undefined}
          settingsRevision={settingsRevision ?? 0}
        />
      </div>
    </div>
  );
}
