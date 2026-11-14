// INV-01 [状态] 本组件是受控展示层：权威视口尺寸与缩放比例只存在于 props，本文件不得保存第二份已提交值。
// INV-02 [状态] 宽度草稿、高度草稿与越界标记都是可丢弃的本地状态，父级回写时允许被覆盖。
// INV-03 [事务] 唯一提交口是 commitDraft；Enter 与失焦都必须汇入它，绕过它会跳过校验与去重。
// INV-04 [事务] 唯一写出口是 onViewportSizeChange 与 onZoomChange 两个回调，在此维护权威尺寸会与 Fit 回写互相覆盖。
// INV-05 [失败路径] 越界输入保留原草稿并只置位越界标记，不静默截断到边界值，否则用户无法分辨回写来源。
// INV-06 [失败路径] 越界文案统一由 getRangeError 与共享 limits 生成，本地手写数字会与 Agent 视口 schema 产生偏差。
// INV-07 [并发] 父级同步 effect 只依赖单个维度字段；依赖整个 viewportSize 会在另一维度变化时冲刷未提交草稿。
// INV-08 [并发] 提交只读当前渲染闭包中的草稿；改成延迟读取会让快速连续失焦与回车提交过期数值。
// INV-09 [权衡] 值未变化时走 resetDraft 并返回，不上抛无变化事件，避免父级重复写入、广播与多余渲染。
// INV-10 [资源] 错误浮层的 open 必须与 isVisible 相与，隐藏 tab 的触发器为 display:none，否则浮层会锚到 0×0 并泄漏到窗口左上角。
// INV-11 [失败路径] Enter 必须先阻止默认行为再提交，否则外层表单会把回车当成提交并触发第二次写入。
// INV-12 [状态] Escape 走 resetDraft 后主动失焦，确保草稿与越界标记同时回退，不留半截输入。
// INV-13 [权衡] 越界复检只在已处于越界状态时进行，避免用户输入过程中不断弹出提示。
// INV-14 [失败路径] 越界标记的两个维度必须显式初始化为 false，undefined 会让输入框一挂载就显示红框与告警。
// INV-15 [事务] 上抛尺寸时展开旧对象再覆盖单维度，保证另一维度透传；手写完整对象容易漏字段造成尺寸跳变。
// INV-16 [资源] 读屏告警用 sr-only 且仅在越界时挂载，避免常驻的实时区域反复播报。
// INV-17 [状态] 缩放选择为受控组件，选中回调只做字面量上抛，不在此保存本地镜像值。
// INV-18 [并发] 校验与区间读取为纯函数，不持有模块级可变状态；新增维度必须同时补齐两处分支，否则会静默落到高度区间。
//
// 模块职责：响应式视口工具条的受控展示层，把宽度与高度草稿校验后上抛，并提供缩放比例选择。
// 状态所有权：权威尺寸与缩放归父级；草稿、越界标记与错误浮层开关归本组件。
// 阅读顺序：先看维度校验与区间常量，再看提交、重置、按键三条写路径，最后看双输入与缩放选择的 JSX。
import { useEffect, useState, type KeyboardEvent } from "react";
import { BROWSER_VIEWPORT_LIMITS, type BrowserViewportSize } from "@zcode/shared";
import {
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_TOOLBAR,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_BROWSER_RESPONSIVE_ZOOM_OPTION,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
} from "@zcode/shared/test-ids";
import {
  BROWSER_VIEWPORT_ZOOM_OPTIONS,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 维度联合类型只允许宽度与高度两个字面量；新增维度必须同步补齐校验与区间两处分支。
// [权衡] 校验与区间读取拆成两个函数，但共用同一份共享协议常量，改一处上下界必须同步改另一处。
// 整型判定放在范围比较之前：小数输入先被拒绝，否则带小数的值会通过范围检查并被当作合法尺寸上抛。
// 宽度与高度走不同上下界分支；误把两分支合并成同一区间，横向尺寸会被纵向上限截断。
// [失败路径] 校验返回 false 的输入原样留在草稿里，由上层决定提示，不在此处静默截断。
// 区间函数的返回结构固定为 max 与 min 两个字段，错误文案与输入框属性都依赖这个形状。
// 区间上下界直接取自共享协议常量，不在本文件写死数字，避免 UI 与 Agent 视口 schema 漂移。
// [并发] 两个辅助函数都是纯函数，无模块级可变状态；若将来加缓存必须保证常量变更后不返回陈旧区间。
type ViewportDimension = "height" | "width";

function isValidViewportDimension(dimension: ViewportDimension, value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (dimension === "width") {
    return value >= BROWSER_VIEWPORT_LIMITS.minWidth && value <= BROWSER_VIEWPORT_LIMITS.maxWidth;
  }
  return value >= BROWSER_VIEWPORT_LIMITS.minHeight && value <= BROWSER_VIEWPORT_LIMITS.maxHeight;
}

function getViewportDimensionLimits(dimension: ViewportDimension): { max: number; min: number } {
  return dimension === "width"
    ? { max: BROWSER_VIEWPORT_LIMITS.maxWidth, min: BROWSER_VIEWPORT_LIMITS.minWidth }
    : { max: BROWSER_VIEWPORT_LIMITS.maxHeight, min: BROWSER_VIEWPORT_LIMITS.minHeight };
}

export function BrowserViewportToolbar({
  isVisible,
  onViewportSizeChange,
  onZoomChange,
  viewportSize,
  zoom,
}: {
  isVisible: boolean;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  onZoomChange: (zoom: BrowserViewportZoom) => void;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): React.JSX.Element {
  // intl 只用于文案格式化；此处不读取其他服务或平台实现，保持组件为纯展示层。
  // 三个状态只保存可丢弃的本地值：宽度草稿、高度草稿、按维度索引的越界标记。
  // 草稿初值由 props 的视口尺寸派生，这里不复制父级权威尺寸，父级更新后由下方同步 effect 回灌。
  // 越界标记把两个维度都显式初始化为 false，避免 undefined 被当作真值让输入框一挂载就报红。
  // [状态] 宽度同步 effect 依赖必须精确到单一字段；写成整个对象会在高度变化时清掉未提交的宽度草稿。
  // [状态] 高度同步 effect 同理，只依赖高度字段；合并成一个 effect 会让两个输入互相冲刷。
  // effect 内统一做字符串转换，保证草稿类型恒为字符串，受控值不会在数字与字符串之间跳变。
  // [失败路径] 父级回写与用户正在输入可能同时发生，effect 覆盖草稿是既定取舍：Fit 等外部变更优先。
  const { intl } = useZCodeIntl();
  const [widthDraft, setWidthDraft] = useState(String(viewportSize.width));
  const [heightDraft, setHeightDraft] = useState(String(viewportSize.height));
  const [invalidDrafts, setInvalidDrafts] = useState<Record<ViewportDimension, boolean>>({
    height: false,
    width: false,
  });

  useEffect(() => {
    setWidthDraft(String(viewportSize.width));
  }, [viewportSize.width]);

  useEffect(() => {
    setHeightDraft(String(viewportSize.height));
  }, [viewportSize.height]);

  // 越界标记写入用函数式更新并在值相同时返回原引用，避免每次按键都触发一次无意义的重渲染。
  // [权衡] 相同值短路依赖上一次状态比较；改成直接展开对象会让输入过程中出现额外渲染与浮层抖动。
  // 重置时先清越界标记再按维度回填草稿，顺序反了会出现一帧旧值加红框的不一致画面。
  // 宽度分支回填后立即返回，防止继续落到高度分支；漏掉 return 会让宽度重置顺带覆盖高度草稿。
  // 重置只读取 props 当前值而不读草稿，这样才是真正的丢弃本地输入。
  // [失败路径] 维度判定只认宽度与高度两个字面量，新增维度若不改这里会静默落到高度分支。
  // [资源] 两个草稿彼此独立，重置一个不应触发另一侧的 setState，否则 Escape 会连带清掉另一侧未提交输入。
  const setDraftInvalid = (dimension: ViewportDimension, invalid: boolean) => {
    setInvalidDrafts((previous) =>
      previous[dimension] === invalid ? previous : { ...previous, [dimension]: invalid },
    );
  };

  const resetDraft = (dimension: ViewportDimension) => {
    setDraftInvalid(dimension, false);
    if (dimension === "width") {
      setWidthDraft(String(viewportSize.width));
      return;
    }
    setHeightDraft(String(viewportSize.height));
  };

  // 提交唯一入口：Enter 与失焦两条路径都汇聚到这里，禁止另开一条直接上抛的写入路径。
  // 先按维度取草稿，再去空白转数字；空串会得到 0 并被范围校验拦下，因此不会误提交成零尺寸。
  // [失败路径] 越界时置位越界标记并原样保留草稿，不立即回填旧值；否则用户分不清是 Fit 回写还是自己超限。
  // 失败语义要与 Agent 视口 schema 一致：UI 只标记不纠正，由范围提示说明原因。
  // [事务] 值与父级当前值相等时必须走 resetDraft 并返回，不能上抛无变化事件，否则父级会重复写入与广播。
  // 上抛时用展开旧对象再覆盖单维度，保证另一维度原样透传；手写完整对象容易漏字段。
  // 成功路径先清除越界标记再决定是否上抛，确保用户修正后红框立即消失。
  // [并发] 提交只读当前闭包中的草稿与 props；改成异步读取后，快速连续的失焦与回车可能提交过期值。
  const commitDraft = (dimension: ViewportDimension) => {
    const draft = dimension === "width" ? widthDraft : heightDraft;
    const value = Number(draft.trim());
    if (!isValidViewportDimension(dimension, value)) {
      // 越界时直接恢复旧值会让用户无法判断是 Fit 回写还是输入超限。
      // 保留原始草稿并展示共享协议范围，让 UI 与 Agent viewport schema 的失败语义一致。
      setDraftInvalid(dimension, true);
      return;
    }
    setDraftInvalid(dimension, false);
    if (viewportSize[dimension] === value) {
      resetDraft(dimension);
      return;
    }
    onViewportSizeChange({ ...viewportSize, [dimension]: value });
  };

  // 输入变更只写入草稿，不做提交也不做截断；提交时机严格限定在 Enter 与失焦。
  // [失败路径] 只有在已处于越界状态时才实时复检，这样用户修正过程中红框能即时消失，又不会边打字边报错。
  // 越界复检同样走共享校验函数，避免在此复制一份范围判断而与提交逻辑产生分歧。
  // 范围文案通过 intl 统一格式化为带最小值与最大值的一句话，两个输入框共用同一个消息 id。
  // [权衡] 文案不在渲染时缓存，浮层与读屏告警各自格式化一次，换取与语言切换天然同步。
  // 按键处理只认 Enter 与 Escape，其余按键完全放行，不拦截输入法候选与方向键。
  // Enter 先阻止默认行为再提交，Escape 重置后主动失焦；漏掉前者会触发外层表单的第二次写入。
  const handleDraftChange = (dimension: ViewportDimension, value: string) => {
    if (dimension === "width") {
      setWidthDraft(value);
    } else {
      setHeightDraft(value);
    }
    if (invalidDrafts[dimension]) {
      setDraftInvalid(dimension, !isValidViewportDimension(dimension, Number(value.trim())));
    }
  };

  const getRangeError = (dimension: ViewportDimension) => {
    const limits = getViewportDimensionLimits(dimension);
    return intl.formatMessage(
      { id: "browser.responsive.dimensionRangeError" },
      { max: String(limits.max), min: String(limits.min) },
    );
  };

  const handleDimensionKeyDown = (
    dimension: ViewportDimension,
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitDraft(dimension);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetDraft(dimension);
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-center gap-1 overflow-x-auto border-y border-border bg-background px-2"
      data-testid={TID_BROWSER_RESPONSIVE_TOOLBAR}
    >
      {/* TooltipContent 通过 Portal 挂到 body；不可见 tab 的触发器处于 display:none，
          仍保持 open 会让浮层拿到 0×0 锚点并泄漏到窗口左上角。只在当前视图可见时展示。 */}
      <Tooltip open={isVisible && invalidDrafts.width}>
        <TooltipTrigger asChild>
          <Input
            aria-invalid={invalidDrafts.width || undefined}
            aria-label={intl.formatMessage({ id: "browser.responsive.width" })}
            className="h-7 w-14 shrink-0 border-transparent bg-transparent px-1 text-center font-sans text-ui-base font-medium tabular-nums hover:border-transparent hover:bg-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused aria-invalid:hover:border-destructive aria-invalid:focus-visible:border-destructive"
            data-testid={TID_BROWSER_RESPONSIVE_WIDTH_INPUT}
            inputMode="numeric"
            max={BROWSER_VIEWPORT_LIMITS.maxWidth}
            min={BROWSER_VIEWPORT_LIMITS.minWidth}
            onBlur={() => commitDraft("width")}
            onChange={(event) => handleDraftChange("width", event.target.value)}
            onKeyDown={(event) => handleDimensionKeyDown("width", event)}
            size="sm"
            spellCheck={false}
            value={widthDraft}
          />
        </TooltipTrigger>
        <TooltipContent
          align="center"
          className="border-destructive bg-popover text-destructive"
          side="bottom"
          sideOffset={4}
        >
          {getRangeError("width")}
        </TooltipContent>
      </Tooltip>
      {invalidDrafts.width ? (
        <span className="sr-only" role="alert">
          {getRangeError("width")}
        </span>
      ) : null}
      <span aria-hidden="true" className="shrink-0 text-ui-base text-foreground-subtle">
        ×
      </span>
      <Tooltip open={isVisible && invalidDrafts.height}>
        <TooltipTrigger asChild>
          <Input
            aria-invalid={invalidDrafts.height || undefined}
            aria-label={intl.formatMessage({ id: "browser.responsive.height" })}
            className="h-7 w-14 shrink-0 border-transparent bg-transparent px-1 text-center font-sans text-ui-base font-medium tabular-nums hover:border-transparent hover:bg-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused aria-invalid:hover:border-destructive aria-invalid:focus-visible:border-destructive"
            data-testid={TID_BROWSER_RESPONSIVE_HEIGHT_INPUT}
            inputMode="numeric"
            max={BROWSER_VIEWPORT_LIMITS.maxHeight}
            min={BROWSER_VIEWPORT_LIMITS.minHeight}
            onBlur={() => commitDraft("height")}
            onChange={(event) => handleDraftChange("height", event.target.value)}
            onKeyDown={(event) => handleDimensionKeyDown("height", event)}
            size="sm"
            spellCheck={false}
            value={heightDraft}
          />
        </TooltipTrigger>
        <TooltipContent
          align="center"
          className="border-destructive bg-popover text-destructive"
          side="bottom"
          sideOffset={4}
        >
          {getRangeError("height")}
        </TooltipContent>
      </Tooltip>
      {invalidDrafts.height ? (
        <span className="sr-only" role="alert">
          {getRangeError("height")}
        </span>
      ) : null}
      <Select value={zoom} onValueChange={(value) => onZoomChange(value as BrowserViewportZoom)}>
        <SelectTrigger
          aria-label={intl.formatMessage({ id: "browser.responsive.zoom" })}
          className="min-w-24 shrink-0 font-medium tabular-nums"
          data-testid={TID_BROWSER_RESPONSIVE_ZOOM_SELECT}
          size="default"
          variant="ghost"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {BROWSER_VIEWPORT_ZOOM_OPTIONS.map((option) => (
            <SelectItem
              data-testid={`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-${option}`}
              key={option}
              value={option}
            >
              {option === "fit"
                ? intl.formatMessage({ id: "browser.responsive.fitToWindow" })
                : `${option}%`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
