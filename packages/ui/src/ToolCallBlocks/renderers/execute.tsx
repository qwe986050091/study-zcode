// 执行类工具（execute / bash 终端）工具调用块的渲染层：把多形态入参归一成可展示的命令串，
// 再把 output / rawOutput / display / outputPreview 四路来源收敛成一段结果正文。
// 不负责进程启动、shell 语义与流式解析（属 runtime 侧），也不负责 Office 内嵌布局本身，只响应入参开关。
//
// INV-01 断言：摘要文本只会是去空后的字符串或 undefined，绝不返回对象或空串 —— 守住它的位置：getExecuteSecondaryText 的三类分支返回点 —— 改错故障：工具卡片首行出现 [object Object] 或一条高度塌陷的空行
// INV-02 断言：摘要里的命令取自「-lc」的下一项，且下一项必须非空才采用 —— 守住它的位置：getExecuteSecondaryText 的 shellCommandIndex 分支 —— 改错故障：摘要显示「bash -lc」这种半截提示，用户看不到真正执行的命令
// INV-03 断言：详情数组形态命中「-lc」时取其下一项，未命中时丢弃首项 shell 名后再拼接 —— 守住它的位置：getExecuteContentParts 的数组分支 —— 改错故障：展开区命令以 bash 开头或整体丢失首个真实参数，复制执行会失败
// INV-04 断言：shell 包装前缀只在整串匹配 zsh、bash、sh 加 -lc 时剥离 —— 守住它的位置：getExecuteContentParts 的 shellMatch 正则 —— 改错故障：命令正文里含「bash -lc」字样时被误裁剪，详情与真实执行的脚本不一致
// INV-05 断言：对象入参按 command、cmd、script、parsed_cmd 顺序递归下降，先命中先返回 —— 守住它的位置：getExecuteContentParts 的 record 分支 —— 改错故障：同一条命令在摘要与详情显示不同内容，用户对不上自己到底跑了什么
// INV-06 断言：parsed_cmd 逐项尝试直到拿到非空命令，不能只看首项 —— 守住它的位置：getExecuteContentParts 的 parsedCommand 循环 —— 改错故障：首项是占位对象时详情区命令为空，展开后看不到任何执行内容
// INV-07 断言：取首个字符串字段时遇到空串或非字符串要继续向后找，而不是就此收手 —— 守住它的位置：readFirstStringField 的 for 循环 —— 改错故障：output 字段为空时结果区一片空白，尽管 text 或 stdout 里明明有内容
// INV-08 断言：字符串输出用 trim 判空但返回原串，保留首尾空白与缩进 —— 守住它的位置：extractExecuteResultText 的字符串分支 —— 改错故障：日志与表格类输出缩进错位，复制出来的内容与终端里不一致
// INV-09 断言：数组输出逐项递归后以换行拼接，全部为空时返回 null 而不是空串 —— 守住它的位置：extractExecuteResultText 的数组分支 —— 改错故障：结果区渲染出一个空白卡片或空的代码高亮块，看起来像渲染失败
// INV-10 断言：只有 number、boolean、bigint 才转字符串，其余未知对象一律返回 null —— 守住它的位置：extractExecuteResultText 的标量兜底分支 —— 改错故障：退出码类标量输出显示为空，或函数与 Symbol 被渲染成不可读文本
// INV-11 断言：结果文本优先级固定为 display.output、output、raw.rawOutput，且用空值合并而非逻辑或 —— 守住它的位置：ExecuteToolCallBlock 的 resultText 赋值 —— 改错故障：协议校验过的完整输出被旧快照覆盖，或本应为空的输出回退成上一版文本
// INV-12 断言：两个展示态 schema 都用 safeParse，失败时静默降级为 undefined —— 守住它的位置：outputDisplay 与 outputPreview 两个 useMemo —— 改错故障：协议字段升级后旧快照触发异常，整块工具调用卡片白屏
// INV-13 断言：outputPreview 只在 isRunning 时解析，运行结束后必须交还给完整结果 —— 守住它的位置：outputPreview useMemo 的首行守卫 —— 改错故障：命令结束后仍显示最后几行流式预览，全文再也不出现
// INV-14 断言：failureVisibleText 只在 status 为 failed 时取值，errorText 优先于 resultText —— 守住它的位置：failureVisibleText 的三元表达式 —— 改错故障：成功卡片挂上历史错误描述，或失败卡片没有任何可见原因
// INV-15 断言：权限预览阶段详情区不渲染输出区域 —— 守住它的位置：renderContent 的 isPermissionPreview 分支 —— 改错故障：权限确认前就泄露上一次执行的输出或预览内容
// INV-16 断言：renderContent 的依赖数组覆盖它读取的每一个值 —— 守住它的位置：useCallback 的依赖数组 —— 改错故障：切换工具调用后仍渲染上一条命令的输出与状态，形成陈旧闭包
// INV-17 断言：Office 模式同时关闭折叠、强制展开、摘要文本与快照提示 —— 守住它的位置：ToolLayout 的 canToggle、forceOpen、secondaryText 与快照提示条件 —— 改错故障：内嵌视图里出现可点击的折叠箭头与无关的字段加载提示
//
import { ExecuteCommand } from "@/ToolCallBlocks/renderers/ExecuteCommand.js";
import {
  bashOutputDisplaySchema,
  executionOutputPreviewSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ExecuteOutput } from "@/ToolCallBlocks/renderers/ExecuteOutput.js";
import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// 图标元素在模块级只创建一次，被所有 execute 卡片共享；React 元素不可变，共享实例不会串状态。
// 看似可以改成工厂函数或直接内联进组件，但 ToolLayout 只读 className，内联会让每次渲染产出新的元素对象。
// 新元素对象会让 ToolLayout 的 props 浅比较失效，工具列表滚动时所有 execute 图标一起重新渲染，出现闪烁。
// 若要按运行状态换图标，应在这里按状态缓存，而不是在渲染期临时新建，否则正在执行的卡片会抖动。
// 该元素不带 ref 与事件处理器，因此跨卡片复用是安全的，不要为了所谓隔离而给它加 key。
const EXECUTE_TOOL_ICON = <SquareTerminalIcon className="size-4 shrink-0 text-foreground-subtle" />;

// 这里把 null 与数组都排除掉了，是整个文件唯一的形状判定入口。
// 不要简化成只判 typeof 为 object：数组同样会通过，后续按下标之外的键去读 command 会拿不到值，静默落到 parsed_cmd 分支。
// raw 与 rawOutput 两类字段既可能是对象也可能是数组，判定一放宽，extractExecuteResultText 就会走进错误分支。
// 该函数被当作类型守卫使用，返回 true 后 TypeScript 才允许下标读取，删掉类型谓词会连带出一串隐式 any。
// 它同时约束 raw.display 的解析入口：非普通对象直接跳过 schema 校验，既不抛错也不产生一次无意义的解析。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 摘要与详情共用同一套输入形态，但取值规则刻意不同：摘要要一行可读短串，详情要可复制的完整命令。
// 所以摘要里「-lc」之后取下一项，取不到就整串拼接；而详情里没有「-lc」时反而要丢掉首个 shell 名。
// 不要为了统一把两个函数合并：合并后要么摘要出现重复参数，要么详情丢掉脚本正文，两类症状都会出现在用户面前。
// 该函数被导出供列表摘要等外部场景复用，返回类型必须保持字符串或 undefined，不能改成对象。
// 任何新增入参形态都要同时补到这里与 getExecuteContentParts，否则收起态与展开态会显示两条不同的命令。
export function getExecuteSecondaryText(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    const parts = input.map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0) {
      return undefined;
    }

    // 摘要分支只有在「-lc」后面确实还有内容时才取下一项，索引越界则退回整串拼接。
    // 改成取索引下一项并空值合并到整串，会让只剩「-lc」的残缺输入显示成「bash -lc」这样的半截提示。
    // 这里必须是完全相等比较，不能改成包含判断：命令正文本身带 -lc 参数时会被错误截断。
    // 取到的只是摘要，不做引号还原，因此带空格的脚本会以数组元素原样呈现，这正是摘要想要的短形态。
    // 末尾的真值判断是第二道防线，去掉后空字符串会短路成空摘要，卡片高度随之塌陷。
    const shellCommandIndex = parts.findIndex((part) => part === "-lc");
    if (shellCommandIndex >= 0 && parts[shellCommandIndex + 1]) {
      return parts[shellCommandIndex + 1];
    }

    return parts.join(" ");
  }

  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const parsedCommand = record.parsed_cmd;
  if (Array.isArray(parsedCommand)) {
    for (const item of parsedCommand) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
        continue;
      }

      if (typeof item !== "object" || item === null) {
        continue;
      }

      const parsedRecord = item as Record<string, unknown>;
      if (typeof parsedRecord.cmd === "string" && parsedRecord.cmd.trim().length > 0) {
        return parsedRecord.cmd.trim();
      }
    }
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

// 同一份键表被两个调用点使用：一处在对象本身，一处在 content 数组的每个对象元素上。
// 两处顺序必须完全一致，否则同一段输出在不同来源下会挑中不同字段，正文随流式刷新来回跳动。
// trim 只用于判空，返回值仍是原始字符串，缩进与前导空行得以保留，日志类输出对不齐就是这个细节被改掉的后果。
// 遇到数字或嵌套对象直接跳到下一个键，不做类型转换：强行转字符串会渲染出 [object Object]。
// 全部未命中时返回 undefined 而不是空串，让调用方的空值合并与过滤布尔值能继续向后回退。
function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

// 详情侧唯一的命令归一入口，字符串、字符串数组、对象、parsed_cmd 四种形态都在这一个函数里收敛。
// 对象分支会按 command、cmd、script 递归回到本函数，但只有字符串类型才递归，因此不会自陷。
// 递归返回的一定是带命令的对象或空对象，调用方不必判断 null，也不该在组件里再补一层兜底。
// 四个分支都先判空，trim 后长度为零即视为缺失，保证详情区永远不会渲染一个空命令块。
// 新增协议字段必须加在这里而不是组件里，否则每次渲染都要在 JSX 里重复一遍归一逻辑。
function getExecuteContentParts(input: unknown): {
  executionCommand?: string;
} {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return {};
    }

    // 正则整串锚定，前缀只允许可选的 /bin/ 加 zsh、bash、sh 与 -lc，其余一律原样当命令。
    // 命令捕获组使用空白加非空白字符类而非点号，多行脚本若被截成首行，展开后看到的执行内容就和真实不符。
    // 匹配不区分大小写，但捕获组拿到的仍是原样文本，不做大小写归一，也不做变量展开。
    // 命名分组在异常输入上可能缺失，因此取值处保留可选链与 trim，删掉会在畸形字符串上直接抛错。
    // 未命中时的回落是「整串即命令」，包括看着像 shell 前缀但写法不合法的输入，这是刻意的保守策略。
    const shellMatch = trimmed.match(
      /^(?:\/bin\/)?(?<tool>zsh|bash|sh)\s+-lc\s+(?<command>[\s\S]+)$/i,
    );
    if (shellMatch?.groups) {
      return {
        executionCommand: shellMatch.groups.command?.trim() || undefined,
      };
    }

    return {
      executionCommand: trimmed,
    };
  }

  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    const parts = input.map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0) {
      return {};
    }

    const shellCommandIndex = parts.findIndex((part) => part === "-lc");
    if (shellCommandIndex >= 0) {
      return {
        executionCommand: parts[shellCommandIndex + 1] || undefined,
      };
    }

    return {
      executionCommand: parts.slice(1).join(" ") || undefined,
    };
  }

  if (typeof input !== "object" || input === null) {
    return {};
  }

  const record = input as Record<string, unknown>;
  if (typeof record.command === "string" && record.command.trim().length > 0) {
    return getExecuteContentParts(record.command);
  }

  if (typeof record.cmd === "string" && record.cmd.trim().length > 0) {
    return getExecuteContentParts(record.cmd);
  }

  if (typeof record.script === "string" && record.script.trim().length > 0) {
    return getExecuteContentParts(record.script);
  }

  const parsedCommand = record.parsed_cmd;
  if (Array.isArray(parsedCommand)) {
    for (const item of parsedCommand) {
      if (typeof item === "string") {
        const parts = getExecuteContentParts(item);
        if (parts.executionCommand) {
          return parts;
        }
        continue;
      }

      if (typeof item !== "object" || item === null) {
        continue;
      }

      const parsedRecord = item as Record<string, unknown>;
      const executionCommand =
        typeof parsedRecord.cmd === "string" && parsedRecord.cmd.trim().length > 0
          ? parsedRecord.cmd.trim()
          : typeof parsedRecord.command === "string" && parsedRecord.command.trim().length > 0
            ? parsedRecord.command.trim()
            : typeof parsedRecord.script === "string" && parsedRecord.script.trim().length > 0
              ? parsedRecord.script.trim()
              : undefined;

      if (executionCommand) {
        return { executionCommand };
      }
    }
  }

  return {};
}

// 纯递归函数，不缓存也不读外部状态，同一份输出在任何时机都得到同一段文本。
// 数组分支对每一项递归后过滤掉 null，因此嵌套对象里的空字段不会在结果区留下空行。
// 字符串分支 trim 判空却返回原串，保留尾部换行与缩进，这是复制粘贴场景的硬要求。
// 对象分支先读直接字段，再读 rawOutput，最后读 content 数组，这是结果可见性的第二优先级。
// 与 display 字段不同，这里拿不到协议校验过的结构，所以每个分支都必须对未知形态保持静默而不是抛错。
function extractExecuteResultText(output: unknown): string | null {
  if (output == null) {
    return null;
  }

  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? output : null;
  }

  if (Array.isArray(output)) {
    const pieces = output
      .map((item) => extractExecuteResultText(item))
      .filter((item): item is string => item != null);
    return pieces.length > 0 ? pieces.join("\n") : null;
  }

  // content 数组允许字符串与普通对象混排，两种之外的元素产出空串并在下一步被过滤掉。
  // 不要改成统一转字符串：null 会变成字面量 null，函数与方法会变成源码片段，用户会看到不该出现的文本。
  // 直接字段优先于 content，即使 content 更长也不合并，否则同一段输出会在结果区出现两遍。
  // rawOutput 只在直接字段为空时才读，避免原始嵌套结构覆盖服务端已经整理好的展示文本。
  // 数组形态已在上面返回，能走到这里说明外层不是数组，无需再补一次数组判断。
  if (isPlainRecord(output)) {
    const directText = readFirstStringField(output, [
      "output",
      "text",
      "content",
      "result",
      "stdout",
      "message",
    ]);
    if (directText) {
      return directText;
    }

    const rawOutput = output.rawOutput;
    if (rawOutput !== undefined) {
      const nestedText = extractExecuteResultText(rawOutput);
      if (nestedText) {
        return nestedText;
      }
    }

    const content = output.content;
    if (Array.isArray(content)) {
      const contentText = content
        .map((item) => {
          if (typeof item === "string") {
            return item.trim();
          }

          if (isPlainRecord(item)) {
            return (
              readFirstStringField(item, [
                "output",
                "text",
                "content",
                "result",
                "stdout",
                "message",
              ]) ?? ""
            );
          }

          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (contentText.length > 0) {
        return contentText;
      }
    }
  }

  // 退出码、布尔结果、大整型都以字符串形式呈现，避免下游把它当对象整体丢掉。
  // bigint 必须显式转换，序列化遇到 bigint 会直接抛错，异常冒到渲染层就是整块卡片白屏。
  // 这里显式枚举类型而不是对任意值取字符串：Symbol 与函数会产出不可读文本，宁可回退到上一路来源。
  // null 与 undefined 已在函数首行拦截，这里再判会多出一条永远为假的分支。
  // 对象落到函数末尾返回 null，让调用方的空值合并自动回退，而不是渲染一个空对象占位。
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return String(output);
  }

  return null;
}

export function ExecuteToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText, isOfficeMode = false } = context;
  // 本组件只读上下文，不写回任何状态：statusLabel 与 errorText 都由外层算好，避免两处判定分裂。
  // 不要在这里再按 toolCall.status 推导文案，否则状态标签与悬浮提示可能来自不同来源，出现自相矛盾的卡片。
  // input 与 output 都是运行时快照字段，可能被裁剪过，读取时必须容忍字段缺失。
  // 解构处不加默认值，缺失即 undefined，由各解析函数统一兜底，这样兜底策略只有一处。
  // 这里读取的字段顺序决定了下面几个 useMemo 的依赖，任何新增读取都要同步检查依赖数组。
  const { toolCall } = toolCallNode;
  const secondaryText = getExecuteSecondaryText(toolCall.input);
  const contentParts = getExecuteContentParts(toolCall.input);
  const outputText = extractExecuteResultText(toolCall.output);
  const rawOutputText = isPlainRecord(toolCall.raw)
    ? extractExecuteResultText(toolCall.raw.rawOutput)
    : null;
  // 使用安全的解析接口而不是抛错版本：协议升级或旧快照不满足 schema 时静默降级为 undefined。
  // 依赖只写 toolCall.raw，不写整个 toolCall：后者引用每次流式更新都会变化，会带来大量无谓重算。
  // 非普通对象直接返回 undefined，与 schema 失败的后果一致，调用方只需处理「有或没有」两种状态。
  // 解析结果属于展示态投影，不得回写到 toolCall，否则同一字段会出现两份事实来源。
  // 若改成抛错或给默认值兜底，失败路径会被掩盖，长输出会永久退化成兜底文本。
  const outputDisplay = useMemo(() => {
    if (!isPlainRecord(toolCall.raw)) return undefined;
    const parsed = bashOutputDisplaySchema.safeParse(toolCall.raw.display);
    return parsed.success ? parsed.data : undefined;
  }, [toolCall.raw]);
  // 三路优先级不可调换：协议校验过的 display 最权威，其次是 output，再次是 raw 里的 rawOutput。
  // 用空值合并而不是逻辑或：display.output 明确为空串时应当渲染为空，而不是回退到旧快照文本。
  // 三路都为空时结果是 undefined，交给下面三元判断走「无输出」或不渲染分支。
  // 这里不做长度截断，截断属于输出组件的渲染职责，提前截断会让复制出来的内容不完整。
  // 新增来源只能追加在末尾，插到中间会让已发布的长输出突然变短，用户会以为命令结果被改写。
  const resultText = outputDisplay?.output ?? outputText ?? rawOutputText;
  // 仅在 isRunning 时解析预览，运行结束故意返回 undefined，把展示权交还给完整结果。
  // 依赖里必须带上 isRunning：漏掉它，命令结束后预览会一直挂在运行态那个值上。
  // 预览同样使用安全解析，流式阶段的半截数据本身就不保证满足 schema。
  // 预览与完整结果不是同一字段，不能因为「已有预览」就跳过 output 的读取。
  // 若把守卫改成有预览就一直用，最终结果会永远只显示最后几行而不是全文。
  const outputPreview = useMemo(() => {
    if (!isRunning || !isPlainRecord(toolCall.raw)) return undefined;
    const parsed = executionOutputPreviewSchema.safeParse(toolCall.raw.outputPreview);
    return parsed.success ? parsed.data : undefined;
  }, [isRunning, toolCall.raw]);
  // 只在状态为 failed 时取值，成功或运行中一律 undefined，避免把历史错误挂到新结果上。
  // 优先级是 errorText 先于 resultText：结构化错误比拼接文本更接近根因。
  // 失败时结果里可能只有退出码文本，因此仍要回退到 resultText，否则卡片没有任何可见原因。
  // 该值同时用作状态悬浮提示，改动会影响两处展示，不能只按正文场景评估。
  // 不要把它当成失败时的完整输出：完整输出仍由 resultText 承担，两者用途不同。
  const failureVisibleText =
    toolCall.status === "failed" ? (errorText ?? resultText ?? undefined) : undefined;
  const secondaryTextNode = useMemo(
    // 收起态 command 属于摘要正文，使用 UI sans 与同一行文案保持一致；
    // 展开后的完整命令仍保留 font-mono，便于阅读和复制技术内容。
    () => <code className="truncate font-sans">{secondaryText}</code>,
    [secondaryText],
  );
  // 这个回调读取七个外部值，依赖数组是手写的，漏一项就会闭包到上一条命令的输出。
  // isRunning 与 isPermissionPreview 必须在依赖里：它们决定分支走向，而不是内容细节。
  // 权限预览阶段返回不含输出区的结构，防止确认前就泄露上一次执行结果。
  // 展开区始终保持同一套外层结构与间距，只有内部区域变化，否则切换状态时布局会跳动。
  // 改依赖时宁多勿少，但不要加入 toolCall 整体对象，否则每次流式 tick 都会重建子树。
  const renderContent = useCallback(
    () => (
      <div
        data-testid="execute-detail"
        className="space-y-3 mb-2 rounded-xl border border-border bg-panel px-4 py-3"
      >
        <div className="space-y-1">
          <div className="flex items-start gap-2 font-sans text-ui-base text-foreground">
            <ExecuteCommand
              key={contentParts.executionCommand}
              command={contentParts.executionCommand}
            />
          </div>
        </div>

        {context.isPermissionPreview ? null : outputPreview || failureVisibleText || resultText ? (
          <ExecuteOutput
            text={outputPreview?.fullText ?? failureVisibleText ?? resultText ?? ""}
            running={isRunning}
          />
        ) : (
          !isRunning && (
            <div className="space-y-1">
              <p className="font-mono text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.toolCall.execute.noOutput",
                })}
              </p>
            </div>
          )
        )}
      </div>
    ),
    [
      contentParts.executionCommand,
      context.isPermissionPreview,
      failureVisibleText,
      intl,
      isRunning,
      resultText,
      outputPreview,
    ],
  );

  // 顶层只包一个 Fragment：工具布局与快照提示是兄弟节点，去掉这层会多出一个无意义的包裹元素。
  // Office 模式在四处同时收口，折叠开关、强制展开、摘要文本与快照提示，只关其中一处就会露出折叠箭头。
  // 快照提示的回调必须带上当前工具调用 id，否则加载回来的字段会串到另一条工具调用上。
  // 有摘要或 Office 模式下主动清空主标题，避免标题与命令摘要同时占据首行，导致文本溢出。
  // 末尾被注释掉的调试输出是本地排障开关，恢复它会打印整个工具调用，注意不要一起提交。
  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EXECUTE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={!isOfficeMode && (context.canToggle ?? true)}
        forceOpen={!isOfficeMode && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={
          (isOfficeMode
            ? intl.formatMessage({
                id: isRunning
                  ? "chat.toolCall.execute.running"
                  : "chat.toolCall.execute.conciseCompleted",
              })
            : context.kindLabelOverride) ??
          intl.formatMessage({
            id: isRunning ? "chat.toolCall.execute.running" : "chat.toolCall.kind.terminal",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={
          isOfficeMode || secondaryText
            ? null
            : (toolCall.title ??
              toolCall.kind ??
              intl.formatMessage({ id: "chat.toolCall.execute.execute" }))
        }
        secondaryText={isOfficeMode ? undefined : secondaryTextNode}
        statusLabel={statusLabel}
        statusTooltip={isOfficeMode ? undefined : failureVisibleText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={isOfficeMode ? undefined : toolCall.title}
        renderContent={renderContent}
      />
      {!isOfficeMode ? (
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            context.onLoadFullToolCallFields
              ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
              : undefined
          }
        />
      ) : null}
      {/* <pre className="text-[8px]">{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}
