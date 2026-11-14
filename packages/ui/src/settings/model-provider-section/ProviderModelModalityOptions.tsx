// INV-01 可见模态固定四项：守住位置 INPUT_MODALITY_OPTIONS；改错故障 设置页出现没有附件入口的选项。
// INV-02 audio 只在 Draft 中保留不进入 UI：守住位置 常量注释约定；改错故障 用户开启后却无法真正使用。
// INV-03 text 恒为选中且不可关闭：守住位置 disabled 判断与 selected 兜底；改错故障 模型被配置成不接受纯文本。
// INV-04 切换其他模态时必须把 supportsText 置真：守住位置 onChange 的展开；改错故障 顺手把 text 关掉。
// INV-05 覆盖标记只对非 text 生效：守住位置 overridden 的取反；改错故障 text 永远显示被覆盖。
// INV-06 覆盖来源二选一：overrideFields 优先于 personalValue；改错故障 两套状态各说各话。
// INV-07 字段映射与选项表必须同步：守住位置 INPUT_MODALITY_FIELDS 的 satisfies；改错故障 新增模态没有对应字段。
// INV-08 禁用按钮保持不透明：守住位置 disabled 透明度类；改错故障 锁定项在深色下看不清。
// INV-09 锁定图标只在禁用时出现：守住位置 条件渲染；改错故障 普通选项也显示锁。
// INV-10 aria-pressed 反映真实选中：守住位置 Button 属性；改错故障 读屏软件读不出开关状态。
// INV-11 组件完全受控：守住位置 无本地 state；改错故障 草稿与表单显示不一致。
// INV-12 key 用模态名：守住位置 map 的 key；改错故障 顺序调整后节点重建。
// INV-13 文案 key 由模态名拼接：守住位置 formatMessage；改错故障 新增模态直接显示原始 key。
//
// 模块职责：模型输入模态的多选按钮组，支持个人覆盖标记。
// 阅读顺序：先看选项表与字段映射，再看禁用与覆盖判定，最后看切换时的字段更新。
import { LockKeyholeIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderModelInputFormatDraft } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { modelEditorControlStyle } from "@/settings/model-provider-section/modelEditorControlStyle.js";
import { ModelOptionCheckbox } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";

// PDF 已经是正式的模型输入事实和可执行附件能力，旧列表漏掉它后用户无法修正该事实。
// Audio 仍没有设置页附件入口，因此继续只在 Draft 中无损保留。
// 这四个是当前有附件入口的模态，顺序即展示顺序。
// pdf 曾经漏掉，导致用户无法修正输入事实，不要按旧版删回三项。
// audio 只在草稿里无损保留，加进这里之前必须先有入口。
const INPUT_MODALITY_OPTIONS = ["text", "image", "video", "pdf"] as const;

const INPUT_MODALITY_FIELDS = {
  image: "supportsImage",
  video: "supportsVideo",
  pdf: "supportsPdf",
} as const satisfies Record<Exclude<(typeof INPUT_MODALITY_OPTIONS)[number], "text">, string>;

type VisibleModelFormat = (typeof INPUT_MODALITY_OPTIONS)[number];
type ProviderModelInputFormatOverlay = Partial<
  Record<keyof ProviderModelInputFormatDraft, boolean | null>
>;

// 单项按钮只负责展示与回调，选中状态完全由外部传入。
// overridden 只影响边框与配色，不改变可点击性。
// `disabled` 时仍保留完整不透明度，锁定状态改由图标表达而不是变淡。
function ModalityOption({
  modality,
  selected,
  disabled = false,
  overridden = false,
  onToggle,
}: {
  modality: VisibleModelFormat;
  selected: boolean;
  disabled?: boolean;
  overridden?: boolean;
  onToggle?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      aria-pressed={selected}
      disabled={disabled}
      data-selected={selected}
      data-personal-override={overridden}
      data-model-input-modality={modality}
      className={cn(
        "gap-2 px-3 disabled:opacity-100",
        modelEditorControlStyle(overridden, selected),
      )}
      onClick={onToggle}
    >
      <ModelOptionCheckbox selected={selected} />
      <span>{intl.formatMessage({ id: `settings.modelProvider.modality.${modality}` })}</span>
      {disabled ? (
        <LockKeyholeIcon
          className="size-3.5 shrink-0 text-foreground-subtle"
          aria-hidden="true"
          data-model-modality-lock="true"
        />
      ) : null}
    </Button>
  );
}

export function ProviderModelInputModalityOptions({
  value,
  onChange,
  personalValue,
  overrideFields,
}: {
  value: ProviderModelInputFormatDraft;
  onChange: (value: ProviderModelInputFormatDraft) => void;
  personalValue?: ProviderModelInputFormatOverlay | null;
  overrideFields?: ReadonlySet<string>;
}) {
  // 把草稿字段摊平成以模态名为键的表，避免循环里做 switch。
  // 四个键必须与选项表一一对应，新增模态要同时补这里。
  // 这里只读 value，不读取个人覆盖值。
  const selected = {
    text: value.supportsText,
    image: value.supportsImage,
    video: value.supportsVideo,
    pdf: value.supportsPdf,
  };
  return (
    <div className="flex flex-wrap gap-2">
      {INPUT_MODALITY_OPTIONS.map((modality) => {
        // text 是模型的基本能力，不允许在设置页关闭。
        // 禁用项仍按选中渲染，避免视觉上出现「未选中的基本能力」。
        // 覆盖判定优先看字段集合，没有集合时回退到个人值是否存在。
        // overrideFields 是当前编辑上下文的权威来源，不能被个人值覆盖。
        const disabled = modality === "text";
        const field = disabled ? "supportsText" : INPUT_MODALITY_FIELDS[modality];
        const overridden =
          !disabled &&
          (overrideFields
            ? overrideFields.has(`inputFormatValue.${field}`)
            : personalValue?.[field] !== undefined);
        return (
          <div key={modality}>
            <ModalityOption
              modality={modality}
              selected={disabled || selected[modality]}
              disabled={disabled}
              overridden={overridden}
              // 切换时总是先把 supportsText 置真，再翻转目标字段。
              // `disabled` 时不传 `onToggle`，从渲染层杜绝被点开的可能。
              onToggle={
                disabled
                  ? undefined
                  : () => onChange({ ...value, supportsText: true, [field]: !value[field] })
              }
            />
          </div>
        );
      })}
    </div>
  );
}
