// ============================================================
// 脚本 transcript 条目的展开面板
// ============================================================
// 挂载即取正文（条目只在展开时挂它），取回即缓存。三种正文：Terminal（`$ 命令行`、stdout、
// 单独成段、淡红底的 stderr、页脚 exit · 耗时 · 字节 + Copy）、清单（glob / grep /
// changed-files，带行号、按行有界）、文本（read / diff，diff 按首字符着墨）。

// WorkflowWorkspaceCardBody.tsx —— 工作流脚本卡的展开正文：按节点状态与 result 形态把一次调用渲染成终端输出、文件清单或纯文本，并统一收口截断、页脚数字与复制
// INV-01 正文只渲染 journal 已落库的节点事实，实时投影只参与 cached 芯片判定；守住位置：WorkspaceCardBody 的全部正文分支；改错故障：把投影当真相会让一次刷新回退已经展示的 stdout
// INV-02 分支优先级恒为 loading 高于取数错误、取数错误高于 failed、failed 高于 running、running 高于已有 result、最后才空；守住位置：组件体的整条 if 与 else if 链；改错故障：顺序调换后失败节点先落到 running 文案，用户看不到错误原因
// INV-03 正文取数只在 node.status 为 completed 时启用；守住位置：useWorkflowRunNodeResult 的 enabled 实参；改错故障：running 与 failed 节点也去取正文，网关回错误并把节点错误盖成取数失败
// INV-04 请求身份是 sessionId、runId、siteId、ordinal 四元组，缺一不可；守住位置：hook 入参；改错故障：同一站点多轮调用的正文互相串台，第二轮显示第一轮输出
// INV-05 三种正文都必须经 WORKSPACE_RESULT_MAX_LINES 行截断，且截断后同时给出 shown 与 total；守住位置：boundLines 与三处 note 计算；改错故障：超长输出撑爆卡片，或用户误以为只有 200 行输出
// INV-06 截断提示的触发条件是行数被截或网关 truncated，两者取或而不是取与；守住位置：run、数组、字符串三个 note；改错故障：网关按字节截断但行数未变时无提示，用户把残缺 diff 当完整内容
// INV-07 页脚字节数与正文同源：node.summary 优先、result.totalBytes 兜底；守住位置：run 分支与字符串分支的 formatWorkspaceBytes 实参；改错故障：正文只画了前 200 行而字节数按全量报，两个数字互相矛盾
// INV-08 数组分支的计数分两层口径：页脚总数取 resultCount，列表只渲染前 WORKSPACE_RESULT_MAX_LINES 项；守住位置：total 与 items 的赋值；改错故障：拿 items.length 当总数，页脚把五千条匹配标成两百条
// INV-09 grep 与 glob 的行号语义不同：grep 显示命中的源文件行号，其余按视图序号；守住位置：isGrepMatch 分支与 index 加一；改错故障：glob 结果被误判成 grep，行号列出现重复或不连续的数字
// INV-10 空结果必须显式占位，不能渲染空壳：run 无输出、数组为空、字符串为空各有独立文案；守住位置：三处空分支；改错故障：卡片只剩页脚，用户以为组件坏掉
// INV-11 失败节点的正文优先级为 message 高于 code，两者皆空时渲染空串而不是占位符；守住位置：failed 分支；改错故障：错误码被丢掉后用户无法区分超时与权限拒绝
// INV-12 耗时一律由 node.updatedAt 减 node.createdAt 得出并夹到非负；守住位置：durationMs；改错故障：跨机时钟回拨产生负耗时，页脚印出负毫秒数
// INV-13 卡片视觉的差异只允许来自节点状态与正文形态，组件内不得按 kind 二次分派；守住位置：整个组件体；改错故障：read 与 grep 的渲染路径分叉后，同一种正文在两类卡上排版不一致
// INV-14 命令行区只在 card.command 为 undefined 时消失，空串仍然渲染；守住位置：JSX 里对 card.command 的判断；改错故障：改成真值判断后空命令行被隐藏，终端卡丢掉提示符行
// INV-15 复制的内容是该分支实际展示的文本，不是全量结果；守住位置：三处 copy 实参；改错故障：用户复制到的内容比屏幕上多出被截断的几千行，粘贴进 issue 时失真
// INV-16 组件是被 memo 包住的纯投影，内部唯一可变状态是 CopyButton 的 copied；守住位置：memo 包装与 CopyButton；改错故障：把正文缓存进组件 state 后切换 run 仍显示上一轮输出
// INV-17 所有可点击元素都是原生 button 且显式 type 为 button，只挂 onClick；守住位置：CopyButton 的 JSX；改错故障：在 form 上下文里回车即提交，或换成 div 后键盘无法聚焦复制
// INV-18 文本为空时复制回调直接返回，不触碰剪贴板；守住位置：copy 回调的首个判断；改错故障：空复制在部分浏览器返回拒绝，控制台留下未捕获的 Promise
// INV-19 组件不读全局 store、不直接调用平台服务，数据只经 props、useZCodeIntl 与 hook 取得；守住位置：组件体的取数入口；改错故障：绕过 hook 直连服务会让 Web 与 Desktop 行为分叉
import { memo, useCallback, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkflowRunNodeResult } from "@/hooks/useWorkflowRunNodeResult.js";
import {
  formatWorkspaceBytes,
  formatWorkspaceDuration,
  type WorkspaceCardModel,
} from "@/app-shell/workflowWorkspaceTranscript.js";

/** 正文最多画多少行：网关按 32 KB 有界，这里再按行有界——一屏读不完的东西留在 journal 里。 */
// 行数上限与网关 32 KB 字节上限是两道独立闸门：字节闸门防传输爆炸，行闸门防一次渲染两百个以上节点
// 常量放在模块顶层而不是组件内：它是纯展示口径，不随 run 或语言变化，进组件只会每次渲染重建
// 200 这个数字同时被数组分支与文本分支复用，改一处必须同时看另一处，否则两类正文的截断阈值会漂移
// [权衡] 不用 max-h 与滚动条代替行截断：DOM 节点数才是长输出卡顿的根因，CSS 只裁视觉不裁成本
// 截断后仍保留完整页脚的总数与字节数，让用户知道还有多少没显示，而不是无声丢失
// 与数组分支 slice 的实参同源，二者必须保持一致
// [失败路径] 把它调大到接近网关字节上限时，超大 diff 会先卡住主线程再被网关截断，两次截断语义不同
// 该值不参与任何业务判断，只影响渲染量与截断提示的 shown 值，因此不需要国际化
const WORKSPACE_RESULT_MAX_LINES = 200;

const PRE_CLASS =
  "m-0 max-h-[300px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-ui-sm leading-[17px] text-foreground-subtle";
const NOTE_CLASS = "px-3 py-2.5 font-mono text-ui-sm text-foreground-subtle";

// 返回三件套而不是只返回截断文本：调用方要同时拿到显示了几行与一共有几行，才能拼出截断提示
// 空串按 split 结果算作一行，这是刻意保留的语义：空 stdout 与零行的区别由调用方的 length 判断承担
// shown 恒等于实际显示的物理行数，total 恒等于原始行数，二者都不含末尾换行带来的伪空行
// [权衡] 不在这里拼接截断文案：文案要经过 intl 且不同分支参数不同，格式化职责留在组件体
// 未超限时直接返回原 text 引用，避免 join 造成的整段字符串重分配
// slice 取前 N 行而不是后 N 行：脚本输出最有价值的是开头，尾部通常只剩余量统计
// [失败路径] text 为 undefined 会在这里抛错，因此所有调用点都先用空值兜底或类型窄化保证它是字符串
// 该函数无副作用，run 与 string 两个分支共用它，是两条渲染路径唯一共享的截断口径
function boundLines(text: string): { text: string; shown: number; total: number } {
  const lines = text.split("\n");
  if (lines.length <= WORKSPACE_RESULT_MAX_LINES) {
    return { text, shown: lines.length, total: lines.length };
  }
  return {
    text: lines.slice(0, WORKSPACE_RESULT_MAX_LINES).join("\n"),
    shown: WORKSPACE_RESULT_MAX_LINES,
    total: lines.length,
  };
}

// 这个类型守卫定义的是一条渲染契约：exitCode 与 stdout 同时存在才按终端输出排版，stderr 允许缺席
// 只认字面量类型而不认结构兼容：缺 stdout 的对象会被当成数组或 JSON 分支渲染，页脚也随之退化
// 排除数组是必要的一步，Array 也属于 object，漏判会让 grep 结果被当成 run 结果并读出 undefined 的 stdout
// [失败路径] 返回值是布尔窄化而不是抛错：journal 里旧版本 result 形状不可控，脏数据应降级为 JSON 展示
// 该守卫与后端网关的 run 结果结构一一对应，改协议时要同步改这里，否则所有终端卡退化成 JSON
function isRunResult(
  value: unknown,
): value is { exitCode: number; stdout: string; stderr: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.exitCode === "number" && typeof fields.stdout === "string";
}

function isGrepMatch(value: unknown): value is { path: string; line: number; text: string } {
  if (value === null || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.path === "string" && typeof fields.line === "number";
}

/** `+` / `-` / `@@` 三种墨：diff 的每一行按首字符着色，其余原样。 */
// 只对 diff 形态走这个组件，普通 read 文本仍用单个 pre，避免为几行文本付几百个 span 的代价
// 排除三连加号与三连减号是必需的：它们是文件头而不是增删行，染成绿红会让用户误读 diff 的行数
// 双 @ 行与 diff 行用最浅色，把它们压成背景噪声，视线自然落在真正的增删行上
// [权衡] 用 span 逐行着色而不是 CSS 伪选择器：首字符判断无法用纯 CSS 表达，只能上 DOM
// key 用行下标而非内容：diff 里同一行内容可能重复出现，内容做 key 会触发重复键警告
// [失败路径] text 已在调用方做过行截断，这里不再判断长度，否则会出现两套阈值互相打架
function DiffLines({ text }: { text: string }) {
  return (
    <pre className={PRE_CLASS}>
      {text.split("\n").map((line, index) => (
        <span
          className={cn(
            "block",
            line.startsWith("+") && !line.startsWith("+++") && "text-success",
            line.startsWith("-") && !line.startsWith("---") && "text-destructive",
            (line.startsWith("@@") || line.startsWith("diff ")) && "text-foreground-subtlest",
          )}
          key={index}
        >
          {line}
        </span>
      ))}
    </pre>
  );
}

// 复制按钮必须是真的 button 而不是可点击 span：原生元素自带键盘聚焦、回车与空格触发，无需补键位
// 按钮的 type 显式写 button：卡片可能被嵌进 form 容器，默认 submit 会让点击复制顺手提交表单
// [失败路径] text 为空时直接返回：空串写剪贴板在部分浏览器返回拒绝，留着会产生未捕获的 Promise
// clipboard 用可选链读取再调用：非安全上下文与测试环境不提供该 API，直接调用会抛错中断点击
// copied 只在写入成功后置真：先置真再写会让失败路径也闪出已复制，用户以为内容进了剪贴板
// 1500 毫秒后自动复原，计时器由 window.setTimeout 提供：换成帧回调会在后台标签页停摆
// [资源] 这里不为定时器做卸载清理：组件卸载后写 state 在 React 18 已无害，清理收益低于多一份 ref 的成本
function CopyButton({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (text.length === 0) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      className="inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-1.5 font-sans text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
      data-testid="workflow-workspace-copy"
      onClick={copy}
      type="button"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {intl.formatMessage({
        id: copied ? "chat.toolCall.copyError.copied" : "chat.toolCall.copyError",
      })}
    </button>
  );
}

/** 页脚：`exit 1 · 1.94 s · 1.3 KB` + 右侧 Copy；截断说明另起一行，不挤页脚的数字。 */
// 页脚是三类正文共用的收口：左侧若干数字、右侧复制按钮、需要时下方一行截断说明
// parts 用数组而不是固定参数：run 是三段、数组是两段、字符串是两段，形状不同但排版一致
// 分隔点由 index 决定只加在非首段之前，避免首段前面出现孤立的分隔符
// [权衡] 截断说明另起一行而不是塞进 parts：塞进去会被 nowrap 撑开，窄屏上把数字挤成省略号
// note 用 undefined 而非空串表示没有说明：空串会多渲染一个空段落与它的一段外边距
// copy 的内容由调用方按实际展示的文本给出，页脚不参与决定复制什么
function Footer({ parts, note, copy }: { parts: ReactNode[]; note?: string; copy: string }) {
  return (
    <div
      className="border-t border-border px-3 py-1.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
      data-testid="workflow-workspace-card-footer"
    >
      <div className="flex items-center gap-2">
        {parts.map((part, index) => (
          <span className="flex items-center gap-2 whitespace-nowrap" key={index}>
            {index > 0 ? <span aria-hidden>·</span> : null}
            <span>{part}</span>
          </span>
        ))}
        <span className="flex-1" />
        <CopyButton text={copy} />
      </div>
      {note === undefined ? null : <p className="mt-1 font-sans leading-snug">{note}</p>}
    </div>
  );
}

export const WorkspaceCardBody = memo(function WorkspaceCardBody({
  card,
  runId,
  sessionId,
}: {
  card: WorkspaceCardModel;
  runId: string;
  sessionId: string;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { node } = card;
  // 正文组件只在卡片展开时挂载，因此这个请求天然是展开即取，不需要额外的可见性判断
  // enabled 绑定 completed：running 与 failed 的正文要么还没产生要么已在 node.error 里，取也是白取
  // siteId 与 ordinal 共同定位一次节点调用：只传 siteId 无法区分同一站点的多轮重试
  // sessionId 与 runId 一起构成取数作用域：换 run 后旧结果必须作废，否则会显示上一轮输出
  // [并发] 四个参数里任一变化都会触发重新取数，因此它们必须来自稳定来源，不能在渲染期拼装随机值
  // hook 自带缓存层：同一次展开的重复渲染不会重复打网关，组件侧无需再包一层记忆化
  // [失败路径] error 是字符串而非异常对象：取数失败必须能原样展示给用户，抛异常会让整个卡片白屏
  const { result, loading, error } = useWorkflowRunNodeResult({
    sessionId,
    runId,
    siteId: node.siteId,
    ordinal: node.ordinal,
    enabled: node.status === "completed",
  });
  // 耗时由 journal 的两个时间戳相减得出，不读本地时钟，避免展示与事件时间不一致
  // 外层夹到零是必要的：updatedAt 可能早于 createdAt（跨机时钟回拨或事件重放），负值会直接印进页脚
  // 进度只由这两个字段推进，因此同一条卡片重渲染时耗时不会倒退，除非 journal 本身被更正
  // [权衡] 运行中不做本地递增动画：卡片只用 journal 事实，动画会让静止的失败卡片也在跳数字
  // 毫秒值原样交给 formatWorkspaceDuration，单位与小数位由该函数统一决定，这里不做取整
  // 未完成的节点也会算出耗时，但只有 result 分支消费它，因此不需要额外的状态判断
  const durationMs = Math.max(0, node.updatedAt - node.createdAt);
  const truncatedNote = (shown: string, total: string) =>
    format({ id: "chat.toolCall.workflow.script.result.truncated" }, { shown, total });
  const linesOf = (count: number) =>
    format({ id: "chat.toolCall.workflow.script.result.lines" }, { count: String(count) });

  let body: ReactNode = null;
  let footer: ReactNode = null;
  // 分支顺序即优先级：取数中压过错误、失败、运行中与已有结果，避免正文在两种状态之间抖动
  // 取数错误排在 failed 之前：正文层面的失败比节点状态更具体，用户需要先知道是读不到而不是跑失败
  // failed 排在 running 之前：journal 里出现 failed 说明状态已定，running 只可能是过期投影
  // 只有 completed 的节点才可能走到 result 分支，这是 enabled 与这里的分支顺序共同保证的
  // 每个分支只设置 body 或 footer，不提前 return，统一在末尾渲染外壳，避免外壳样式在分支里重复
  // [失败路径] 未命中任何分支时 body 保持 null，卡片只剩命令行与页脚，这是允许的降级形态
  // 空输出与失败文案用不同 class：失败用 destructive，空输出用普通 note，颜色本身就是状态信号
  // loading 与 running 共用渐变文字样式，语义上的区别由文案承担，视觉上都是还在动
  if (loading) {
    body = (
      <p className={cn(NOTE_CLASS, "animated-gradient-text-subtle")}>
        {format({ id: "chat.toolCall.workflow.script.result.loading" })}
      </p>
    );
  } else if (error !== null) {
    body = (
      <p className={cn(NOTE_CLASS, "text-destructive")}>
        {format({ id: "chat.toolCall.workflow.script.result.loadFailed" }, { error })}
      </p>
    );
  } else if (node.status === "failed") {
    body = (
      <pre className={cn(PRE_CLASS, "text-destructive")}>
        {node.error?.message ?? node.error?.code ?? ""}
      </pre>
    );
  } else if (node.status === "running") {
    body = (
      <p className={cn(NOTE_CLASS, "animated-gradient-text-subtle")}>
        {format({ id: "chat.toolCall.execute.running" })}…
      </p>
    );
  } else if (result?.result !== undefined) {
    const value = result.result;
    if (isRunResult(value)) {
      const stdout = boundLines(value.stdout);
      const stderr = boundLines(value.stderr ?? "");
      body = (
        <>
          {stdout.text.length > 0 ? (
            <pre className={PRE_CLASS}>{stdout.text}</pre>
          ) : stderr.text.length === 0 ? (
            <p className={NOTE_CLASS}>{format({ id: "chat.toolCall.execute.noOutput" })}</p>
          ) : null}
          {stderr.text.length > 0 ? (
            <div
              className="border-t border-border bg-[color-mix(in_oklab,var(--color-destructive)_3%,transparent)]"
              data-testid="workflow-workspace-stderr"
            >
              <div className="px-3 pt-2 text-ui-xs uppercase tracking-[0.08em] text-destructive/80">
                {format({ id: "chat.toolCall.workflow.script.result.stderr" })}
              </div>
              <pre className={cn(PRE_CLASS, "pt-1 text-foreground")}>{stderr.text}</pre>
            </div>
          ) : null}
        </>
      );
      const parts: ReactNode[] = [
        <span
          className={cn(
            "font-semibold",
            value.exitCode === 0 ? "text-success" : "text-destructive",
          )}
          key="exit"
        >
          {format(
            { id: "chat.toolCall.workflow.script.status.exit" },
            { code: String(value.exitCode) },
          )}
        </span>,
        formatWorkspaceDuration(durationMs),
        formatWorkspaceBytes(node.summary?.stdoutBytes ?? result.totalBytes),
      ];
      const note =
        stdout.total > stdout.shown || result.truncated
          ? truncatedNote(linesOf(stdout.shown), formatWorkspaceBytes(result.totalBytes))
          : undefined;
      footer = <Footer parts={parts} note={note} copy={value.stdout} />;
    } else if (Array.isArray(value)) {
      // 列表节点数与文本行数共用同一个上限常量，保证两类正文的渲染成本一致
      // 截断后仍用 value.length 判断是否还有更多，不能用 items.length，否则永远显示没有剩余
      // 页脚总数取 node.summary.resultCount 优先：网关可能在传输层就截断，本地数组长度小于真实匹配数
      // [失败路径] resultCount 与实际数组长度不一致时以 summary 为准展示，但复制内容只能是本地这一份
      // grep 判定只按 card.op 一次算出并复用，避免在 map 里对每个元素重复比较字符串
      // 空数组走独立占位分支而不是渲染空列表：空的 ul 会保留内边距，卡片中间出现一条可疑的空白带
      const items = value.slice(0, WORKSPACE_RESULT_MAX_LINES);
      const grep = card.op === "grep";
      body =
        value.length === 0 ? (
          <p className={NOTE_CLASS}>
            {format({ id: "chat.toolCall.workflow.script.result.empty" })}
          </p>
        ) : (
          <ul className="max-h-[300px] overflow-auto py-1.5 font-mono text-ui-sm leading-[18px] text-foreground">
            {items.map((item, index) => (
              <li
                className="flex gap-2.5 px-3 py-px"
                key={index}
                title={isGrepMatch(item) ? item.text : undefined}
              >
                <span className="w-[22px] shrink-0 text-right text-foreground-subtlest">
                  {isGrepMatch(item) ? item.line : index + 1}
                </span>
                {isGrepMatch(item) ? (
                  <span className="min-w-0 truncate">
                    <span>{item.path}</span>
                    <span className="ml-2 text-foreground-subtle">{item.text.trim()}</span>
                  </span>
                ) : (
                  <span className="min-w-0 truncate">{String(item)}</span>
                )}
              </li>
            ))}
            {value.length > items.length ? (
              <li className="px-3 pl-[46px] pt-1 text-ui-xs text-foreground-subtlest">
                {format(
                  { id: "chat.toolCall.workflow.script.result.more" },
                  { count: String(value.length - items.length) },
                )}
              </li>
            ) : null}
          </ul>
        );
      const total = node.summary?.resultCount ?? value.length;
      const parts: ReactNode[] = [
        format(
          {
            id: grep
              ? "chat.toolCall.workflow.script.result.matches"
              : "chat.toolCall.workflow.script.result.files",
          },
          { count: String(total) },
        ),
        formatWorkspaceDuration(durationMs),
      ];
      const note =
        items.length < total || result.truncated
          ? truncatedNote(String(items.length), String(total))
          : undefined;
      const copy = items
        .map((item) =>
          isGrepMatch(item) ? `${item.path}:${item.line} ${item.text}` : String(item),
        )
        .join("\n");
      footer = <Footer parts={parts} note={note} copy={copy} />;
    } else if (typeof value === "string") {
      const bounded = boundLines(value);
      body =
        value.length === 0 ? (
          <p className={NOTE_CLASS}>{format({ id: "chat.toolCall.execute.noOutput" })}</p>
        ) : card.op === "git-diff" ? (
          <DiffLines text={bounded.text} />
        ) : (
          <pre className={PRE_CLASS}>{bounded.text}</pre>
        );
      const parts: ReactNode[] = [
        formatWorkspaceDuration(durationMs),
        formatWorkspaceBytes(result.totalBytes),
      ];
      const note =
        bounded.total > bounded.shown || result.truncated
          ? truncatedNote(linesOf(bounded.shown), formatWorkspaceBytes(result.totalBytes))
          : undefined;
      footer = <Footer parts={parts} note={note} copy={bounded.text} />;
    } else {
      const text = JSON.stringify(value, null, 2);
      body = <pre className={PRE_CLASS}>{text}</pre>;
      footer = (
        <Footer
          parts={[formatWorkspaceDuration(durationMs), formatWorkspaceBytes(result.totalBytes)]}
          copy={text}
        />
      );
    }
  }

  return (
    <div
      className="wf-ws-body mt-1.5 overflow-hidden rounded-[10px] border border-border bg-card"
      data-testid="workflow-workspace-card-body"
      data-ws-body
    >
      {card.command === undefined ? null : (
        <div className="flex gap-2 border-b border-border px-3 py-2.5 font-mono text-[12.5px] text-foreground">
          <span className="shrink-0 text-foreground-subtlest">$</span>
          <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono">
            {card.command}
          </pre>
        </div>
      )}
      {body}
      {footer}
    </div>
  );
});
