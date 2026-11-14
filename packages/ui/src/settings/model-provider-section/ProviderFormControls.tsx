// ProviderFormControls.tsx —— 供应商设置页里单个模型行的展示与就地编辑组件。
// 职责：展示模型 ID、上下文窗口徽标与视觉能力徽标，承载元数据编辑弹窗、连通性测试、删除和启用开关。
// 边界：不持有模型列表事实、不做持久化、不实现探测；所有写操作都通过 props 回调上抛给父层。
//
// 不变量（改动派生状态或交互顺序前逐条核对）：
// INV-01 断言：editingModel 只在打开弹窗时取最新 model，弹窗打开期间不跟随外部投影刷新 —— 守住它的位置：openMetadataDialog 与 setEditingModel —— 改错故障：后台刷新替换正在编辑的草稿，输入内容回退或丢失。
// INV-02 断言：提交用打开时快照的 draftBasedOnRevision 作为并发基线 —— 守住它的位置：openMetadataDialog 的 setDraftBasedOnRevision 与 commitDraft 调用 —— 改错故障：并发写入互相覆盖，用户改动被静默丢弃。
// INV-03 断言：metadataSavingRef 为真时开关弹窗与再次提交都必须直接返回 —— 守住它的位置：handleMetadataDialogOpenChange 与 handleMetadataDialogCommit 入口 —— 改错故障：旧保存回包关闭新一轮编辑，弹窗闪退或草稿错位。
// INV-04 断言：保存期间不得执行 cancelMetadataDialog 的 reset —— 守住它的位置：handleMetadataDialogOpenChange 的 saving 提前返回 —— 改错故障：Esc 或点遮罩清空已提交草稿，界面回显旧值。
// INV-05 断言：metadataSavingRef 与 metadataSaving 必须成对置位、复位放在 finally —— 守住它的位置：handleMetadataDialogCommit 的 try/finally —— 改错故障：抛错后保存按钮永久禁用，用户再也无法提交。
// INV-06 断言：reset 草稿与清空两类错误必须同批执行 —— 守住它的位置：openMetadataDialog 与 cancelMetadataDialog —— 改错故障：上一轮红色错误文案残留到下一次编辑。
// INV-07 断言：commitDraft 结果为 invalid 时只回填字段，不调用 onCommit —— 守住它的位置：commitDraft 的 invalid 分支 —— 改错故障：非法模型 ID 或窗口值被持久化，父层拿到脏数据。
// INV-08 断言：测试用的 modelId 在 await 之前从草稿取定，之后不再重读 —— 守住它的位置：handleTest 开头的 const modelId —— 改错故障：请求期间用户改名，成功或失败提示张冠李戴。
// INV-09 断言：isTesting 为真时重复点击必须在入口丢弃 —— 守住它的位置：handleTest 的提前返回 —— 改错故障：并发探测产生多条反馈，后到结果覆盖先到结果。
// INV-10 断言：providerEnabled 为假时测试按钮禁用且 handleTest 直接返回 —— 守住它的位置：testDisabled 与 handleTest 守卫 —— 改错故障：对已禁用供应商发请求，界面提示莫名失败。
// INV-11 断言：反馈去重键必须同时含 providerId 与 modelId —— 守住它的位置：handleTest 的 dedupeKey 拼接 —— 改错故障：不同模型共用一条 pending 提示，测试状态互相顶掉。
// INV-12 断言：testDisabled 还要求模型 ID trim 后非空 —— 守住它的位置：testDisabled 计算 —— 改错故障：空模型名发起探测，用户只看到难懂的后端错误。
// INV-13 断言：失败原因优先按 error.code 本地化，最后才回落 error.message —— 守住它的位置：handleTest 的 localizedReason 三元 —— 改错故障：界面泄漏后端英文噪声或出现空文案。
// INV-14 断言：测试与删除按钮的 onMouseDown 必须 preventDefault —— 守住它的位置：两处 onMouseDown 回调 —— 改错故障：blur 先触发保存并刷新父层，click 丢失，按钮看似无响应。
// INV-15 断言：restore 与 flush 返回的 Promise 必须被 catch —— 守住它的位置：onRestore 与 onModelIdBlur —— 改错故障：出现未处理的 Promise 拒绝，错误也不展示给用户。
// INV-16 断言：pending 反馈驻留 0 毫秒、失败反馈 8 秒且可关闭 —— 守住它的位置：handleTest 三处 showFeedback —— 改错故障：失败提示秒消失或永久驻留。
// INV-17 断言：行内上下文窗口徽标取已提交配置而非草稿 —— 守住它的位置：contextWindowLabel 计算 —— 改错故障：徽标显示未提交的临时值，与列表其他行不一致。
//
// 并发与资源：
// 同一行内的测试、保存、恢复三类异步共享一个组件实例，入口互斥只依赖 ref 与 state，不引入额外锁。
// 弹窗关闭统一走 onOpenChange 到 cancelMetadataDialog，保证草稿、错误字段、保存中标志一次性归零。
// 本组件无定时器、无订阅、无 DOM 监听，不需要清理函数；不要在渲染期加入需要释放的资源。
//
// 交互踩坑：
// 输入框聚焦时点删除会先触发 blur 保存，父层重渲染后原按钮 click 丢失，所以用 onMouseDown 阻止默认行为保住这次点击。
import { useCallback, useRef, useState } from "react";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { Loader2Icon, Trash2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
import type { ModelConfigResolution, ProviderConfigObject } from "@zcode/provider";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";
import { useProviderDetailFeedback } from "@/settings/model-provider-section/ProviderDetailFeedback.js";

// 单个模型行是纯受控视图：模型数据、开关状态与所有写操作都来自 props，组件内部不复制业务事实。
// providerName 缺省回落到 providerId、providerEnabled 缺省为真，是为了让父子层只传必填项也能正确渲染提示文案。
// onTest 为可选：不传时整枚测试按钮不渲染，避免出现点了没反应的死按钮。
export function ModelRowInput({
  model,
  providerId,
  providerName = providerId,
  providerEnabled = true,
  providerAccess,
  inputTestId,
  deleteTestId,
  onCommit,
  onResolveDraft,
  settingsRevision = 0,
  onDelete,
  onEnabledChange,
  onTest,
}: {
  model: ProviderSettingsFormModel;
  providerId: string;
  providerName?: string;
  providerEnabled?: boolean;
  providerAccess?: ProviderConfigObject["access"];
  inputTestId?: string;
  deleteTestId?: string;
  onCommit: (model: ProviderSettingsFormModel, basedOnRevision: number) => void | Promise<void>;
  onResolveDraft?: (
    nextModelId: string,
    personalConfig: ProviderSettingsFormModel["personalConfig"],
  ) => Promise<ModelConfigResolution>;
  settingsRevision?: number;
  onDelete?: () => void;
  onEnabledChange?: (enabled: boolean) => void;
  onTest?: (model: string) => Promise<ModelConnectivityResult>;
}) {
  // 所有用户可见文案都走 intl 格式化，禁止拼中文硬编码，否则切语言后这里会残留原文。
  // locale 只用于上下文窗口数字的本地化格式，不参与任何业务判断。
  // feedback 句柄来自详情页共享 Provider，同一行内多次提示靠它做去重与替换。
  const { intl, locale } = useZCodeIntl();
  const { showFeedback } = useProviderDetailFeedback();
  // `isTesting` 只表达本行探测在途，不上抛父层；跨行并发由各行实例独立承担。
  // 它与 metadataSaving 分开管理：测试期间仍允许编辑草稿，两者互不阻塞。
  // 弹窗打开状态、保存状态、错误字段都是行内局部状态，父层重渲染不会保留，这是有意的。
  const [isTesting, setIsTesting] = useState(false);
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const metadataSavingRef = useRef(false);
  const [commitErrorMessage, setCommitErrorMessage] = useState<string | null>(null);
  // 基线初值跟随 settingsRevision，但弹窗打开时会被重新快照，外部 revision 变化不影响已打开的编辑事务。
  // 提交时把它原样传给 onCommit 的 basedOnRevision，由父层判断是否发生并发冲突。
  // 不要在 commitDraft 里改读最新的 settingsRevision：那样会掩盖冲突，让覆盖写看起来像成功。
  // 关闭弹窗不重置该值，因为下次打开会重新赋值，提前重置只会制造无意义的状态抖动。
  const [draftBasedOnRevision, setDraftBasedOnRevision] = useState(settingsRevision);
  // 外部 View 每次投影会产生新对象；编辑事务固定打开时的模型与 revision，不能跟随对象刷新重置。
  const [editingModel, setEditingModel] = useState(model);
  // 草稿生命周期交给 useProviderModelDraft 统一管理，组件只负责触发 change、commit、reset、restore、flush。
  // model 传的是 editingModel 而不是 props.model：打开期间草稿基线必须冻结，否则外部投影会重置用户输入。
  // open 与 metadataDialogOpen 绑定，草稿只在弹窗存续期间有效。
  // scopeKey 用 providerId 区分供应商作用域，换供应商时草稿缓存不会串味。
  const editor = useProviderModelDraft({
    model: editingModel,
    open: metadataDialogOpen,
    scopeKey: providerId,
    resolve: onResolveDraft,
  });
  const { draft } = editor;
  const [draftErrorField, setDraftErrorField] = useState<
    | "id"
    | "contextWindow"
    | "maxOutputTokens"
    | "inputFormat"
    | "reasoningLevelValues"
    | "reasoningLevelMap"
    | null
  >(null);

  // 任何字段变更都立即清空 draftErrorField，让上一次的红色提示不跟着新输入继续显示。
  // 这里只做透传，不在组件层校验：校验归属 useProviderModelDraft，避免两份规则漂移。
  // 不要在 change 之后再手动写草稿，草稿唯一所有权在 hook。
  const updateDraft = (patch: Parameters<typeof editor.change>[0]) => {
    editor.change(patch);
    setDraftErrorField(null);
  };
  // 返回布尔值而不是抛错，让调用方区分校验失败与提交异常。
  // invalid 分支只记录出错字段并返回 false，绝不调用 onCommit，防止非法值进入持久化链路。
  // onCommit 完成后才返回 true：父层保存失败会以异常形式冒泡到 handleMetadataDialogCommit 的 catch。
  // 成功后只保证错误字段已清空，关闭动作由调用方决定。
  const commitDraft = async (): Promise<boolean> => {
    const result = await editor.commit();
    if (result.status === "invalid") {
      setDraftErrorField(result.field);
      return false;
    }
    setDraftErrorField(null);
    await onCommit(result.model, draftBasedOnRevision);
    return true;
  };

  // 取消即丢弃：reset 回传给打开时的 model，草稿的所有未提交修改都不可恢复。
  // 依赖数组只含 model 是有意的：reset 需要最新外部模型作为回退基线。
  // 三类状态一起清空后最后关弹窗，避免关闭动画期间仍显示旧错误。
  const cancelMetadataDialog = useCallback(() => {
    editor.reset(model);
    setDraftErrorField(null);
    setCommitErrorMessage(null);
    setMetadataDialogOpen(false);
  }, [model]);

  // 先固定 editingModel，再 reset 草稿，顺序不能反：reset 依赖刚写入的编辑基线。
  // 同时把 settingsRevision 快照进 draftBasedOnRevision，形成本次编辑事务的并发基线。
  // 打开前清空两类错误，避免上一次失败文案带进新一次编辑。
  // 依赖 model 与 settingsRevision：任一变化都会换出新的打开函数，保证快照总是最新。
  const openMetadataDialog = useCallback(() => {
    setEditingModel(model);
    editor.reset(model);
    setDraftErrorField(null);
    setCommitErrorMessage(null);
    setDraftBasedOnRevision(settingsRevision);
    setMetadataDialogOpen(true);
  }, [model, settingsRevision]);

  // [并发] 保存中直接忽略开关请求，包括 Esc 与点遮罩，这是防止回包关闭新一轮编辑的唯一闸门。
  // 关闭分支只走 cancelMetadataDialog，不允许在这里各写一份清理逻辑。
  // 打开分支走 openMetadataDialog，保证两条路径都经过同一套快照与清错流程。
  // 不要在这里加异步清理：`handleMetadataDialogOpenChange` 必须同步决定开关。
  const handleMetadataDialogOpenChange = useCallback(
    (open: boolean) => {
      // 保存期间 Esc/遮罩不能结束并重开草稿，否则旧保存回包会关闭新一轮编辑。
      if (metadataSavingRef.current) return;
      if (!open) {
        cancelMetadataDialog();
        return;
      }
      openMetadataDialog();
    },
    [cancelMetadataDialog, openMetadataDialog],
  );

  // [事务] ref 负责同步互斥，state 负责驱动按钮态，两者必须一起置位，只改一个会留下竞态窗口。
  // commitDraft 返回 false 时立即退出，finally 仍会把保存标志复位，弹窗保持打开供用户修正。
  // 此处把异常转成可读文案塞进 commitErrorMessage，异常不再向上抛，避免未处理拒绝。
  // finally 复位 ref 与 state 后才算本次保存结束，提前返回也不影响复位。
  const handleMetadataDialogCommit = useCallback(async (): Promise<boolean> => {
    if (metadataSavingRef.current) return false;
    metadataSavingRef.current = true;
    setMetadataSaving(true);
    setCommitErrorMessage(null);
    try {
      if (!(await commitDraft())) return false;
      setMetadataDialogOpen(false);
      return true;
    } catch (error) {
      setCommitErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      metadataSavingRef.current = false;
      setMetadataSaving(false);
    }
  }, [commitDraft]);

  // 三重守卫：没有探测回调、已有在途请求、供应商被禁用，任一命中都静默返回。
  // 静默而不是报错：按钮本身已禁用，再弹错误只会让用户困惑。
  // 守卫放在最前面，确保不会为一次被丢弃的点击创建 feedback。
  const handleTest = useCallback(async () => {
    if (!onTest || isTesting || !providerEnabled) {
      return;
    }

    // 先 trim 再取定：探测按最终模型 ID 发请求，前后空格不应进入上报或提示文案。
    // 在 await 之前快照，后续异步回调一律引用这个常量，不再读草稿。
    // dedupeKey 由供应商与模型共同构成，同名模型在不同供应商下不会互相顶掉提示。
    // [并发] 去重键让同一模型的 pending 被新一轮结果原位替换，而不是叠加多条。
    const modelId = draft.idValue.trim();
    const dedupeKey = `model-test:${providerId}:${modelId}`;
    showFeedback({
      key: dedupeKey,
      message: intl.formatMessage(
        { id: "settings.modelProvider.testModel.connectingWithIdentity" },
        { provider: providerName, model: modelId },
      ),
      state: "pending",
      durationMs: 0,
    });
    setIsTesting(true);
    // [失败路径] try 覆盖探测调用与结果分支，任何抛错都落到下面的 catch，不会让 isTesting 卡住。
    // 成功分支只给成功态反馈并允许关闭；失败分支带 8 秒驻留，给用户时间读原因。
    // 注意 result.success 为假不是异常，走 else 的本地化分支而不是 catch。
    try {
      const result = await onTest(modelId);
      if (result.success) {
        showFeedback({
          key: dedupeKey,
          message: intl.formatMessage(
            { id: "settings.modelProvider.testModel.successWithIdentity" },
            { provider: providerName, model: modelId },
          ),
          state: "success",
          successEmphasis: true,
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
        });
      } else {
        const localizedReason =
          result.error.code === "provider-unavailable"
            ? intl.formatMessage({ id: "settings.modelProvider.testModel.providerUnavailable" })
            : result.error.code === "model-unavailable"
              ? intl.formatMessage({ id: "settings.modelProvider.testModel.modelUnavailable" })
              : result.error.message.trim();
        const reason =
          localizedReason || intl.formatMessage({ id: "settings.modelProvider.testModel.failed" });
        showFeedback({
          key: dedupeKey,
          message: intl.formatMessage(
            { id: "settings.modelProvider.testModel.failedWithIdentity" },
            { provider: providerName, model: modelId, reason },
          ),
          state: "failure",
          durationMs: 8_000,
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
        });
      }
    // [失败路径] 探测抛错时仍复用同一个 dedupeKey，保证 pending 提示被原位替换为失败态。
    // 错误对象可能是任意类型，只有 Error 才取 message，其余回落到通用失败文案。
    // 这里必须再格式化一次完整句子：catch 分支不共享 else 分支已经算好的 reason。
    // 不要把 catch 改成只记日志：用户看不到任何失败原因，会以为按钮没生效。
    } catch (error) {
      showFeedback({
        key: dedupeKey,
        message: intl.formatMessage(
          { id: "settings.modelProvider.testModel.failedWithIdentity" },
          {
            provider: providerName,
            model: modelId,
            reason:
              error instanceof Error
                ? error.message
                : intl.formatMessage({ id: "settings.modelProvider.testModel.failed" }),
          },
        ),
        state: "failure",
        durationMs: 8_000,
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      });
    // [资源] finally 无条件复位 isTesting，成功、失败、抛错三条路径都能让按钮恢复可点。
    // 不要把它挪进 try 或 else：任一提前返回都会留下永久旋转的加载图标。
    // 复位后仍保留最后一条 feedback，由 feedback 层按 durationMs 自行消失。
    } finally {
      setIsTesting(false);
    }
  }, [
    onTest,
    isTesting,
    draft.idValue,
    intl,
    providerId,
    providerName,
    providerEnabled,
    showFeedback,
  ]);

  // 图标只表达在途状态，文案与可访问名由按钮的 title 提供。
  // `Loader2Icon` 的 `animate-spin` 不附带延时或清理，卸载即停止。
  const testIcon = isTesting ? (
    <Loader2Icon className="size-3.5 text-foreground-subtle animate-spin" />
  ) : (
    <Unplug className="size-3.5 text-foreground-subtle" />
  );
  // 错误文案优先级：保存异常压过字段校验错误，异常通常更接近用户刚做的动作。
  // 字段错误用模板化 i18n key 拼接，新增字段必须同步补全所有语言的 key。
  // 两者都为空时返回 null，弹窗据此不渲染错误区域，避免留白。
  // 不要在这里做字符串兜底翻译：缺 key 应在语言包里修，而不是在组件里猜。
  const draftErrorMessage =
    commitErrorMessage ??
    (draftErrorField
      ? intl.formatMessage({
          id: `settings.modelProvider.modelMetadata.invalid.${draftErrorField}`,
        })
      : null);
  // 是否展示与是否可用分开计算：展示只看有没有回调，可用还要看供应商与草稿。
  // 拆开是为了让禁用态仍显示按钮，用户能通过 title 知道为什么点不了。
  // 不要在渲染时调用 onTest 来判断存在性之外的东西。
  const shouldShowTestButton = Boolean(onTest);
  // 四个禁用条件缺一不可：供应商未启用、探测在途、模型名为空、没有回调。
  // 缺 providerEnabled 会让已禁用供应商的测试请求照发，后端返回不可用错误。
  // 缺 trim 判空会让空模型名也点亮按钮，用户点后只得到一条难懂的失败提示。
  const testDisabled = !providerEnabled || isTesting || !draft.idValue.trim() || !onTest;
  // 取 model 的已提交配置而不是 draft：行内徽标代表已保存事实，弹窗里才展示草稿。
  // 空值回落 0 交由格式化函数决定占位文案，组件不自己拼单位。
  // locale 参与数字格式，切语言后这里需要随上下文重算。
  const contextWindowLabel = formatModelContextWindowLabel(
    model.config.properties?.contextWindow ?? 0,
    locale,
  );
  const contextWindowAccessibleLabel = intl.formatMessage(
    { id: "settings.modelProvider.contextWindowBadgeLabel" },
    { value: contextWindowLabel },
  );

  // 渲染层只做投影：所有交互都落到上面已定义的 handler，不在 JSX 内联业务判断。
  // 删除 / 开关 / 测试按钮按 `onDelete` 等回调是否存在决定是否出现：缺省隐藏而不占位。
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            data-testid={inputTestId}
            className="min-w-0 truncate font-mono text-ui-base text-foreground"
          >
            {model.modelId}
          </span>
          <span
            className="inline-flex h-5 max-w-20 shrink-0 items-center truncate rounded-md border border-border bg-surface px-1.5 font-mono text-ui-sm text-foreground-subtle"
            aria-label={contextWindowAccessibleLabel}
            title={contextWindowAccessibleLabel}
          >
            {contextWindowLabel}
          </span>
          {shouldShowModelVisionBadge(
            model.modelId,
            model.config.properties?.inputFormat?.supportsImage,
            providerAccess,
          ) ? (
            <ModelInputCapabilityBadge />
          ) : null}
        </div>
        {shouldShowTestButton ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 p-0"
            disabled={testDisabled}
            title={intl.formatMessage({
              id: providerEnabled
                ? "settings.modelProvider.testModel"
                : "settings.modelProvider.testModel.enableProviderFirst",
            })}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={handleTest}
          >
            {testIcon}
          </Button>
        ) : null}
        <ProviderModelMetadataDialog
          onRestore={() => {
            setDraftErrorField(null);
            setCommitErrorMessage(null);
            void editor
              .restore()
              .catch((error) =>
                setCommitErrorMessage(error instanceof Error ? error.message : String(error)),
              );
          }}
          mode="edit"
          open={metadataDialogOpen}
          draft={draft}
          draftErrorMessage={draftErrorMessage}
          draftErrorField={draftErrorField}
          overrideFields={editor.overrides}
          inheritedConfig={editor.inheritedConfig}
          onOpenChange={handleMetadataDialogOpenChange}
          onDraftChange={updateDraft}
          onCommit={handleMetadataDialogCommit}
          saving={metadataSaving}
          modelConfigResolutionPending={editor.pending}
          modelDefaultsLoaded={editor.defaultsLoaded}
          onModelIdBlur={() => {
            void editor.flush().catch(() => undefined);
          }}
          modelIdReadOnly={model.builtin}
        />
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle"
            data-testid={deleteTestId}
            aria-label={intl.formatMessage({ id: "settings.modelProvider.delete" })}
            title={intl.formatMessage({ id: "settings.modelProvider.delete" })}
            onMouseDown={(event) => {
              // 输入框聚焦时点击删除会先触发 blur 保存，父层刷新后原按钮的 click 会丢失。
              event.preventDefault();
            }}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
        {onEnabledChange ? (
          <Switch
            size="sm"
            checked={model.config.enabled !== false}
            aria-label={intl.formatMessage({
              id:
                model.config.enabled === false
                  ? "settings.modelProvider.enableAction"
                  : "settings.modelProvider.disableAction",
            })}
            onCheckedChange={onEnabledChange}
          />
        ) : null}
      </div>
    </div>
  );
}
