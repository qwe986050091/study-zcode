/* eslint-disable max-lines -- 模型供应商卡片仍在迁移期集中维护多个紧耦合区块，后续拆分时再移除。 */
// ==========================================================================
// ProviderCardSections —— 模型供应商卡片的头部、连接、密钥与模型列表区块
//
// 做：渲染供应商卡片的四段 UI，并把用户编辑回传给上层的表单草稿。
// 做：维护新增模型弹窗的开关、保存互斥、字段错误与提交错误。
// 做：把模型列表交给可排序列表渲染，并提示配置不完整的模型。
// 不做：不持有表单权威状态；provider 与 models 的真相在上层表单与 service。
// 不做：不做持久化、不做模型配置解析，只调用注入的 service 与回调。
// 依赖：useServices 的 providerSettingsService.resolveModelConfig 解析候选配置。
// 依赖：useProviderModelDraft 提供草稿、继承配置、字段校验与提交。
// 边界：只读与可编辑是两条完整渲染分支，不能靠 disabled 合并。
// 边界：本文件仍在迁移期，多个紧耦合区块集中维护；拆分前先确认无跨区块共享状态。
// 并发：保存互斥用 ref 而非 state，state 只作为按钮的渲染投影。
// 权衡：宁可让弹窗多一次重置，也不复用上一轮草稿，避免错误与输入互相污染。
// 边界：所有可交互元素必须带 test-id，E2E 依赖它定位。
//
// INV 不变量（格式：断言 / 守住它的位置 / 改错故障）
// INV-01 断言：renameRequestedRef 必须由 onSelect 置位、onCloseAutoFocus 消费 —— 守住它的位置：两处成对改写 —— 改错故障：菜单关闭抢回焦点，重命名输入框失焦。
// INV-02 断言：菜单可见性必须同时看 nameEditable 与 onDelete —— 守住它的位置：secondaryActionsVisible —— 改错故障：只读 provider 出现点了没反应的更多按钮。
// INV-03 断言：只读模式走 renderReadOnlyField，不渲染可编辑 Input —— 守住它的位置：if (readOnly) 分支 —— 改错故障：只读 provider 仍可改 baseUrl。
// INV-04 断言：只读 baseUrl 必须取 provider.config.api —— 守住它的位置：readOnlyBaseUrl —— 改错故障：显示空值或未保存草稿，用户以为配置丢失。
// INV-05 断言：只读格式缺省必须与可编辑态一致 —— 守住它的位置：resolvedApiFormat —— 改错故障：同一 provider 两态显示不同协议。
// INV-06 断言：createEmptyModel 不得写入档位或能力推断 —— 守住它的位置：createEmptyModel —— 改错故障：空 ID 被误认为智能推荐档位。
// INV-07 断言：addSavingRef 与 addSaving 必须成对维护 —— 守住它的位置：commitAddDraft 的 finally —— 改错故障：保存中关闭弹窗，旧请求结束新草稿。
// INV-08 断言：打开与关闭弹窗都必须重置草稿与错误 —— 守住它的位置：openAddDialog 与 cancelAddDialog —— 改错故障：上一轮错误残留到新草稿。
// INV-09 断言：必须等 onAddModel 完成才关闭弹窗 —— 守住它的位置：commitAddDraft 的 await —— 改错故障：保存失败后用户输入全部丢失。
// INV-10 断言：失败路径必须经过 finally 复位 saving —— 守住它的位置：finally 分支 —— 改错故障：一次失败后添加按钮永久禁用。
// INV-11 断言：字段错误文案只在字段错误时拼接 —— 守住它的位置：addDraftErrorMessage —— 改错故障：拼接出不存在的 i18n key，弹窗显示裸 id。
// INV-12 断言：resolve 回调必须固化 providerId —— 守住它的位置：resolveAddModelConfig —— 改错故障：解析到别的 provider 的模型配置。
// INV-13 断言：onResolveDraft 必须克隆 personalConfig —— 守住它的位置：structuredClone 调用 —— 改错故障：编辑草稿被上级对象引用污染。
// INV-14 断言：行 key 必须是 providerId 与 modelId 的组合 —— 守住它的位置：ModelRowInput 的 key —— 改错故障：重排后行状态错位，输入串行。
// INV-15 断言：只有非 builtin 才传 onDelete —— 守住它的位置：onDelete 的三元表达式 —— 改错故障：内置模型出现删除入口。
// INV-16 断言：onModelEnabledChange 的 rejection 必须被吞掉 —— 守住它的位置：catch(() => undefined) —— 改错故障：未捕获 rejection 打断整列表渲染。
// INV-17 断言：完整性判定必须覆盖 7 个维度 —— 守住它的位置：completeProperties —— 改错故障：缺一维的模型不再提示配置不完整。
// INV-18 断言：modelIds 与 models 必须同源同序 —— 守住它的位置：SortableProviderModelList 的两个 props —— 改错故障：排序结果映射到错误模型。
// INV-19 断言：新增弹窗必须挂在列表之后 —— 守住它的位置：末尾的 fragment —— 改错故障：弹窗提前挂载会抢占首个 tab 焦点。
// INV-20 断言：只读与可编辑复用同一组 i18n key —— 守住它的位置：renderReadOnlyField 的调用 —— 改错故障：两态文案分叉，翻译只覆盖一半。
// ==========================================================================
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type {
  ProviderSettingsFormProvider,
  ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderApiType } from "@zcode/provider";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAME_EDIT_BUTTON,
  TID_MODEL_PROVIDER_NAME_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { InfoIcon, LockKeyholeIcon, Plus, Pencil, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
import { ModelRowInput } from "./ProviderFormControls.js";
import { PresetProviderApiKeyBanner } from "./PresetProviderApiKeyBanner.js";
import { type ProviderModelDraftValues } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import {
  PROVIDER_CONNECTION_API_FORMATS,
  ProviderApiFormatSelect,
  resolveProviderConnectionApiFormatDisplayLabel,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
import { SortableProviderModelList } from "@/settings/model-provider-section/SortableProviderModelList.js";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import type { ProviderConfigObject } from "@zcode/provider";

export {
  resolveProviderConnectionApiFormatDisplayLabel,
  resolveProviderConnectionApiFormatOptions,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
export { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";

// [契约] 曾按 provider 的协议与模型能力收敛选项，现已统一返回全量格式；
// 保留该函数是为了调用点稳定：它是外部获取格式列表的唯一入口；
// 不要删成直接引用 PROVIDER_CONNECTION_API_FORMATS，会破坏既有导出契约；
// 参数以下划线开头表示刻意未使用，改回真实使用会让外观随厂商抖动；
// 返回新数组，调用方可以排序，但不能改共享常量。
export function resolveProviderApiFormatOptions(
  _provider: Pick<ProviderSettingsFormProvider, "config" | "models">,
): ProviderApiType[] {
  return [...PROVIDER_CONNECTION_API_FORMATS];
}

// [契约] 恒为 true 是当前产品决定：所有 provider 都必须展示 API 格式；
// 保留形参是为了将来按 provider 收敛时不动调用点；
// 不要在连接区块里内联 true，否则只读与可编辑两条路径会分叉；
// 改成 false 会让格式选择器整体消失，用户无法显式指定协议；
// 只读渲染路径同样依赖本函数。
export function shouldShowProviderApiFormat(
  _provider: Pick<ProviderSettingsFormProvider, "providerId">,
): boolean {
  return true;
}

// [契约] 头部同时承载重命名输入与更多菜单，两者共享 renameRequestedRef；
// nameEditable 与 onDelete 决定菜单是否值得渲染，不能只看 actionsVisible；
// providerToggle 是外部注入的开关节点，顺序必须在更多菜单之前；
// 编辑态与展示态是互斥分支，不能让 nameValue 回落到 providerName；
// 所有可交互元素都必须带 test-id，E2E 依赖它定位。
export function ProviderCardHeader({
  providerName,
  logo,
  editingName,
  nameValue,
  nameInputRef,
  nameEditable = true,
  onNameChange,
  onNameBlur,
  onNameKeyDown,
  onNameCompositionEnd,
  onNameCompositionStart,
  onStartEditName,
  onDelete,
  actionsVisible = true,
  providerToggle,
}: {
  providerName: string;
  logo?: ProviderConfigObject["logo"];
  editingName: boolean;
  nameValue: string;
  nameInputRef: RefObject<HTMLInputElement | null>;
  nameEditable?: boolean;
  onNameChange: (value: string) => void;
  onNameBlur: () => void;
  onNameKeyDown: (event: ReactKeyboardEvent) => void;
  onNameCompositionEnd?: () => void;
  onNameCompositionStart?: () => void;
  onStartEditName: () => void;
  onDelete?: () => void;
  actionsVisible?: boolean;
  providerToggle?: ReactNode;
}) {
  // [契约] 文案一律走 intl.formatMessage，不得手写中英文；
  // 用 id 而不是默认文案，才能保证多语言与文案变更同步；
  // 这里只取一次 intl，子节点不要再各自调用 hook；
  // 缺失的 i18n key 会渲染成 id，联调时可据此快速发现漏配；
  // 不要在本组件做文案拼接，参数化文案交给占位符。
  const { intl } = useZCodeIntl();
  // [契约] 它标记本次菜单关闭是为了重命名，由 onSelect 置位、onCloseAutoFocus 消费；
  // 置位与消费必须成对，只消费不复位会让下一次普通关闭也阻止默认焦点；
  // 不能用 state：菜单关闭回调执行时 state 尚未提交，读不到最新值；
  // 重命名结束后焦点由输入框自身接住，不要在菜单里手动 focus；
  // 每次打开菜单前不要重置 renameRequestedRef，复位只发生在消费点。
  const renameRequestedRef = useRef(false);
  // [契约] 菜单可见性必须同时看 actionsVisible 与可重命名或可删除；
  // 只读 provider 两者都为假，应当完全不渲染菜单按钮，而不是渲染空菜单；
  // 把条件简化成 actionsVisible 会出现点了没反应的按钮；
  // nameEditable 与 onDelete 是独立能力，不要用一个替代另一个；
  // 该布尔同时决定 DropdownMenu 与其中分割线。
  const secondaryActionsVisible = actionsVisible && (nameEditable || Boolean(onDelete));

  return (
    <div className="flex items-center justify-between gap-3" data-testid="model-provider-header">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo logo={logo} className="size-5" />
        {editingName ? (
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            ref={nameInputRef}
            data-testid={TID_MODEL_PROVIDER_NAME_INPUT}
            type="text"
            size="lg"
            className="w-auto min-w-0 text-ui-lg font-semibold"
            value={nameValue}
            onChange={(event) => onNameChange(event.target.value)}
            onCompositionEnd={onNameCompositionEnd}
            onCompositionStart={onNameCompositionStart}
            onBlur={onNameBlur}
            onKeyDown={onNameKeyDown}
          />
        ) : (
          <>
            <div className="min-w-0 truncate text-ui-lg font-semibold text-foreground">
              {providerName}
            </div>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {providerToggle}
        {secondaryActionsVisible ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="model-provider-actions-button"
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                // 重命名后的焦点交给输入框，不能被菜单关闭时重新抢回触发按钮。
                // [契约] 只在 renameRequestedRef 为真时阻止菜单关闭后的自动聚焦；
                // preventDefault 必须与复位同处，否则标志会泄漏到下一次关闭；
                // 这里不能改成主动 focus：焦点目标由输入框的 ref 决定；
                // 不要在 preventDefault 之后做异步状态更新，会打断焦点链；
                // 该分支必须早于任何其他 focus 逻辑。
                if (renameRequestedRef.current) {
                  event.preventDefault();
                  renameRequestedRef.current = false;
                }
              }}
            >
              {nameEditable ? (
                <DropdownMenuItem
                  data-testid={TID_MODEL_PROVIDER_NAME_EDIT_BUTTON}
                  onSelect={() => {
                    renameRequestedRef.current = true;
                    onStartEditName();
                  }}
                >
                  <Pencil className="size-3.5" />
                  {intl.formatMessage({ id: "settings.modelProvider.renameProvider" })}
                </DropdownMenuItem>
              ) : null}
              {nameEditable && onDelete ? <DropdownMenuSeparator /> : null}
              {onDelete ? (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="size-3.5" />
                  {intl.formatMessage({ id: "common.delete" })}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

// [契约] 只读与可编辑是两个完整分支，不要合并成受控控件加 disabled；
// 只读分支必须展示 baseUrl 与格式的真实值，避免用户以为配置丢失；
// apiFormat 与 baseUrlValue 由上层草稿持有，本组件只负责渲染与回传；
// readOnly 变化会整体换分支，受控输入不会跨分支保留未提交值；
// 所有输入都必须带 TECHNICAL_INPUT_ATTRIBUTES，禁用自动更正。
export function ProviderConnectionSection({
  provider,
  readOnly,
  apiFormat,
  baseUrlValue,
  onApiFormatChange,
  onBaseUrlChange,
  onBaseUrlBlur,
  onBaseUrlKeyDown,
  onBaseUrlCompositionStart,
  onBaseUrlCompositionEnd,
}: {
  provider: ProviderSettingsFormProvider;
  readOnly?: boolean;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  onApiFormatChange: (value: ProviderApiType) => void;
  onBaseUrlChange: (value: string) => void;
  onBaseUrlBlur: () => void;
  onBaseUrlKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBaseUrlCompositionStart?: () => void;
  onBaseUrlCompositionEnd?: () => void;
}) {
  // [契约] 连接区块的标签与占位符都走 intl，不得硬编码；
  // 只读字段的 aria-label 需要带字段名参数，用 values 传入；
  // 不要为每个字段新建 intl 调用：同一组件内复用同一个 intl；
  // 字段名作为参数传给只读渲染器，避免为每个字段写一条 aria 文案；
  // 文案 id 变更要同步所有语言包。
  const { intl } = useZCodeIntl();
  // [契约] 是否展示格式选择统一由 shouldShowProviderApiFormat 决定；
  // 可编辑与只读分支都必须用同一个判断，否则两态会不一致；
  // 不要在这里重新计算 provider 类型：判断逻辑只能有一处；
  // 改动它会同时影响两处渲染，属于产品级开关；
  // showApiFormat 不参与提交，只影响展示。
  const showApiFormat = shouldShowProviderApiFormat(provider);
  // [契约] 只读模式显示已保存配置，不是草稿：来源必须是 provider.config.api；
  // 兜底空串而不是 undefined，避免渲染出 undefined 文本；
  // 格式同理，缺省必须与可编辑态一致，否则两态显示不同；
  // 不要回退到 baseUrlValue：那会把未保存输入伪装成已保存；
  // readOnlyBaseUrl 与 resolvedApiFormat 都不参与可编辑分支。
  const readOnlyBaseUrl = provider.config.api?.baseUrl ?? "";
  const resolvedApiFormat = provider.config.api?.type ?? "anthropic-messages";

  // [契约] 只读字段统一走这个渲染器，保证 label、锁定图标与换行行为一致；
  // 空值显示为短横线而不是留白，避免被误认为加载中；
  // aria-label 必须带字段名，屏幕阅读器才能区分多个只读字段；
  // 锁定图标是纯装饰，必须 aria-hidden；
  // 不要在这里加复制按钮：只读字段可能包含敏感值。
  const renderReadOnlyField = (label: string, value: string) => (
    <div>
      <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      <div className="flex min-h-8 items-center gap-2 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-base text-foreground">
        <span className="min-w-0 flex-1 break-all">{value || "-"}</span>
        <span
          role="img"
          aria-label={intl.formatMessage(
            { id: "settings.modelProvider.readOnlyField" },
            { field: label },
          )}
          className="shrink-0 text-foreground-subtle"
        >
          <LockKeyholeIcon className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );

  // [契约] 只读分支必须整体 return，不能在可编辑 JSX 上叠加条件；
  // 两个分支元素结构不同，靠 disabled 模拟会让语义与键盘行为错乱；
  // 只读分支仍要保留格式字段，受 showApiFormat 控制；
  // 提前 return 的顺序不可与下方可编辑分支调换；
  // 该判断只读 props，不读草稿状态。
  if (readOnly) {
    return (
      <>
        {renderReadOnlyField(
          intl.formatMessage({ id: "settings.modelProvider.baseUrl" }),
          readOnlyBaseUrl,
        )}
        {showApiFormat
          ? renderReadOnlyField(
              intl.formatMessage({ id: "settings.modelProvider.apiFormat" }),
              resolveProviderConnectionApiFormatDisplayLabel(intl, resolvedApiFormat),
            )
          : null}
      </>
    );
  }

  return (
    <>
      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}
        </label>
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          type="text"
          size="lg"
          data-testid={TID_MODEL_PROVIDER_BASE_URL_INPUT}
          value={baseUrlValue}
          placeholder={intl.formatMessage({
            id: "settings.modelProvider.baseUrlPlaceholder",
          })}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          onBlur={onBaseUrlBlur}
          onKeyDown={onBaseUrlKeyDown}
          onCompositionStart={onBaseUrlCompositionStart}
          onCompositionEnd={onBaseUrlCompositionEnd}
        />
      </div>
      {showApiFormat ? (
        <div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}
          </label>
          <ProviderApiFormatSelect value={apiFormat} onChange={onApiFormatChange} />
        </div>
      ) : null}
    </>
  );
}

// [契约] 密钥输入必须经 ApiKeyInput 封装，不能直接用 Input 透出明文；
// visible 由上层控制，本组件不缓存可见性；
// presetApiKeyUrl 与 onOpenPresetApiKey 必须同时存在才渲染横幅；
// 只读模式下仍允许切换可见性，但不可编辑；
// 密钥值不得进入任何日志或 test-id。
export function ProviderApiKeySection({
  apiKeyValue,
  apiKeyVisible,
  readOnly,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  onApiKeyChange,
  onApiKeyBlur,
  onApiKeyKeyDown,
  onApiKeyCompositionStart,
  onApiKeyCompositionEnd,
  onToggleApiKeyVisibility,
}: {
  apiKeyValue: string;
  apiKeyVisible: boolean;
  readOnly?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onApiKeyKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onApiKeyCompositionStart?: () => void;
  onApiKeyCompositionEnd?: () => void;
  onToggleApiKeyVisibility: () => void;
}) {
  // [契约] 密钥区块只在标签处用 intl，错误文案由 ApiKeyInput 内部处理；
  // 不要在父组件重复渲染同一标签，会出现双重 label 关联；
  // 文案 id 必须与设置页其他区块保持命名一致；
  // 该区块不拼接动态参数；
  // 缺失 key 会显示 id，联调时可据此定位。
  const { intl } = useZCodeIntl();

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
        </label>
        {presetApiKeyUrl && onOpenPresetApiKey ? (
          <PresetProviderApiKeyBanner onOpenApiKey={onOpenPresetApiKey} />
        ) : null}
      </div>
      <ApiKeyInput
        value={apiKeyValue}
        visible={apiKeyVisible}
        readOnly={readOnly}
        onChange={onApiKeyChange}
        onBlur={onApiKeyBlur}
        onKeyDown={onApiKeyKeyDown}
        onCompositionStart={onApiKeyCompositionStart}
        onCompositionEnd={onApiKeyCompositionEnd}
        onToggleVisibility={onToggleApiKeyVisibility}
      />
    </div>
  );
}

// [契约] 空模型只带最小可用 properties，不得写入档位或能力推断结果；
// 空 modelId 尚未解析配置，硬编码档位会被误认为智能推荐；
// builtin/personalConfig/hasPersonalConfig 必须显式给默认值，避免 undefined 泄漏；
// executable 与 selectable 初始为 false，等解析完成再置位；
// 该函数必须是纯函数，每次打开弹窗都要拿到全新对象。
function createEmptyModel(): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "",
    builtin: false,
    personalConfig: {},
    // 空 ID 尚未解析模型配置，硬编码档位会被误认为智能推荐。
    config: {
      properties: { supportsToolCall: true },
    },
    hasPersonalConfig: false,
    executable: false,
    selectable: false,
  };
}

// [契约] 列表的权威数据是 models 草稿数组，不是服务端返回的模型表；
// onModelCommit/onAddModel/onDeleteModel 都可能异步失败，组件必须处理 rejected；
// settingsRevision 是并发写保护：提交时必须带上调用方看到的版本号；
// onReorderModelIds 可选，缺失时排序入口应禁用而不是静默无效；
// providerAccess 与 providerEnabled 只影响行内可用性，不改变列表内容。
export function ProviderModelsSection({
  providerId,
  providerName,
  providerEnabled = true,
  providerAccess,
  models,
  onTestModel,
  onModelCommit,
  onModelEnabledChange,
  onDeleteModel,
  onAddModel,
  onReorderModelIds,
  settingsRevision = 0,
}: {
  providerId: string;
  providerName?: string;
  providerEnabled?: boolean;
  providerAccess?: ProviderConfigObject["access"];
  models: ProviderSettingsFormModel[];
  onTestModel?: (model: string) => Promise<ModelConnectivityResult>;
  onModelCommit: (
    originalModelId: string,
    model: ProviderSettingsFormModel,
    basedOnRevision: number,
  ) => void | Promise<void>;
  onDeleteModel: (modelId: string) => void;
  onModelEnabledChange?: (modelId: string, enabled: boolean) => void | Promise<void>;
  onAddModel: (model: ProviderSettingsFormModel) => void | Promise<void>;
  onReorderModelIds?: (modelIds: string[]) => void;
  settingsRevision?: number;
}) {
  // [契约] 模型区块的所有文案（含字段错误）都走 intl；
  // 错误文案用模板拼 i18n key，字段名必须是受控枚举；
  // 不要把错误文案落进 state：它随错误字段即时派生；
  // 列表为空与配置不完整是两条不同文案，不能复用；
  // 文案 id 必须与 ProviderModelMetadataDialog 保持一致。
  const { intl } = useZCodeIntl();
  // [依赖] 服务经 useServices 注入，组件不得直接访问 Repo 或 runtime；
  // resolveModelConfig 用于把 modelId 解析成候选配置，是纯读操作；
  // 不要缓存 service 的方法引用：服务实例可能随 Provider 重建；
  // 调用处必须带 providerId，缺省会解析到错误的供应商；
  // providerSettingsService 不参与持久化，提交仍走上层回调。
  const { providerSettingsService } = useServices();
  // [事务] 弹窗开关与草稿生命周期绑定：打开时 reset，关闭时 reset 并 cancel；
  // 不能用条件挂载代替开关，卸载会丢掉正在编辑的草稿；
  // 保存中不允许关闭，否则旧请求结束掉新草稿；
  // openAddDialog 必须先清错误与字段错误再置 true；
  // 该 state 不参与任何提交参数。
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  // [并发] addSavingRef 是同步互斥，addSaving 只是它的渲染投影，两者必须成对维护；
  // 只用 state 判断会因批量更新延迟而放行第二次提交；
  // finally 里必须同时复位两者，任何提前 return 都要经过 finally；
  // addSavingRef 为真时要允许关闭请求被忽略，而不是禁用按钮；
  // 不要用它替代错误态：失败后必须允许重试。
  const addSavingRef = useRef(false);
  const [addCommitError, setAddCommitError] = useState<string | null>(null);
  const [addModel] = useState(createEmptyModel);
  const [addDraftErrorField, setAddDraftErrorField] = useState<
    | "id"
    | "contextWindow"
    | "maxOutputTokens"
    | "inputFormat"
    | "reasoningLevelValues"
    | "reasoningLevelMap"
    | null
  >(null);
  // [契约] resolve 回调必须固化 providerId，避免闭包捕获到切换后的供应商；
  // 它只用于把空 modelId 的输入解析成候选配置，不做提交；
  // 依赖里必须包含 providerId 与 service，缺一个就会解析到旧数据；
  // 不要在这里做 try/catch：错误由 useProviderModelDraft 统一处理；
  // 该函数身份变化会重建 editor，进而重置草稿。
  const resolveAddModelConfig = useCallback(
    (modelId: string) => providerSettingsService.resolveModelConfig({ providerId, modelId }),
    [providerId, providerSettingsService],
  );
  const editor = useProviderModelDraft({
    model: addModel,
    open: addDialogOpen,
    scopeKey: providerId,
    resolve: resolveAddModelConfig,
  });
  const { draft: addDraft } = editor;

  // [事务] 打开弹窗必须先重置草稿、字段错误与提交错误，再置 open；
  // 顺序颠倒会让弹窗先渲染上一轮的错误文案；
  // reset 与 cancel 不能合并：cancel 是放弃编辑，reset 是换新草稿；
  // editor.reset 的身份进依赖，避免用到旧 editor 实例；
  // 该回调不校验权限，权限由上层决定是否渲染入口。
  const openAddDialog = useCallback(() => {
    editor.reset(createEmptyModel());
    setAddDraftErrorField(null);
    setAddCommitError(null);
    setAddDialogOpen(true);
  }, [editor.reset]);

  const updateAddDraft = (patch: Partial<ProviderModelDraftValues>) => {
    editor.change(patch);
    setAddDraftErrorField(null);
  };

  const cancelAddDialog = () => {
    setAddDialogOpen(false);
    editor.reset(createEmptyModel());
    setAddDraftErrorField(null);
    editor.cancel();
  };

  const handleAddDialogOpenChange = useCallback(
    (open: boolean) => {
      // 保存中的关闭/再打开会让旧请求结束掉新草稿，等待本次提交完成再结束编辑。
      if (addSavingRef.current) return;
      if (!open) {
        cancelAddDialog();
        return;
      }
      setAddDialogOpen(true);
    },
    [cancelAddDialog],
  );

  const commitAddDraft = useCallback(async (): Promise<boolean> => {
    if (addSavingRef.current) return false;
    addSavingRef.current = true;
    setAddSaving(true);
    setAddCommitError(null);
    try {
      const result = await editor.commit();
      if (result.status === "invalid") {
        setAddDraftErrorField(result.field);
        return false;
      }
      // 过去只发起异步添加就关闭弹窗，失败后输入也丢了；以实际保存完成作为结束边界。
      await onAddModel(result.model);
      setAddDialogOpen(false);
      editor.reset(createEmptyModel());
      return true;
    } catch (error) {
      setAddCommitError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      addSavingRef.current = false;
      setAddSaving(false);
    }
  }, [editor, onAddModel]);
  // [契约] 只有字段级错误才拼接错误文案，提交错误单独走 addCommitError；
  // 字段名必须是受控枚举，否则会拼出不存在的 i18n key；
  // 用条件表达式派生而不写 state：它需要随字段即时变化；
  // 弹窗展示时优先 commitError，其次才是字段错误；
  // addDraftErrorMessage 不参与提交判定。
  const addDraftErrorMessage = addDraftErrorField
    ? intl.formatMessage({
        id: `settings.modelProvider.modelMetadata.invalid.${addDraftErrorField}`,
      })
    : null;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.models" })}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="default"
          className="rounded-lg"
          data-testid={TID_MODEL_PROVIDER_ADD_MODEL_BUTTON}
          onClick={openAddDialog}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.modelProvider.addModel" })}
        </Button>
      </div>
      {models.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-input-border bg-input">
          <SortableProviderModelList
            modelIds={models.map((model) => model.modelId)}
            sortableModelIds={models.map((model) => model.modelId)}
            onReorder={onReorderModelIds}
            renderModel={(_modelId, index) => {
              // [契约] renderModel 必须以 index 取 models，不能按 modelId 查找；
              // 非空断言成立的前提是传入的 modelIds 与 models 同序同长；
              // 两个列表 props 必须来自同一数组，否则排序会映射到错行；
              // 不要在渲染回调里改 models 数组，顺序变化会立即打断拖拽；
              // 行 key 必须由 providerId 与 modelId 组合，保证跨 provider 唯一。
              const model = models[index]!;
              // [契约] 能力字段必须从 model.config.properties 读，不能在组件里推导；
              // properties 可能整体缺失，必须可选链访问；
              // outputFormat 必须与 inputFormat 分开读，二者可以只存在其一；
              // 这些字段只用于完整性提示，不参与提交对象构造；
              // 不要在这里克隆配置：克隆只发生在 onResolveDraft。
              const inputFormat = model.config.properties?.inputFormat;
              const outputFormat = model.config.properties?.outputFormat;
              // [契约] 完整性判定必须覆盖 contextWindow、输入四维与输出 text 共 7 项；
              // 少判一维会让配置不完整的模型不再提示，用户以为已就绪；
              // 用非空判断而不是真值判断，0 是合法的窗口值；
              // 缺失时展示 issues[0] 文案，回退到通用不完整提示；
              // completeProperties 只影响提示，不阻塞保存。
              const completeProperties =
                model.config.properties?.contextWindow != null &&
                inputFormat?.supportsText != null &&
                inputFormat.supportsImage != null &&
                inputFormat.supportsVideo != null &&
                inputFormat.supportsAudio != null &&
                inputFormat.supportsPdf != null &&
                outputFormat?.supportsText != null;
              return (
                <>
                  <ModelRowInput
                    key={`${providerId}/${model.modelId}`}
                    providerId={providerId}
                    providerName={providerName}
                    providerEnabled={providerEnabled}
                    providerAccess={providerAccess}
                    inputTestId={testId(TID_MODEL_PROVIDER_MODEL_INPUT, String(index))}
                    deleteTestId={testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, String(index))}
                    model={model}
                    onCommit={(value, basedOnRevision) =>
                      onModelCommit(model.modelId, value, basedOnRevision)
                    }
                    onResolveDraft={(nextModelId, personalConfig) =>
                      providerSettingsService.resolveModelConfig({
                        providerId,
                        originalModelId: model.modelId,
                        modelId: nextModelId,
                        personalConfig: structuredClone(personalConfig),
                      })
                    }
                    settingsRevision={settingsRevision}
                    onDelete={!model.builtin ? () => onDeleteModel(model.modelId) : undefined}
                    onEnabledChange={(enabled) => {
                      void Promise.resolve(onModelEnabledChange?.(model.modelId, enabled)).catch(
                        () => undefined,
                      );
                    }}
                    onTest={onTestModel}
                  />
                  {!completeProperties && (
                    <div className="px-3 pb-2 text-ui-sm text-destructive">
                      {model.issues?.[0]?.message ??
                        intl.formatMessage({ id: "settings.modelProvider.modelConfigIncomplete" })}
                    </div>
                  )}
                </>
              );
            }}
          />
        </div>
      ) : (
        <div className="mt-1 flex h-12 items-center justify-start gap-2 rounded-lg border border-dashed border-border px-4 text-left text-ui-base text-foreground-subtle">
          <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.modelProvider.modelsEmpty" })}
        </div>
      )}
      <>
        <ProviderModelMetadataDialog
          onRestore={() => {
            setAddDraftErrorField(null);
            setAddCommitError(null);
            void editor
              .restore()
              .catch((error) =>
                setAddCommitError(error instanceof Error ? error.message : String(error)),
              );
          }}
          mode="add"
          open={addDialogOpen}
          draft={addDraft}
          draftErrorMessage={addCommitError ?? addDraftErrorMessage}
          draftErrorField={addDraftErrorField}
          inheritedConfig={editor.inheritedConfig}
          overrideFields={editor.overrides}
          onOpenChange={handleAddDialogOpenChange}
          onDraftChange={updateAddDraft}
          onCommit={commitAddDraft}
          saving={addSaving}
          modelConfigResolutionPending={editor.pending}
          modelDefaultsLoaded={editor.defaultsLoaded}
          onModelIdBlur={() => {
            void editor.flush().catch(() => undefined);
          }}
        />
      </>
    </div>
  );
}
