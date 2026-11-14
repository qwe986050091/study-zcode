// ProviderModelMetadataDialog：新增/编辑模型共用的元数据对话框，把草稿渲染成受控表单。
// 只做展示与输入采集：校验规则、推荐值解析、保存事务都在上层与 ProviderModelMetadata 中完成。
// 不负责：i18n 文案定义、弹层定位、快捷键注册、模型列表加载，也不持有任何业务状态副本。
//
// INV-01 断言：add 模式只自动聚焦模型 ID，edit 模式只自动聚焦上下文窗口 —— 守住它的位置：shouldFocusModelIdInput 与 shouldFocusContextWindowInput —— 改错故障：新增模型时光标落在空 ID 之外，用户先看到继承数值再回头补 ID
// INV-02 断言：smart 的判定是 useRecommendedConfigValue !== false，未定义即视为开启 —— 守住它的位置：smart 常量 —— 改错故障：旧草稿缺字段时开关误显示为关闭，覆盖标记全亮并让用户以为配置被改动
// INV-03 断言：非 smart 时 activeOverrides 必须是空集合 —— 守住它的位置：activeOverrides 三元表达式 —— 改错故障：关闭推荐后仍显示覆盖高亮，用户无法判断哪些值来自个人配置
// INV-04 断言：overridden 在 smart 时读 overrideFields，非 smart 时回退 legacy 参数 —— 守住它的位置：overridden 闭包 —— 改错故障：关闭智能配置后覆盖标记消失，回显值与高亮状态互相矛盾
// INV-05 断言：data-personal-override 与 className 必须传同一组参数 —— 守住它的位置：上下文窗口与最大输出两个 Input —— 改错故障：边框高亮与覆盖语义错位，出现高亮却不能重置的字段
// INV-06 断言：add 模式下模型 ID 为空时最大输出输入禁用 —— 守住它的位置：maxOutputTokensInputDisabled —— 改错故障：用户先填最大输出，切换模型后又被打回空值且无提示
// INV-07 断言：placeholder 只在 smart 且继承值存在时展示 —— 守住它的位置：两个输入框的 placeholder 表达式 —— 改错故障：编辑个人覆盖值时仍看到继承值灰字，误以为未生效
// INV-08 断言：Enter 提交前必须通过输入法组合判定 —— 守住它的位置：handleTechnicalInputKeyDown 首个分支 —— 改错故障：中文候选确认即触发保存，正在输入的模型 ID 被截断提交
// INV-09 断言：组合态用 ref 保存且 start 与 end 成对置位 —— 守住它的位置：compositionActiveRef 与两个回调 —— 改错故障：漏掉 end 后回车永久失效，只能点保存按钮
// INV-10 断言：commit 只在 onCommit 返回假值时递增 validationAttempt —— 守住它的位置：commit 内部 —— 改错故障：成功后计数也增加，错误样式与滚动定位反复触发
// INV-11 断言：onCommit 可能返回 Promise，必须 await 后再判结果 —— 守住它的位置：commit 内部 —— 改错故障：异步保存被当成失败，表单闪现错误提示
// INV-12 断言：输入框 id 由 useId 生成并绑定到 label 的 htmlFor —— 守住它的位置：contextWindowInputId 与 maxOutputInputId —— 改错故障：点击标签不聚焦，屏幕阅读器读不到字段名
// INV-13 断言：保存期间正文容器以 inert 锁定而不是卸载 —— 守住它的位置：正文 div 的 inert 属性 —— 改错故障：卸载导致焦点与滚动位置丢失，弹窗高度抖动
// INV-14 断言：只有正文滚动，外框用 overflow-clip 裁切 —— 守住它的位置：DialogContent 的 className —— 改错故障：长语言换行时标题被滚出视口
// INV-15 断言：能力开关字段名由属性名拼 Value 后缀得到 —— 守住它的位置：capabilities 映射 —— 改错故障：开关读到 undefined 后永远显示关闭，保存也不落值
// INV-16 断言：draft 是唯一受控输入源，组件内不缓存字段副本 —— 守住它的位置：组件内所有 value 绑定 —— 改错故障：上层回滚或恢复默认后界面仍显示旧值
// INV-17 断言：TECHNICAL_INPUT_ATTRIBUTES 必须展开在 Input 属性最前 —— 守住它的位置：四处 Input 的展开 —— 改错故障：后续显式属性覆盖不全，数字字段出现拼写检查与自动纠正
// INV-18 断言：模型 ID 的只读与失焦行为完全由 props 决定 —— 守住它的位置：readOnly 与 onBlur 的传递 —— 改错故障：新增与编辑语义串味，编辑态误改主键
import { useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Loader2Icon, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelConfigObject } from "@zcode/provider";
import type {
  ProviderModelDraftValues,
  ProviderModelDraftCommitResult,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelInputModalityOptions } from "@/settings/model-provider-section/ProviderModelModalityOptions.js";
import { BooleanModelOption } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";
import {
  ModelSettingsGroup,
  ProviderModelReasoningSettings,
} from "@/settings/model-provider-section/ProviderModelSettingsGroups.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import {
  ProviderModelMetadataDialogActions,
  ModelSmartConfigSwitch,
  ModelConfigDraftFeedback,
  ModelConfigRestoreButton,
} from "@/settings/model-provider-section/ProviderModelMetadataDialogActions.js";
import { modelEditorControlStyle } from "@/settings/model-provider-section/modelEditorControlStyle.js";
import { cn } from "@/components/lib/utils.js";
import {
  ModelConfigHelp,
  ModelConfigInputLabel,
} from "@/settings/model-provider-section/ModelConfigHelp.js";

import { ModelEditorAdvanced } from "@/settings/model-provider-section/ModelEditorAdvanced.js";

// [契约] 聚焦即全选数值，用户可直接键入替换，不必先删旧值
// 这不是视觉偏好：上下文窗口与最大输出都通过 onFocus 调它，去掉后每次改数值都要手动清空
// 参数刻意只取 currentTarget，避免把整个焦点事件暴露给选择逻辑
// 副作用只有 selection，不读 draft 也不触发变更，因此可安全复用于多个字段
// 若换成把光标放到首位的写法，数字输入会变成反向拼接，越输越乱
export function selectFocusedInputText(event: Pick<FocusEvent<HTMLInputElement>, "currentTarget">) {
  event.currentTarget.select();
}

// [契约] 对话框是纯受控组件：open、draft、saving 全部由上层持有
// 本组件不把草稿复制进本地 state，否则恢复默认与校验回填都会被旧副本覆盖
// mode 只影响标题文案、自动聚焦、最大输出禁用与是否渲染触发按钮，不参与数据分流
// onCommit 允许返回 Promise，上层可以走异步保存，本组件只关心真假
// 新增与编辑共用同一棵树，若拆成两份表单，字段顺序与校验锚点会逐渐漂移
export function ProviderModelMetadataDialog({
  mode = "edit",
  open,
  draft,
  draftErrorMessage,
  draftErrorField,
  personalConfig,
  overrideFields,
  inheritedConfig,
  onOpenChange,
  onDraftChange,
  onRestore,
  onCommit,
  modelConfigResolutionPending = false,
  modelIdReadOnly = false,
  saving = false,
  modelDefaultsLoaded = false,
  onModelIdBlur,
}: {
  mode?: "add" | "edit";
  open: boolean;
  draft: ProviderModelDraftValues;
  draftErrorMessage: string | null;
  draftErrorField?: Extract<ProviderModelDraftCommitResult, { status: "invalid" }>["field"] | null;
  personalConfig?: ModelConfigObject;
  overrideFields?: ReadonlySet<string>;
  inheritedConfig?: ModelConfigObject;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (patch: Partial<ProviderModelDraftValues>) => void;
  onRestore?: () => void;
  onCommit: () => boolean | Promise<boolean>;
  modelConfigResolutionPending?: boolean;
  modelIdReadOnly?: boolean;
  saving?: boolean;
  modelDefaultsLoaded?: boolean;
  onModelIdBlur?: () => void;
}) {
  // 每次渲染重新取 intl，文案跟随语言切换即时更新，不做模块级缓存
  // formatMessage 调用点尽量贴近使用处，id 拼错时能在该行直接定位
  // 把 intl 提到组件外只能拿到初始语言，切换语言后弹窗仍显示旧文案
  // 下文所有 aria-label、标题与按钮文案都依赖这一处，改造时不要拆成多份 provider
  // 若要在非组件环境复用文案，应另建纯函数层，而不是让这里接受外部传入的 intl
  const { intl } = useZCodeIntl();
  // [失败路径] 这个计数只用于触发错误提示重新定位，不是校验结果本身
  // 只有 onCommit 返回假值才加一，成功路径不重置，避免错误块闪一下又消失
  // 单调递增可保证同一处错误重复出现时仍能触发滚动与高亮
  // 不要改成布尔开关：连续两次同样的失败在布尔下不产生状态变化，第二次就不会重定位
  // 值本身不参与渲染内容，仅作为高级区刷新与自动展开的信号
  const [validationAttempt, setValidationAttempt] = useState(0);
  // [契约] 提交入口统一收口，回车与保存按钮两条路径都汇到这里
  // 必须 await 后再判真假：onCommit 是异步的，提前判断会把待定 Promise 当成成功
  // 不在本地维护 submitting 状态，防重复提交由上层 saving 与按钮禁用负责
  // 返回假值时只递增校验计数，不在这里弹提示，避免与上层错误反馈重复出现
  // 输入法组合中的回车已在键盘处理器里拦掉，此处不再重复判组合态
  const commit = async () => {
    const result = await onCommit();
    if (!result) setValidationAttempt((value) => value + 1);
  };
  // 用 useId 而非固定字符串，同页多开对话框时 label 与输入框不会串号
  // id 必须同时交给 ModelConfigInputLabel 的 htmlFor，缺一边可访问性就断了
  // 不要换成随机值或数组下标：并发渲染下 id 需要稳定，否则标签指向会失效
  // 两个字段各自一个 id，共用会让点上下文标签时聚焦到最大输出
  // 这行必须位于任何 early return 之前，否则 hooks 顺序会被打乱
  const contextWindowInputId = useId();
  const maxOutputInputId = useId();
  // [权衡] 判定写成不等于假，是为了兼容旧草稿缺字段的情况
  // 缺字段时按开启智能配置处理，与新建模型的默认体验保持一致
  // 若改成严格等真，历史草稿一打开就显示关闭，覆盖值看起来全被改过
  // 这个名字是语义别名，不要把 smart 直接透传给子组件，子组件要的是覆盖集合
  // 开关本身由 ModelSmartConfigSwitch 回写 useRecommendedConfigValue，二者不要各存一份
  const smart = draft.useRecommendedConfigValue !== false;
  // [并发] 非 smart 时每次渲染新建空集合，引用变化会让下游 memo 失效
  // 这是有意为之：关闭推荐后覆盖状态必须整体清空，不能复用上一次的集合
  // 不要改成模块级常量，否则一个对话框的覆盖会漏到另一个对话框
  // smart 时直接透传上层集合，保证勾选与取消在同一帧反映到所有子组件
  // 多模态与推理分组拿到的是同一引用，改名或过滤前先确认没有就地修改它
  const activeOverrides = smart ? overrideFields : new Set<string>();
  // [契约] 覆盖判定是双通道：智能模式看实时勾选，手动模式看个人配置是否存在
  // legacy 由调用点现算传入，避免把 personalConfig 的结构耦合进这个闭包
  // 返回值同时喂给 className 与 data 属性，任何一处传参不同步都会造成高亮错位
  // 非 smart 时集合为空但仍需看 legacy，否则手动模式的覆盖标记会全部消失
  // 这里只回答是否覆盖，不判断能否重置；可重置性由上层与恢复按钮决定
  const overridden = (field: string, legacy = false) =>
    smart && (activeOverrides ? activeOverrides.has(field) : legacy);
  // 触发按钮的无障碍名称与 title 共用同一份文案，保证悬停提示与读屏一致
  // 提前取值而不是在 JSX 里内联，避免同一文案在渲染期间重复翻译
  // 该变量只在 edit 模式的触发按钮里使用，add 模式不渲染触发器
  // 即使 add 模式用不到，也保持这行无条件取值，让两种模式的渲染结构尽量一致
  // 如需给 add 模式换图标，应新增变量复用这份文案，不要改写它
  const editModelLabel = intl.formatMessage({
    id: "settings.modelProvider.editModel",
  });
  // 新增模型时模型 ID 为空，如果沿用编辑态的上下文窗口自动聚焦，会让用户先落到默认数值字段。
  // 编辑态仍保留上下文窗口自动聚焦和选中，方便直接修改已有模型配置。
  // [契约] 新增态自动聚焦模型 ID，编辑态自动聚焦上下文窗口，二者必须互斥
  // 自动聚焦通过 autoFocus 属性下发，只在挂载时生效，切换模式需要重新挂载对话框
  // 两个布尔不能同时为真，同时为真时浏览器只认第一个，实际焦点不可预期
  // 编辑态聚焦上下文窗口，是为了让改数值这条高频路径少一次点击
  // 新增态先落 ID 是因为初始为空，先落数值字段会让人误以为模型已选中
  const shouldFocusModelIdInput = mode === "add";
  const shouldFocusContextWindowInput = mode === "edit";
  // [失败路径] 加载指示只在新增且智能配置开启时出现，编辑态沿用已有配置不显示
  // 推荐值解析未完成时最大输出仍可编辑，只是标为忙碌并给出无障碍状态
  // 不要再与 saving 相与，否则保存期间会出现第二个转圈，与页脚状态重复
  // 该标记同时驱动 aria-busy，移除后读屏用户无法感知后台仍在解析
  // 解析失败会回落为无 placeholder，不会锁死输入框，这条退化路径必须保留
  const addModelConfigResolutionPending = smart && modelConfigResolutionPending;
  // [并发] 用 ref 而不是 state 记录输入法组合态，避免每次按键都触发重渲染
  // ref 不参与渲染，读写都在事件回调里，值过期也不会造成视图不一致
  // 必须与开始、结束两个回调成对置位，中途丢一次结束会让回车提交永久失效
  // 初值取假，极端情况下事件顺序颠倒也只是多提交一次，不会崩溃
  // 不要提升为共享状态，组合态天然是单输入框、单次按键级别的信息
  const compositionActiveRef = useRef(false);
  // [契约] 只有回车被接管，其余按键原样放行，不拦截 Esc 与 Tab
  // 不调用 stopPropagation，否则对话框的 Esc 关闭与焦点环循环会失灵
  // 阻止默认行为是为了避免回车触发宿主表单提交或换行
  // 提交用 void commit() 不等待结果，避免键盘处理器退化成异步函数
  // ID 与两个数值输入框共用这一处理器，行为差异只由是否禁用与只读决定
  const handleTechnicalInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    // 输入法候选确认也会发出 Enter。某些 Electron/macOS 版本的
    // nativeEvent.isComposing 会过早恢复 false，因此同时保留本地 composition 状态。
    if (
      isImeComposingKeyEvent({
        compositionActive: compositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      return;
    }
    // [权衡] 只在确认非组合态之后才拦截，顺序反过来会吞掉输入法确认键
    // preventDefault 只影响回车的默认行为，不改输入值，因此可安全放在提交之前
    // 确认键被拦后仍会返回组合判定分支，候选词正常上屏，不会漏字
    // 若后续要支持组合键换行，应在此处加修饰键判断，而不是把这行移走
    // 拦截范围要尽量小，多拦一个键位就可能破坏宿主环境的快捷键
    event.preventDefault();
    void commit();
  };
  // [并发] 开始与结束两个回调只维护同一个 ref，不附加任何其他副作用
  // 开始组合即置真、结束即置假，中间不读 draft，避免读到半成品输入
  // 部分 Electron 版本会过早把原生组合标记复位，所以本地标记才是主要判据
  // 不要在这里调用变更回调或格式化，否则中文输入会逐字抖动
  // 组合期间输入框的值仍由 draft 驱动，二者互不干扰
  const handleCompositionStart = () => {
    compositionActiveRef.current = true;
  };
  const handleCompositionEnd = () => {
    compositionActiveRef.current = false;
  };
  // [契约] 最大输出依赖模型已定：新增态必须填了模型 ID 才允许编辑
  // 只对 add 生效，编辑态即使 ID 只读也必须允许改最大输出
  // 判空用 trim，纯空格不算有效 ID，避免提交时才报错
  // 选择禁用而非隐藏，用户能预判字段存在，只是当前不可填
  // 解除禁用唯一路径是 ID 变化，不要额外加超时或轮询兜底
  const maxOutputTokensInputDisabled = mode === "add" && !draft.idValue.trim();
  // [契约] 渲染顺序即字段顺序：基础、上下文、最大输出，高级区折叠在下方
  // 高级区由 ModelEditorAdvanced 承载，错误定位依赖 validationAttempt 传参
  // 正文容器独立滚动，页脚与反馈条不随内容滚动移出视口
  // 这里不做条件包裹，模式差异全部收敛在上面的常量与属性里
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {mode === "edit" ? (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 p-0"
            aria-label={editModelLabel}
            title={editModelLabel}
          >
            <Pencil className="size-3.5 text-foreground-subtle" />
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        // overflow-hidden 仍允许聚焦触发外层滚动；语言换行后曾滚走标题。仅正文滚动，外框只裁切。
        className="max-h-[min(48rem,calc(100vh-4rem))] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-clip"
        data-no-model-drag="true"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {intl.formatMessage({
              id:
                mode === "add"
                  ? "settings.modelProvider.addModel"
                  : "settings.modelProvider.editModel",
            })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({
              id: "settings.modelProvider.editModelDescription",
            })}
          </DialogDescription>
          <ModelSmartConfigSwitch
            disabled={saving}
            checked={smart}
            onChange={(useRecommendedConfigValue) => onDraftChange({ useRecommendedConfigValue })}
          />
        </DialogHeader>
        {/* 保存期间锁定正文交互，不改变原有滚动容器；页脚单独显示提交状态。 */}
        <div
          inert={saving}
          className="min-h-0 min-w-0 -mr-3 space-y-4 overflow-y-auto pr-4"
          data-model-settings-scroll="true"
        >
          <ModelSettingsGroup group="basic">
            <div data-model-identity-row="true" className="flex flex-col gap-4">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.modelId" })}
                </label>
                <Input
                  {...TECHNICAL_INPUT_ATTRIBUTES}
                  type="text"
                  autoFocus={shouldFocusModelIdInput}
                  size="lg"
                  className={cn("font-mono", modelEditorControlStyle(false))}
                  readOnly={modelIdReadOnly}
                  value={draft.idValue}
                  placeholder={intl.formatMessage({
                    id: "settings.modelProvider.modelId",
                  })}
                  onChange={(event) => {
                    onDraftChange({ idValue: event.target.value });
                  }}
                  onBlur={onModelIdBlur}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onKeyDown={handleTechnicalInputKeyDown}
                />
              </div>
            </div>
          </ModelSettingsGroup>
          <ModelSettingsGroup group="tokens">
            <div className="space-y-3">
              <div>
                <div className="mb-1 block text-ui-base text-foreground-subtle">
                  <ModelConfigInputLabel field="contextWindow" htmlFor={contextWindowInputId} />
                </div>
                <Input
                  {...TECHNICAL_INPUT_ATTRIBUTES}
                  id={contextWindowInputId}
                  type="text"
                  autoFocus={shouldFocusContextWindowInput}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  size="lg"
                  value={draft.contextWindowValue}
                  data-personal-override={overridden(
                    "contextWindowValue",
                    personalConfig?.properties?.contextWindow !== undefined,
                  )}
                  className={modelEditorControlStyle(
                    overridden(
                      "contextWindowValue",
                      personalConfig?.properties?.contextWindow !== undefined,
                    ),
                  )}
                  placeholder={
                    draft.useRecommendedConfigValue === false ||
                    inheritedConfig?.properties?.contextWindow === undefined
                      ? undefined
                      : String(inheritedConfig.properties.contextWindow)
                  }
                  onChange={(event) => {
                    onDraftChange({ contextWindowValue: event.target.value });
                  }}
                  onFocus={selectFocusedInputText}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onKeyDown={handleTechnicalInputKeyDown}
                />
              </div>
            </div>
          </ModelSettingsGroup>
          <ModelSettingsGroup group="tokens">
            <div className="space-y-3">
              <div data-model-max-output="true">
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-ui-base text-foreground-subtle">
                    <ModelConfigInputLabel field="maxOutputTokens" htmlFor={maxOutputInputId} />
                  </div>
                  {addModelConfigResolutionPending ? (
                    <span
                      className="inline-flex shrink-0 items-center text-foreground-subtlest"
                      role="status"
                    >
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                      <span className="sr-only">
                        {intl.formatMessage({ id: "common.loading" })}
                      </span>
                    </span>
                  ) : null}
                </div>
                <Input
                  {...TECHNICAL_INPUT_ATTRIBUTES}
                  id={maxOutputInputId}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  size="lg"
                  value={draft.maxOutputTokensValue}
                  data-personal-override={overridden(
                    "maxOutputTokensValue",
                    personalConfig?.optionSpecs?.maxOutputTokens?.max !== undefined,
                  )}
                  className={modelEditorControlStyle(
                    overridden(
                      "maxOutputTokensValue",
                      personalConfig?.optionSpecs?.maxOutputTokens?.max !== undefined,
                    ),
                  )}
                  placeholder={
                    draft.useRecommendedConfigValue === false ||
                    inheritedConfig?.optionSpecs?.maxOutputTokens?.max === undefined
                      ? undefined
                      : String(inheritedConfig.optionSpecs.maxOutputTokens.max)
                  }
                  disabled={maxOutputTokensInputDisabled}
                  aria-label={intl.formatMessage({
                    id: "settings.modelProvider.maxOutputTokens",
                  })}
                  aria-busy={addModelConfigResolutionPending}
                  onChange={(event) => onDraftChange({ maxOutputTokensValue: event.target.value })}
                  onFocus={selectFocusedInputText}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onKeyDown={handleTechnicalInputKeyDown}
                />
              </div>
            </div>
          </ModelSettingsGroup>
          <ModelEditorAdvanced
            open={open}
            errorField={draftErrorField}
            validationAttempt={validationAttempt}
          >
            <ModelSettingsGroup group="modalities">
              <div className="space-y-3">
                <div>
                  <div className="mb-1 block text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.inputModalities" })}
                    <ModelConfigHelp field="inputModalities" />
                  </div>
                  <ProviderModelInputModalityOptions
                    value={draft.inputFormatValue}
                    onChange={(inputFormatValue) => onDraftChange({ inputFormatValue })}
                    personalValue={personalConfig?.properties?.inputFormat}
                    overrideFields={activeOverrides}
                  />
                </div>
              </div>
            </ModelSettingsGroup>
            <ModelSettingsGroup group="capabilities">
              <div>
                <div
                  className="mb-1 block text-ui-base text-foreground-subtle"
                  data-model-capabilities-label="true"
                >
                  {intl.formatMessage({ id: "settings.modelProvider.capabilities" })}
                  <ModelConfigHelp field="capabilities" />
                </div>
                <div className="flex flex-wrap gap-2" data-model-capabilities-options="true">
                  {(
                    [
                      "supportsJsonSchemaOutput",
                      "supportsNativeWebSearch",
                      "supportsMidConversationSystem",
                    ] as const
                  ).map((property) => {
                    const field = `${property}Value` as const;
                    return (
                      <BooleanModelOption
                        key={property}
                        label={intl.formatMessage({ id: `settings.modelProvider.${property}` })}
                        selected={draft[field] ?? false}
                        onToggle={() => onDraftChange({ [field]: !(draft[field] ?? false) })}
                        overridden={overridden(
                          field,
                          personalConfig?.properties?.[property] !== undefined,
                        )}
                      />
                    );
                  })}
                </div>
              </div>
            </ModelSettingsGroup>
            <ProviderModelReasoningSettings
              draft={draft}
              personalConfig={personalConfig}
              overrideFields={activeOverrides}
              inheritedConfig={inheritedConfig}
              onDraftChange={onDraftChange}
            />
          </ModelEditorAdvanced>
        </div>
        <ModelConfigDraftFeedback error={draftErrorMessage} matched={modelDefaultsLoaded} />
        <ProviderModelMetadataDialogActions
          leadingAction={<ModelConfigRestoreButton disabled={saving} onRestore={onRestore} />}
          saveLabel={intl.formatMessage({ id: "common.save" })}
          cancelLabel={intl.formatMessage({ id: "common.cancel" })}
          saving={saving}
          onSave={() => void commit()}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
