// INV-01 [契约] 展示模型只由 list_apps 与 list_windows 两种工具生成，其余工具返回 undefined；守住位置：buildCuaDetailList 末尾的 undefined 与两个 toolName 分支；改错故障：其他 CUA 动作也产出列表，详情卡多出与动作无关的区块。
// INV-02 [失败路径] 结果行数组的三级降级顺序固定：display 结构化、output 文本、rawOutput 文本，最后空数组；守住位置：readCuaResultList 的 ?? 链；改错故障：顺序调换后已被 head 与 tail 裁剪的 legacy 文本盖过完整 display，列表缺行。
// INV-03 v4 display 只在 kind 为 cua 时解析 structuredContent；守住位置：readCuaResultList 中 displayRows 的三元条件；改错故障：其他 kind 的 structuredContent 被当 CUA 行解析，混入无关条目。
// INV-04 [失败路径] 文本解析遇到 "Structured content:" 分隔标记只取前半段；守住位置：parseCuaResultList 的 split 调用与下标 1；改错故障：尾部结构化段落被拼进候选文本，解析失败后整段列表退化为空。
// INV-05 文本候选必须去空白后以左方括号开头才尝试解析；守住位置：parseCuaResultList 的 startsWith 早返回；改错故障：任意文本都进入解析，日志与错误文案被当成数组候选反复解析。
// INV-06 [失败路径] 解析异常一律折成 null 而不是向上抛；守住位置：parseCuaResultList 的 catch 块；改错故障：一条畸形结果打断整条消息渲染，列表区块连同宿主卡片一起白屏。
// INV-07 结构化候选递归展开字符串与 result 包装；守住位置：parseStructuredCuaResultList 对字符串与 result 字段的两次自调用；改错故障：多包一层 result 的真实载荷解析不出行，成功结果被显示成空列表。
// INV-08 [权衡] 只有非空且非数组的对象才算记录；守住位置：asRecord 的三项条件；改错故障：数组或 null 进入字段读取路径，所有字段取到 undefined，整行被静默跳过。
// INV-09 字符串字段统一经 readText 去空白并把空白折成 null；守住位置：readText 的 typeof 与 trim 判空；改错故障：空白名称放行后列表出现无标题空行，或去空白破坏名称内的原始排版。
// INV-10 应用项缺少 name 时整行丢弃；守住位置：list_apps 分支 flatMap 中的 name 早返回；改错故障：无名应用以空串渲染，用户无法辨认图标对应哪个程序。
// INV-11 应用项的 bundleId 取蛇形 bundle_id，active 只认字面 true；守住位置：CuaAppItem 构造的 bundleId 与 active 表达式；改错故障：驼峰取值恒为空，所有应用都退回通用图标，宽松真值判断又会把非布尔字段当成激活。
// INV-12 [事务] 应用列表按 active 降序排序且排序发生在投影之后；守住位置：list_apps 分支的 items 排序调用；改错故障：排序写在过滤前，未知名行参与比较后激活项位置错乱。
// INV-13 窗口项要求记录非空，bounds 非数组时按空数组降级；守住位置：list_windows 分支的 record 早返回与 bounds 三元；改错故障：非对象行被当成窗口，渲染出只有占位图标的空窗口。
// INV-14 窗口宽高只取 bounds 的下标 2 与 3，且必须是数字；守住位置：width 与 height 的 typeof 判断；改错故障：下标错位后宽度显示成纵坐标，尺寸区块出现负值或无意义数字。
// INV-15 [权衡] 窗口宽高必须同时存在才展示尺寸；守住位置：CuaWindowList 尺寸行的双非空条件；改错故障：只剩一边时渲染出 "1024 ×" 的半截文本。
// INV-16 [并发] 图标读取用 active 标记丢弃过期结果；守住位置：CuaAppList 副作用内 active 与 then 回调的早返回、清理函数置否；改错故障：列表切换后旧请求回填图标，出现应用与图标错配。
// INV-17 [资源] 图标请求按 bundleId 去重，且能力缺席时不发请求；守住位置：Set 去重与 platform 缺省早返回；改错故障：重复 bundleId 触发成倍请求，或对空能力反复调用后抛错。
// INV-18 [失败路径] 列表区块只在宿主确认非空时挂载，本文件不提供空态；守住位置：CuaDetailListSection 的调用契约与 buildCuaDetailList 的空 items 返回；改错故障：空列表也渲染标题栏，详情卡出现只有下边框的空区块。
//
// 模块职责：CUA 列表类工具结果的展示投影与渲染，把 list_apps 与 list_windows 的原始行收敛成应用项或窗口项，并渲染带图标的可滚动列表。
// 状态所有权：行数据与激活、主窗口判定是工具结果的一次性投影，不落本地；图标表是 CuaAppList 的本地瞬时缓存，来源为平台能力回调，失败即空表。
// 阅读顺序：先看解析三级降级，再看 buildCuaDetailList 的两个分支与排序，最后看 CuaAppList 的图标副作用与 CuaDetailListSection 的挂载契约。
import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

interface CuaAppItem {
  name: string;
  bundleId: string | null;
  active: boolean;
}

interface CuaWindowItem {
  title: string | null;
  width: number | null;
  height: number | null;
  main: boolean;
  focused: boolean;
}

export type CuaDetailList =
  | { kind: "apps"; items: CuaAppItem[] }
  | { kind: "windows"; items: CuaWindowItem[] };

// [边界] 记录判定同时排除 null 与数组：typeof null 也是 object，漏掉任一项都会让后续字段读取落在非法形状上。
// [失败路径] 判定失败返回 null 而不是空对象：空对象会让上层误以为字段齐全，只是值缺失。
// readText 先判字符串再去空白，空白串折成 null；调用方因此只需判空，不必再区分空串与缺字段。
// [权衡] readText 返回去空白后的副本：名称与标题是展示文本，首尾空白没有信息量，保留会撑歪列表行高。
// 两个辅助函数都不抛错，任何脏行都退化成可跳过的 null，保证一条坏数据不影响其余行。
// [契约] asRecord 是 parseStructuredCuaResultList 与两个列表分支共用的唯一收窄入口，不要在各分支另写形状判断。
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// [契约] 入参已经是数组时原样返回，不再复制：调用方只读，复制会多一次整表遍历。
// [失败路径] 非字符串非数组直接返回 null，让 readCuaResultList 落到下一个候选而不是立刻给空数组。
// 分隔标记的 split 限制为一段，只保留标记之前的正文；v4 之后的结构化段落由 display 通道单独提供。
// 候选去空白后必须以左方括号开头才尝试解析，其余文本按没有列表处理。
// [失败路径] 解析结果不是数组同样返回 null；对象型载荷不能当行集合使用。
// [权衡] 解析失败静默返回 null 而不记日志：这里每条消息都会走，噪声会淹没真正的解析问题。
function parseCuaResultList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const candidate = value.split("\n\nStructured content:", 1)[0]?.trim();
  if (!candidate?.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// [契约] 数组直接作为行集合返回，字符串先解析再递归，result 包装向下展开一层。
// [失败路径] 字符串解析异常折成 null；递归层数因此有界，坏载荷不会反复尝试。
// [权衡] 递归而不是固定两层展开：不同版本对 result 的嵌套深度不一致，写死层数会漏掉更深一层。
// result 为 undefined 表示没有该字段，返回 null；其余非记录形状同样落到 null。
// [契约] 该函数只做形状收敛，不校验行内字段；字段合法性交给两个列表分支逐项判断。
function parseStructuredCuaResultList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return parseStructuredCuaResultList(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const result = asRecord(value)?.result;
  return result === undefined ? null : parseStructuredCuaResultList(result);
}

function readCuaResultList(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): unknown[] {
  // [契约] 读取顺序以 display 为第一优先，它是 v4 与 replayable 链路的稳定事实源。
  // [失败路径] legacy 的 output 文本可能已被 head 与 tail 裁剪，只能作为 display 缺席时的降级。
  // displayRows 只在 kind 为 cua 时产出；其他展示类型不参与列表投影。
  // [权衡] 三级候选用空值合并串联，只有前一级返回 null 才继续；返回空数组代表已确认无行，不再向下试探。
  // [失败路径] 三级全空时返回空数组而不是 undefined，调用方无需再做一次空值判断。
  // rawOutput 来自 raw 记录的字段读取，raw 本身不是记录时 readText 自然得到 null。
  // [契约] 本函数是列表行的唯一入口，两个分支只消费它返回的数组，不自行读取 display 或 output。
  const display = readToolResultDisplay(toolCall.raw);
  // v4/replayable 的稳定事实源是 display；legacy 文本可能已被 head/tail 裁剪。
  const displayRows =
    display?.kind === "cua" ? parseStructuredCuaResultList(display.structuredContent) : null;
  return (
    displayRows ??
    parseCuaResultList(toolCall.output) ??
    parseCuaResultList(readText(asRecord(toolCall.raw), "rawOutput")) ??
    []
  );
}

// [契约] 函数按 toolName 分派，list_apps 与 list_windows 之外一律返回 undefined，由宿主决定不渲染列表区块。
// [失败路径] 应用项缺 name 时用 flatMap 丢弃整行而不是占位：无名条目在界面上无法被辨认。
// active 只认字面 true，缺失或非布尔值按未激活处理；宽松判断会把字符串 "false" 也算作激活。
// [事务] 应用排序按激活位降序且就地重排投影后的数组，行数据本身不受影响。
// [权衡] 排序依赖数组的稳定性：同激活态保持工具返回顺序，避免每次渲染顺序漂移。
// 窗口项先要求记录存在，再取 bounds；bounds 非数组时退化为空数组，宽高自然为 null。
// 宽高固定取 bounds 的第 3 与第 4 个分量，并按数字类型收窄；越界或非数字一律为 null。
// [失败路径] main 与 focused 同样只认字面 true，缺失字段不会让窗口被误标为主窗口。
export function buildCuaDetailList(
  toolName: string,
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): CuaDetailList | undefined {
  const rows = readCuaResultList(toolCall);
  if (toolName === "list_apps") {
    const items = rows.flatMap((value): CuaAppItem[] => {
      const record = asRecord(value);
      const name = readText(record, "name");
      if (!name) return [];
      return [
        {
          name,
          bundleId: readText(record, "bundle_id"),
          active: record?.active === true,
        },
      ];
    });
    items.sort((left, right) => Number(right.active) - Number(left.active));
    return { kind: "apps", items };
  }
  if (toolName === "list_windows") {
    const items = rows.flatMap((value): CuaWindowItem[] => {
      const record = asRecord(value);
      if (!record) return [];
      const bounds = Array.isArray(record.bounds) ? record.bounds : [];
      return [
        {
          title: readText(record, "title"),
          width: typeof bounds[2] === "number" ? bounds[2] : null,
          height: typeof bounds[3] === "number" ? bounds[3] : null,
          main: record.main === true,
          focused: record.focused === true,
        },
      ];
    });
    return { kind: "windows", items };
  }
  return undefined;
}

function CuaAppList({ items }: { items: CuaAppItem[] }) {
  const { intl } = useZCodeIntl();
  // [资源] 图标来自平台能力，能力缺席时副作用直接返回，不发起任何请求。
  // [并发] bundleId 先去重再并发请求，重复项不会产生多次往返。
  // [并发] active 标记在请求发起时置真、清理时置否，迟到结果在写状态前被丢弃。
  // [失败路径] 单项图标返回 null 时该条被过滤掉，渲染回退到通用窗口图标而不是坏图。
  // [权衡] `cuaListDetails` 的图标表整体替换而非逐项合并：条目变化时旧图标不残留。
  // 应用行以 bundleId 优先、名称兜底的复合键加下标，保证重复名称也能稳定渲染。
  // [契约] 名称列用 truncate 占位，激活标签只在 active 为真时出现，行内不出现空标签。
  // [权衡] 列表容器限高纵向滚动：cuaListDetails 应用多时只滚内容区，不撑高宿主卡片。
  const platform = useToolPresentationCapabilities();
  const [icons, setIcons] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const bundleIds = [...new Set(items.flatMap((item) => (item.bundleId ? [item.bundleId] : [])))];
    if (!platform?.getApplicationIcon || bundleIds.length === 0) return () => undefined;
    void Promise.all(
      bundleIds.map(async (bundleId) => {
        const result = await platform.getApplicationIcon?.(bundleId);
        return [bundleId, result?.iconDataUrl ?? null] as const;
      }),
    ).then((results) => {
      if (!active) return;
      setIcons(
        Object.fromEntries(
          results.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [items, platform]);

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
      {items.map((item, index) => (
        <div
          key={`${item.bundleId ?? item.name}:${index}`}
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover"
        >
          {item.bundleId && icons[item.bundleId] ? (
            <img
              src={icons[item.bundleId]}
              alt=""
              aria-hidden
              className="size-4 shrink-0 object-contain"
            />
          ) : (
            <AppWindow className="size-4 shrink-0 text-foreground-subtle" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.name}</span>
          {item.active ? (
            <span className="shrink-0 text-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.cua.details.active" })}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// 窗口标题缺失时回落到本地化的未命名窗口文案，而不是渲染空字符串。
// 主窗口与聚焦标记各自独立渲染，两个标签可以同时出现也可以在都缺省时整行省略。
// [权衡] `width` 与 `height` 都非空才展示尺寸，单边缺失宁可省略。
// [契约] 区块标题由 kind 决定，apps 走应用列表、windows 走窗口列表，两分支共用同一外壳。
// [失败路径] 空 items 在宿主侧已被拦下，本文件不再提供空态；直接挂载只会得到一条只有边框的空白区块。
function CuaWindowList({ items }: { items: CuaWindowItem[] }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
      {items.map((item, index) => (
        <div
          key={`${item.title ?? "untitled"}:${index}`}
          className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover"
        >
          <AppWindow className="size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-foreground">
              {item.title ?? intl.formatMessage({ id: "chat.toolCall.cua.details.untitledWindow" })}
            </div>
            {item.main || item.focused ? (
              <div className="flex flex-wrap gap-x-2 text-sm text-foreground-subtle">
                {item.main ? (
                  <span>{intl.formatMessage({ id: "chat.toolCall.cua.details.mainWindow" })}</span>
                ) : null}
                {item.focused ? (
                  <span>{intl.formatMessage({ id: "chat.toolCall.cua.details.focused" })}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          {item.width !== null && item.height !== null ? (
            <span className="shrink-0 font-mono text-sm text-foreground-subtle">
              {item.width} × {item.height}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function CuaDetailListSection({ list }: { list: CuaDetailList }) {
  const { intl } = useZCodeIntl();
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <h4 className="text-sm text-foreground-subtle">
        {intl.formatMessage({
          id:
            list.kind === "apps"
              ? "chat.toolCall.cua.details.appList"
              : "chat.toolCall.cua.details.windowList",
        })}
      </h4>
      {list.kind === "apps" ? (
        <CuaAppList items={list.items} />
      ) : (
        <CuaWindowList items={list.items} />
      )}
    </section>
  );
}
