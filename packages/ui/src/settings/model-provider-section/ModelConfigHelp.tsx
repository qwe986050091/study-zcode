// INV-01 帮助按钮是 label 的兄弟不是子节点：守住位置 ModelConfigInputLabel 的 Fragment；改错故障 点帮助按钮触发输入聚焦。
// INV-02 htmlFor 必须指向调用方给的输入 id：守住位置 透传；改错故障 标签点不到输入框。
// INV-03 提示内容只来自定稿语言包：守住位置 两次 formatMessage；改错故障 用户输入被当成文案渲染。
// INV-04 只有鼠标悬停才自动开关：守住位置 pointerType 判断；改错故障 触摸设备点一下又立刻关掉。
// INV-05 点击阻止默认与冒泡：守住位置 onClick；改错故障 Radix 在已打开时反向关闭并触发相邻控件。
// INV-06 打开浮层不抢焦点：守住位置 两个 autoFocus 阻止；改错故障 键盘用户焦点被弹出内容吞掉。
// INV-07 浮层宽度与高度都设上限：守住位置 w-80 与 max-h；改错故障 小屏溢出、内容不可达。
// INV-08 段落按空行切分：守住位置 split 两个换行；改错故障 整段说明挤成一行。
// INV-09 以短横线开头才渲染列表：守住位置 startsWith 判断；改错故障 普通段落被拆成条目。
// INV-10 列表项去掉前两个字符再强调：守住位置 slice(2)；改错故障 条目里残留短横线。
// INV-11 强调只认加粗与行内代码：守住位置 emphasis 正则；改错故障 HTML 或链接被解释执行。
// INV-12 文案键由 field 拼成：守住位置 模板字符串；改错故障 新增字段忘记注册 help 文案后直接显示 key。
// INV-13 组件只受控于本地 open 状态：守住位置 useState；改错故障 浮层无法被 Esc 关闭。
//
// 模块职责：模型配置字段的标签与悬停帮助气泡。
// 阅读顺序：先看标签与按钮的相对结构，再看交互开关，最后看文案渲染。
import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type ModelConfigHelpField =
  | "contextWindow"
  | "maxOutputTokens"
  | "inputModalities"
  | "outputModalities"
  | "capabilities"
  | "reasoningLevelsOrdered"
  | "reasoningLevelMapping"
  | "advanced"
  | "followRecommendedConfig";

export function ModelConfigInputLabel({
  field,
  htmlFor,
}: {
  field: ModelConfigHelpField;
  htmlFor: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    // 帮助按钮必须是 label 的兄弟，避免抢走输入关联和标题点击焦点。
    <>
      <label htmlFor={htmlFor}>
        {intl.formatMessage({ id: `settings.modelProvider.${field}` })}
      </label>
      <ModelConfigHelp field={field} />
    </>
  );
}

export function ModelConfigHelp({ field }: { field: ModelConfigHelpField }) {
  const [open, setOpen] = useState(false);
  const { intl } = useZCodeIntl();
  // 标签与帮助标题共用同一个字段文案，避免两处写法不一致。
  // 帮助正文的 key 只多一段 help，新增字段必须同时补两条文案。
  const label = intl.formatMessage({ id: `settings.modelProvider.${field}` });
  const copy = intl.formatMessage({ id: `settings.modelProvider.help.${field}` });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="ml-1 size-6 align-middle text-foreground-subtle"
          data-model-help={field}
          aria-label={intl.formatMessage(
            { id: "settings.modelProvider.fieldHelp" },
            { field: label },
          )}
          // 只在鼠标指针下自动打开，触摸与手写笔交给点击处理。
          // 离开同样按指针类型过滤，避免触摸端反复开关。
          // 键盘用户通过 focus 打开，不依赖悬停。
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setOpen(false);
          }}
          onFocus={() => setOpen(true)}
          // `onMouseDown` 只拦焦点转移，不拦 click：按钮获得焦点会让相邻输入先失焦。
          // 阻止冒泡，避免外层表单控件被误触。
          // 点击总是打开而不是切换，关闭交给 Esc 或点击外部。
          onClick={(event) => {
            // 点击/触摸只打开说明；阻止 Radix 在已由 focus/hover 打开时反向关闭，不触发相邻表单控件。
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="tooltip"
        data-model-help-content={field}
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-80 max-w-[calc(100vw-1.5rem)] max-h-[min(28rem,calc(100vh-2rem))] overflow-y-auto p-3 text-ui-sm leading-relaxed"
      >
        <div className="space-y-2">
          {copy.split("\n\n").map((paragraph, index) =>
            paragraph.startsWith("- ") ? (
              <ul key={index} className="list-disc space-y-1 pl-4">
                {paragraph.split("\n").map((line, lineIndex) => (
                  <li key={lineIndex}>{emphasis(line.slice(2))}</li>
                ))}
              </ul>
            ) : (
              <p key={index} className="whitespace-pre-line">
                {emphasis(paragraph)}
              </p>
            ),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// 只呈现定稿语言包的加粗/行内代码，不解释 HTML、链接或用户输入。
// 只解析两种定稿标记：双星加粗与反引号行内代码。
// 正则带捕获组，split 后奇偶位置正好是标记片段。
// 纯文本原样返回，不解释 HTML、链接或用户输入。
// 这是渲染安全的边界，不要为方便引入 markdown 解析器。
function emphasis(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : part.startsWith("`") ? (
      <code key={index} className="font-mono">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}
