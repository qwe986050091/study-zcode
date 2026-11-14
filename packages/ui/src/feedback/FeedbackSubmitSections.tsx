// INV-01 描述区保持受控渲染；守住位置：value 与 onChange 直通 Textarea；改错故障：组件内复制草稿，界面与提交内容分叉。
// INV-02 max 是唯一上限来源；守住位置：maxLength 与计数器读同一个 prop；改错故障：计数与真实截断不一致，用户看到能输却输不进去。
// INV-03 描述框保留必填语义；守住位置：required 与 aria-required 成对出现在 Textarea；改错故障：屏幕阅读器不再播报必填，无障碍回归。
// INV-04 输入框宽度锁定并允许长词换行；守住位置：field-sizing-fixed 与 break-words 同时保留；改错故障：长文本撑宽弹窗，整窗横向溢出。
// INV-05 自动聚焦依赖挂载即渲染；守住位置：autoFocus 直接声明在 Textarea 上；改错故障：外层改条件挂载后焦点不落位，必须手动点击才能输入。
// INV-06 联系方式输入即持久化；守住位置：onChange 内调用记忆函数并回传其返回值；改错故障：只在提交成功时保存，失败或关窗即丢记忆。
// INV-07 联系方式保持可选；守住位置：本组件不做必填校验与拦截；改错故障：这里加校验会把可选字段变成必填，提交按钮无故禁用。
// INV-08 日志开关为纯受控展示件；守住位置：checked 与 onCheckedChange 全部来自 props；改错故障：内部自持开关状态，与服务端真值漂移。
// INV-09 日志开关保留固定测试标识；守住位置：TID_FEEDBACK_LOGS_OPT_IN 绑在 Switch 上；改错故障：E2E 定位失效，日志授权链路无法回归。
// INV-10 进度区需双条件同时成立；守住位置：提交中且进度状态非空才渲染；改错故障：单条件渲染导致进度空档期出现空白闪动。
// INV-11 进度区出现时才追加顶部间距；守住位置：cn 内按同一双条件追加外边距；改错故障：无条件加间距，无进度时按钮组整体下移。
// INV-12 查看工单按钮仅在提交中禁用；守住位置：disabled 只接 submitting；改错故障：误接提交禁用条件会在表单不完整时锁死历史工单入口。
// INV-13 取消按钮在提交阶段仍可用；守住位置：onCancel 不接 disabled；改错故障：加禁用后用户无法中止等待，只能强关弹窗。
// INV-14 提交回调显式丢弃 Promise；守住位置：点击回调里用 void 包裹 onSubmit；改错故障：出现未处理拒绝，错误只落在控制台。
// INV-15 提交禁用条件由父级统一裁决；守住位置：组件只把 submitDisabled 透传给提交按钮；改错故障：组件内再算一遍，规则分叉出现可点却无效。
// INV-16 提交中按钮内容整体切换；守住位置：submitting 三元同时覆盖 spinner 与文案两条分支；改错故障：只换文案不换图标，用户重复点击。
// INV-17 面向用户的文案全部走 formatMessage；守住位置：文件内不出现硬编码的界面中英文串；改错故障：多语言环境下弹窗出现混排语言。
// INV-18 本文件不访问服务、store 与平台接口；守住位置：依赖只有 props 与纯组件；改错故障：引入数据获取后组件不可复用，测试需搭全局环境。
//
// 模块职责：反馈提交弹窗的纯展示组件集合，负责描述、联系方式、日志开关与底部操作区的渲染和可访问性属性。
// 状态所有权：表单值、提交进度与禁用条件全部由父级持有，本文件只透传 props 并调用注入的格式化函数。
// 阅读顺序：先看四个导出组件的 props 契约，再看 SubmitFooter 的状态分支，最后看 Section、Field、Counter 三个布局原子。
import { TID_FEEDBACK_LOGS_OPT_IN } from "@zcode/shared/test-ids";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { SubmitProgressView } from "@/feedback/FeedbackSubmitProgressView.js";
import { RequiredMarker } from "@/feedback/feedbackBadges.js";
import { rememberFeedbackContactInput } from "@/feedback/feedbackContactPreference.js";
import type { FeedbackSubmissionProgressState } from "@/feedback/feedbackSubmissionJob.js";
import { InboxIcon } from "lucide-react";

// 本模块是反馈弹窗的纯展示层，只接收 props 与格式化函数，不读取 store 或服务
// 四个导出组件分别对应描述、联系方式、日志开关、底部操作区，其余为内部布局原子
// 所有表单值由父级持有，这里不建副本；一旦在此缓存 value，界面就会与提交内容不一致
// 新增区块时优先复用 Section 与 Field，避免各弹窗自定义间距导致视觉节奏漂移
export function DescriptionSection({
  value,
  max,
  onChange,
  formatMessage,
}: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  formatMessage: (id: string) => string;
}) {
  return (
    <Section
      title={
        <>
          <RequiredMarker />
          {formatMessage("feedback.submit.simple.descriptionTitle")}
        </>
      }
      right={<Counter value={value.length} max={max} />}
    >
      <Field>
        <Textarea
          autoFocus
          required
          aria-required="true"
          aria-label={formatMessage("feedback.submit.simple.descriptionTitle")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={5}
          maxLength={max}
          placeholder={formatMessage("feedback.submit.simple.descriptionPlaceholder")}
          // Textarea 默认的 field-sizing-content 会让无换行长文本撑大输入框宽度。
          // 反馈弹窗宽度固定，这里切到固定尺寸并允许长词换行，避免整窗横向溢出。
          className="field-sizing-fixed h-[136px] max-h-[136px] min-w-0 max-w-full resize-none overflow-y-auto rounded-xl border-input-border bg-input text-ui-base leading-6 whitespace-pre-wrap break-words text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        />
      </Field>
    </Section>
  );
}

// 联系方式是可选字段，组件本身不做必填校验，是否拦截由父级在提交前决定
// 输入即写入偏好，把记忆时机从提交成功提前到每次按键，失败或关窗都不丢内容
// 代价是每次输入都触发一次持久化，换来的是重开弹窗自动回填的稳定体验
// 若改回提交成功再存，用户遇到网络失败后重开只会看到空输入框，属于体验回退
export function ContactSection({
  value,
  max,
  onChange,
  formatMessage,
}: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  formatMessage: (id: string) => string;
}) {
  return (
    <Section title={formatMessage("feedback.submit.simple.contactTitle")}>
      <Field>
        <Input
          type="text"
          inputMode="email"
          autoComplete="email"
          value={value}
          // 这里包一层再回传，是为了在向上冒泡前完成记忆写入，两个步骤的顺序不能调换
          // 记忆写入必须与输入同步发生，改到提交时统一处理会漏掉中途关闭弹窗的用户
          // 改错故障：丢弃记忆函数的返回值，界面看似正常但下次不再回填
          onChange={(event) => {
            // 联系方式是可选项，但用户一旦填过就希望下次自动带出。
            // 这里随输入实时持久化，不再依赖提交成功，避免网络失败或用户关闭弹窗导致记忆丢失。
            onChange(rememberFeedbackContactInput(event.target.value));
          }}
          maxLength={max}
          placeholder={formatMessage("feedback.submit.contact.placeholder")}
          className="h-10 rounded-xl border-input-border bg-input px-3 text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        />
      </Field>
    </Section>
  );
}

export function LogUploadToggle({
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-ui-base font-medium text-foreground">{label}</span>
        <Switch
          data-testid={TID_FEEDBACK_LOGS_OPT_IN}
          aria-label={label}
          size="sm"
          checked={checked}
          onCheckedChange={onCheckedChange}
          className="shrink-0"
        />
      </div>
      <span className="block text-ui-sm leading-5 text-foreground-subtle">{hint}</span>
    </div>
  );
}

// 底部操作区只负责渲染三种可见状态：进度视图、提交中 spinner、默认文案
// submitting 与 submitProgress 分开传入，是因为进度可能尚未就绪，不能合并成一个判断
// submitDisabled 由父级计算，组件不自行业务校验，避免表单规则在两处分叉
// 容器固定不收缩，保证长内容滚动时按钮区始终完整可见
export function SubmitFooter({
  submitting,
  submitProgress,
  submitDisabled,
  onCancel,
  onViewTickets,
  onSubmit,
  formatMessage,
}: {
  submitting: boolean;
  submitProgress: FeedbackSubmissionProgressState | null;
  submitDisabled: boolean;
  onCancel: () => void;
  onViewTickets: () => void;
  onSubmit: () => void;
  formatMessage: (id: string) => string;
}) {
  return (
    <div className="shrink-0 px-6 pb-6 pt-2">
      {submitting && submitProgress ? (
        <SubmitProgressView
          progress={submitProgress}
          processingLabel={formatMessage("feedback.submit.processing")}
        />
      ) : null}
      <div
        className={cn(
          "flex items-center justify-between gap-3",
          submitting && submitProgress ? "mt-2.5" : "",
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onViewTickets}
          disabled={submitting}
          className="min-w-0 justify-start rounded-lg text-foreground-subtle hover:text-foreground"
        >
          <InboxIcon className="size-4 shrink-0" />
          <span className="truncate">{formatMessage("feedback.center.ticketsTitle")}</span>
        </Button>
        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {formatMessage("common.cancel")}
          </Button>
          <Button
            size="lg"
            // onSubmit 返回 Promise，这里显式用 void 丢弃，避免未处理拒绝污染控制台
            // 不要改成直接传函数引用，点击事件对象会被当成参数进入提交函数
            // 按钮是否可点完全依赖 submitDisabled，组件内不再叠加时间窗口判断
            onClick={() => void onSubmit()}
            disabled={submitDisabled}
            className="rounded-lg"
          >
            {submitting ? (
              <>
                <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                {formatMessage("feedback.submit.submitting")}
              </>
            ) : (
              formatMessage("feedback.submit.submit")
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Section 只提供标题行与内容槽，不感知表单语义，便于描述区与其他区块复用
// 右侧插槽用于放计数器等辅助信息，不允许塞入可交互的主操作
// 标题保持三级标题，改写层级会破坏弹窗内的文档大纲
// 固定纵向间距决定标题与内容的节奏，单独覆盖单块会显得疏密不一
export function Section({
  title,
  right,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-base font-semibold text-foreground">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

// Field 统一处理可选的右侧槽与纵向间距，避免各调用点各写一层包装
// 右侧为空时整行不渲染，保持空态下不产生多余间距
// 改错故障：无条件渲染右侧槽，没有计数器的区块会多出一条空白行
function Field({ right, children }: { right?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {right ? <div className="flex items-center justify-end gap-2">{right}</div> : null}
      {children}
    </div>
  );
}

// 计数直接用当前长度与上限比较，不在这里重新截断，截断由输入框的 maxLength 负责
// 超限只切换文字颜色，不阻断输入，避免用户粘贴长文时内容被静默改写
// 数字使用等宽字形，计数变化时标题行不会左右抖动
function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span
      className={cn(
        "text-ui-xs tabular-nums",
        value > max ? "text-destructive" : "text-foreground-subtle",
      )}
    >
      {value}/{max}
    </span>
  );
}
