// ============================================================================
// ExternalAgentImportDialog —— 外部 Agent 资源导入弹窗（skills / commands / plugins / mcpServers）
//
// 链路位置：设置页「从其他 Agent 导入」→ detect 扫描来源 → 勾选资源 → importSelected 落盘
//        → complete 逐项展示 imported / skipped / failed（部分成功是正常终态，不是异常）。
//
// 不变量表（本文件维持或依赖；每条都对应一处「换个写法就出错」的具体故障）：
// INV-1: step 只有 selection / importing / complete 三态，流向固定为
//        selection→importing→complete，失败回 selection；不存在 complete→importing。
//        破坏后果：complete 页与进度页同时可渲染时，用户分不清屏幕上这份结果是哪一轮的。
// INV-2: selectedKeys 是选择结果的唯一真相，selections 每次渲染由它重算，不另存副本。
//        破坏后果：重扫或切 scope 后两份状态不同步，勾选框显示已选而提交内容为空。
// INV-3: 资源选择 key 是 JSON 编码的四元组 agent+category+sourceScope+resourcePath，
//        resourcePath 原样保存，不做大小写、分隔符或 realpath 归一化。
//        破坏后果：把 C:/A 与 c:/a 合并会漏导或误覆盖真实存在的两个目录。
// INV-4: activeScope（浏览哪个来源）与 importTargetScope（导入到哪里）是两个独立状态；
//        切来源 scope 时 target 跟随同值，但改 target 不反向改来源。
//        破坏后果：合并成一个变量后「浏览 global、导入 project」这一唯一可用组合无法表达。
// INV-5: importMode 只对 skills / commands / plugins 生效，mcpServers 不渲染该控件。
//        破坏后果：给 MCP 传 symlink 会落到服务层不存在的分支，或把配置文件软链成目录。
// INV-6: detect 失败时必须把 discovery 置为 { agents: [] }，不能保留上一次扫描结果。
//        破坏后果：用户按旧列表勾选后全部导入失败，且看到的错误来自扫描而非导入。
// INV-7: 自动扫描由 enabled && !discovery && !loading 三重条件守护，同一时刻只允许一次；
//        手动重扫是唯一允许覆盖已有 discovery 的入口。
//        破坏后果：去掉 loading 守卫后 open 抖动或 StrictMode 双调用会并发扫两次，
//        后返回的旧结果覆盖新结果，选中项指向已经不存在的数据。
// INV-8: 导入成功路径必须先落定 result 与 step，再 await onImported()。
//        破坏后果：父级刷新抛错会进 catch，把已经落盘成功的导入显示成失败并退回选择页。
// INV-9: 导入失败只写 importError 并回 selection，不清空 selectedKeys。
//        破坏后果：清空后用户要重勾几十项才能重试，而失败原因往往只是一次瞬时 IO 错误。
// INV-10: result / importError / step 的重置只发生在 open 变 true 时，open 变 false 时不重置。
//        破坏后果：关闭动画期间 result 被清空会让弹窗闪空列表；每次 close 都清则「关了再开」
//        看不到上一次结果，无法确认到底导入成功没有。
// INV-11: importProgress 是前端估算值（importing=62、complete=100），不是服务端回传进度。
//        破坏后果：拿它做超时或幂等判断，会在慢盘上误判超时并重复触发导入。
// INV-12: 只有 importable=true 的项可勾选，也不计入全选分母。
//        破坏后果：把 skipped 项算进分母，全选永远停在「部分选中」，用户点不出全选态。
// INV-13: 全选/清空只作用于当前 activeScope 可见的 importable 项，不清洗其他 scope 的选择。
//        破坏后果：切 scope 时清空全部选择，让「先选 global 再选 project」无法完成。
// INV-14: project 目标只有 workspacePath 存在时可选；缺失时按钮禁用但 global 仍可用。
//        破坏后果：无 workspace 时允许写 project，会落到默认目录或直接把错误抛给用户。
// INV-15: 结果行 key 用 status+sourceScope+path 三元组，path 同样不做归一化。
//        破坏后果：同一路径先 skipped 后 imported 的两条结果共用 key，React 复用错行。
// INV-16: displayError 优先取扫描错误 error，其次才是导入错误 importError。
//        破坏后果：扫描失败后仍展示上次导入错误，用户按提示去修一件不相关的事。
// INV-17: settingsSyncService 由调用方按目标 workspace 注入，组件内不自行解析服务。
//        破坏后果：跨 host 时按当前激活 workspace 解析路径，把文件写到另一台机器的目录。
// INV-18: targetScope 必须作为参数随 importSelected 一起传，并在调用瞬间重建 selections。
//        破坏后果：复用渲染期缓存的 selections，用户在点击前改过 target，就会写到旧目标。
// INV-19: 日志只记 category / targetScope / 数量 / 错误消息，不记资源路径列表。
//        破坏后果：路径含用户名与项目名，日志被回收后等于泄露目录结构。
// INV-20: 所有文案 id 由 category 拼接，新增类别必须同时补齐四套 message。
//        破坏后果：缺 key 时界面直接渲染 "settings.xxx.import.title" 这类原始 id。
// INV-21: 组件只持有本次调用返回的 result 快照，不把导入后的服务端事实当作长期状态。
//        破坏后果：把 result 当权威列表，父级刷新后弹窗与真实列表长期分叉。
// INV-22: 扫描结果的展示分组（global / project）在这里推导，但「导入到哪」绝不从分组反推。
//        破坏后果：来源 scope 与目标 scope 被绑死，用户无法把全局配置导入当前项目。
// ============================================================================
// [权衡] 类型全部用 import type 引入：shared 包里 schema 与类型同文件，值导入会把 zod
// 实现拖进 UI bundle；运行时需要的枚举（source scope / import mode）则用本文件的常量数组。
/* eslint-disable max-lines -- 外部 Agent 导入弹窗复用 skills/commands 的交互状态机，业务扫描与导入在服务层按类别分开 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  Loader2Icon,
  MinusIcon,
  RefreshCw,
  XIcon,
} from "lucide-react";
import type {
  SettingsSyncAgentSummary,
  SettingsSyncCategory,
  SettingsSyncCommandImportResult,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
  SettingsSyncImportMode,
  SettingsSyncMcpServerImportResult,
  SettingsSyncSourceMcpServerSummary,
  SettingsSyncPluginImportResult,
  SettingsSyncSkillImportResult,
  SettingsSyncSourceCommandSummary,
  SettingsSyncSourcePluginSummary,
  SettingsSyncSourceSkillSummary,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceScope,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Progress } from "@/components/ui/progress.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { ISettingsSyncService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

// step 是弹窗自己的状态机，不是服务层事实：选择页可以反复进出，importing 只包住一次 await，
// complete 只能由一次成功的 importSelected 进入。刻意不合并成 { status, result } 对象，
// 因为 result 只在 complete 后有意义，合并后每次读 result 都要额外判断「属于哪一轮」。
type ImportStep = "selection" | "importing" | "complete";
// 四类资源共用同一套扫描/勾选/导入实现，类型上用 Extract 从共享枚举里裁出这四项：
// 这里不新定义一个平行枚举，否则 shared 侧新增类别时不会在这里产生编译错误，
// 只会静默落到下面 if/else 链的 mcpServers 兜底分支。
export type ImportResourceCategory = Extract<SettingsSyncCategory, "skills" | "commands" | "plugins" | "mcpServers">;
// 来源条目与导入结果各是一个判别式联合：两者字段并不一一对应（结果多 status/skipReason），
// 所以分开声明而不是相互 Pick，避免把「扫描时的猜测」与「导入后的结论」混成同一个类型。
type ImportItemSummary =
  | SettingsSyncSourceSkillSummary
  | SettingsSyncSourceCommandSummary
  | SettingsSyncSourcePluginSummary
  | SettingsSyncSourceMcpServerSummary;
type ImportItemResult =
  | SettingsSyncSkillImportResult
  | SettingsSyncCommandImportResult
  | SettingsSyncPluginImportResult
  | SettingsSyncMcpServerImportResult;

// 弹窗对外的契约只有五件事：是否打开、写到哪个 workspace、用哪个 service、怎么通知关闭、
// 导入后如何刷新。所有扫描/选择/导入细节都不外泄，调用方只能通过 category 包装组件选择类别。
interface ExternalAgentImportDialogProps {
  // open 由父级持有：弹窗不自己决定何时关闭，导入成功后也不自动关，
  // 因为结果列表是用户唯一能看到「哪些项失败、为什么失败」的地方。
  open: boolean;
  // workspacePath 同时用于扫描来源推断（哪个目录算项目级来源）与 project 目标是否可选；
  // 传 null 表示当前没有打开的工作区，此时只能导入到 global。
  workspacePath: string | null | undefined;
  // workspaceIdentity 与 workspacePath 分离：前者做身份隔离（缓存/去重键），
  // 后者做实际文件操作；只传路径会让同名不同机的 workspace 在服务层互相串缓存。
  workspaceIdentity?: string;
  // detect/importSelected 携带调用方传入的 target 路径，但 service 曾取自
  // useServices()（当前激活 workspace）。跨 host 时会在 A 的主机上按 B 的路径解析并做
  // symlink/copy 落盘。改为必传，由调用方按 Scope target 解析后注入。
  settingsSyncService: ISettingsSyncService;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void> | void;
}

// 分类包装组件与内部实现共用同一批 props，只多一个 category；
// 继承而不是重新声明，保证新增 prop（例如将来的 target 解析钩子）只改一处。
interface CategorizedExternalAgentImportDialogProps extends ExternalAgentImportDialogProps {
  category: ImportResourceCategory;
}

// 资源选择 key 的载荷结构单独声明：它是「UI 选择集」与「服务层 selection」之间唯一的桥，
// 反解时字段名必须与此处一致，因此不能退化成裸字符串元组。
interface ResourceSelectionKeyPayload {
  agent: string;
  // category 参与 key 却不参与反解后的语义判断（由调用方带上下文），
  // 但必须入 key：同一个路径在不同类别下可能是合法的不同资源。
  category: ImportResourceCategory;
  // sourceScope 可选：旧版本扫描结果可能不给 scope，此时该资源只按 agent+path 去重。
  sourceScope?: SettingsSyncSourceScope;
  resourcePath: string;
}

// 来源行 key 故意只到 agent+category+scope，不含 path：同一 agent 的 global 与 project
// 是两个可独立展开的分组，scope 不进 key 就会让两行共享同一份展开状态。
// 用 ":" 拼接而不 JSON，是因为它只做 React key 与集合成员，不参与跨进程传输、无需反解。
function getSourceSelectionKey(
  agent: string,
  category: string,
  sourceScope?: SettingsSyncSourceScope,
): string {
  return sourceScope ? `${agent}:${category}:${sourceScope}` : `${agent}:${category}`;
}

// 资源级 key 必须可反解：它进 selectedKeys 数组，提交时再拆回四个字段。
// 用 JSON 而不是拼接，是因为 Windows 路径本身含 ":"（C:\Users\...），
// 任何分隔符拼接方案都无法无歧义切分，一遇到盘符就会把路径切成多段。
function getResourceSelectionKey(payload: ResourceSelectionKeyPayload): string {
  // 字段顺序由这里固定：同内容不同书写顺序会得到不同 key（JSON.stringify 保留插入序），
  // 所以构造 key 的地方必须只走这两个函数，不能各自手写对象字面量。
  return JSON.stringify(payload);
}

// [失败路径] key 来自 selectedKeys，理论上只由 getResourceSelectionKey 产生，
// 但仍显式校验并返回 null：一旦有人手写非法 key，或旧版本 key 残留在恢复出来的状态里，
// 解析失败必须让这一项被跳过，而不是抛异常把整次导入打崩。
function readResourceSelectionKey(key: string): ResourceSelectionKeyPayload | null {
  try {
    const payload = JSON.parse(key) as Partial<ResourceSelectionKeyPayload>;
    // 三个必填字段都要求 string，category 不做枚举校验：合法集合由 shared 的
    // SettingsSyncCategory 决定，在这里复制一份枚举只会在上游扩类时漂移。
    if (
      typeof payload.agent !== "string" ||
      typeof payload.category !== "string" ||
      typeof payload.resourcePath !== "string"
    ) {
      return null;
    }
    // 只重建已知字段，把 JSON 里可能夹带的额外键丢掉：
    // 这个对象稍后会参与服务层调用，不能把不明来源的字段透传过去。
    return {
      agent: payload.agent,
      category: payload.category as ImportResourceCategory,
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      resourcePath: payload.resourcePath,
    };
  } catch {
    return null;
  }
}

// 把扁平的 selectedKeys 折叠成按 agent+category+sourceScope 分组的 selections：
// 服务层每个来源只接受一条 selection（组内是路径数组），而不是一个文件一条。
// 逐文件提交会让同一来源被反复打开/写入，同名覆盖检测也会从「整批」退化成「逐个」。
export function buildExternalAgentImportSelections(
  selectedKeys: string[],
  targetScope: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode,
): SettingsSyncSelection[] {
  const grouped = new Map<string, SettingsSyncSelection>();
  for (const key of selectedKeys) {
    const payload = readResourceSelectionKey(key);
    // [失败路径] 解析不出的 key 直接丢弃：这里的选择集最终会驱动磁盘写入，
    // 宁可少导入一项，也不能把不确定的路径交给服务层去猜。
    if (!payload) {
      continue;
    }
    // 分组键用 JSON.stringify([agent, category, sourceScope ?? null]) 而不是拼接：
    // undefined 与缺省必须折叠成同一个 key（未声明来源视为无来源），否则同一来源会分裂成两组，
    // 服务层收到两条 selection 就会对同一目录做两次同名覆盖判断。
    const groupKey = JSON.stringify([
      payload.agent,
      payload.category,
      payload.sourceScope ?? null,
    ]);
    // [权衡] 初始化时先把该类别对应的路径字段建成空数组，而不是等第一次 append 再补：
    // SettingsSyncSelection 各分支的路径字段名不同且必填，缺字段会让下游按 category
    // 取路径时读到 undefined 并静默跳过整组（表现为「点了导入但什么都没发生」）。
    const selection = grouped.get(groupKey) ?? {
      agent: payload.agent as SettingsSyncSelection["agent"],
      category: payload.category as SettingsSyncSelection["category"],
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      // targetScope 来自本次调用参数而不是 payload：payload 只描述「选了什么」，
      // 「放到哪」是用户点击按钮那一刻的决定，两者可能不同（浏览 global、导入 project）。
      targetScope,
      importMode,
      ...(payload.category === "skills"
        ? { skillPaths: [] }
        : payload.category === "commands"
          ? { commandPaths: [] }
          : payload.category === "plugins"
            ? { pluginPaths: [] }
            : { mcpServerPaths: [] }),
    };
    // [权衡] 用 category 的 if/else 链而不是按字段名动态索引：最后一个 else 兜底 mcpServers，
    // 新增第五类资源时这里不会报编译错，而是静默落进 mcpServerPaths。
    // 因此新增类别必须同时改这里、getImportResults、getSourceRootItems 三处分发。
    if (payload.category === "skills") {
      selection.skillPaths = [...(selection.skillPaths ?? []), payload.resourcePath];
    } else if (payload.category === "commands") {
      selection.commandPaths = [...(selection.commandPaths ?? []), payload.resourcePath];
    } else if (payload.category === "plugins") {
      selection.pluginPaths = [...(selection.pluginPaths ?? []), payload.resourcePath];
    } else {
      selection.mcpServerPaths = [...(selection.mcpServerPaths ?? []), payload.resourcePath];
    }
    grouped.set(groupKey, selection);
  }
  // 输出顺序由 Map 插入序决定，即 selectedKeys 的顺序；调用方不依赖顺序，
  // 但保持稳定能让日志与测试断言可复现（同一次选择两次提交得到相同请求体）。
  return [...grouped.values()];
}

// [失败路径] 服务层抛出的可能不是 Error（跨进程 RPC 反序列化后常是字符串或普通对象），
// 直接读 .message 会得到 undefined，UI 上就显示 "undefined"。String(error) 至少保留可读文本。
// 这里不做截断与脱敏：脱敏职责在写日志前的调用点，界面需要完整消息帮用户定位。
function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 从导入结果里挑出当前类别的条目：一次 importSelected 可能产出多个 taskResult（每个 task 一条），
// 所以必须 flatMap 展平，只看第一个会漏掉后续任务的条目，用户会以为一半的选择没生效。
function getImportResults(
  result: SettingsSyncImportResult | null,
  category: ImportResourceCategory,
): ImportItemResult[] {
  // result 为 null（尚未导入 / 已被 open 重置）时返回空数组而不是抛错：
  // 结果列表在 complete 之前也可能被渲染一次，必须允许空输入。
  return result?.taskResults.flatMap((taskResult) =>
    // 与 buildExternalAgentImportSelections 同构的四路分发，同样以 else 兜底 mcpServers。
    category === "skills"
      ? taskResult.skillResults ?? []
      : category === "commands"
        ? taskResult.commandResults ?? []
        : category === "plugins"
          ? taskResult.pluginResults ?? []
          : taskResult.mcpServerResults ?? [],
  ) ?? [];
}

// agent 是协议枚举字符串，展示必须走 i18n；default 分支返回原值而不是抛错，
// 是为了让新版 Host 上报的未知 agent 仍能显示（降级为英文标识），
// 而不是让整份来源列表因为一条未知记录渲染失败。
function formatAgentName(
  agent: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  switch (agent) {
    case "claudeCode":
      return intl.formatMessage({ id: "settingsSync.agent.claudeCode" });
    case "codexCli":
      return intl.formatMessage({ id: "settingsSync.agent.codexCli" });
    case "openCode":
      return intl.formatMessage({ id: "settingsSync.agent.openCode" });
    case "openClaw":
      return intl.formatMessage({ id: "settingsSync.agent.openClaw" });
    case "augment":
      return intl.formatMessage({ id: "settingsSync.agent.augment" });
    case "continue":
      return intl.formatMessage({ id: "settingsSync.agent.continue" });
    case "goose":
      return intl.formatMessage({ id: "settingsSync.agent.goose" });
    case "qwenCode":
      return intl.formatMessage({ id: "settingsSync.agent.qwenCode" });
    case "qode":
      return intl.formatMessage({ id: "settingsSync.agent.qode" });
    case "qodeCn":
      return intl.formatMessage({ id: "settingsSync.agent.qodeCn" });
    case "windsurf":
      return intl.formatMessage({ id: "settingsSync.agent.windsurf" });
    case "trae":
      return intl.formatMessage({ id: "settingsSync.agent.trae" });
    case "traeCn":
      return intl.formatMessage({ id: "settingsSync.agent.traeCn" });
    case "kiroCli":
      return intl.formatMessage({ id: "settingsSync.agent.kiroCli" });
    case "roo":
      return intl.formatMessage({ id: "settingsSync.agent.roo" });
    case "codeBuddy":
      return intl.formatMessage({ id: "settingsSync.agent.codeBuddy" });
    case "agents":
      return intl.formatMessage({ id: "settingsSync.agent.agents" });
    case "zcode":
      return intl.formatMessage({ id: "settingsSync.agent.zcode" });
    default:
      return agent;
  }
}

// 返回 undefined 而不是抛错或缺省对象：调用方需要区分「这个 agent 根本没有该类别」
// （不渲染这一行）与「有类别但本次扫到 0 项」（渲染空态）。
// 把两种缺失合并成一个空对象，会让界面多出一批永远为空的分组。
function getResourceCategory(
  agent: SettingsSyncAgentSummary,
  resourceCategory: ImportResourceCategory,
) {
  return agent.categories.find((category) => category.category === resourceCategory);
}

// 顺序即 UI 顺序：global 在前，因为多数用户先看全局配置；两个数组都固定，
// 不从数据里推导顺序——按数据出现顺序渲染会让同一份配置在不同机器上排列不同。
const SOURCE_ROOT_SCOPE_ORDER: SettingsSyncSourceScope[] = ["global", "project"];
// symlink 在前：它不复制内容，源目录后续更新会自动生效，是更「轻」的默认选择；
// copy 作为显式退路，用于跨盘/跨主机等不支持软链的场景。
const IMPORT_MODE_ORDER: SettingsSyncImportMode[] = ["symlink", "copy"];

// scope 文案的 id 里带 category：不同资源对 global/project 的解释不同
// （skills 是安装目录，mcpServers 是配置文件位置），共用一条文案会造成误导。
function formatSourceRootScope(
  scope: SettingsSyncSourceScope,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  resourceCategory: ImportResourceCategory,
): string {
  return intl.formatMessage({ id: `settings.${resourceCategory}.import.scope.${scope}` });
}

// 与 getImportResults 同构的类别分发：sourceRoot 上四类数组只有一个是有效的。
// 同样以 else 兜底 mcpServers，新增类别必须同步修改三处分发点。
function getSourceRootItems(
  sourceRoot: SettingsSyncSourceRootSummary,
  resourceCategory: ImportResourceCategory,
): ImportItemSummary[] {
  return resourceCategory === "skills"
    ? sourceRoot.skills ?? []
    : resourceCategory === "commands"
      ? sourceRoot.commands ?? []
      : resourceCategory === "plugins"
        ? sourceRoot.plugins ?? []
        : sourceRoot.mcpServers ?? [];
}

// 只做两件事：反斜杠转正斜杠、去掉尾部斜杠。刻意不折叠大小写、不 resolve symlink：
// 这里的唯一用途是判断「来源目录是否落在 workspace 之下」这一展示分组，
// 折叠大小写会把 Windows 上两个真实存在但大小写不同的目录判成同一个。
function normalizePathForScope(path: string): string {
  // replaceAll 而非 replace(/\\/g)：Windows 路径可能有多段反斜杠（UNC 前缀），
  // 只替换第一处会让比较基准与真实路径不一致。
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

// [权衡] 没有 workspacePath 时一律判为 global，而不是猜 project：
// 猜错会把全局配置显示在项目分组里；更糟的是用户按分组语义决定导入目标时，
// 目标范围判断也会跟着错，等于把全局配置写进一个不存在的项目目录。
function inferSourceRootScope(
  path: string,
  workspacePath: string | null | undefined,
): SettingsSyncSourceScope {
  if (!workspacePath) {
    return "global";
  }
  const normalizedPath = normalizePathForScope(path);
  const normalizedWorkspacePath = normalizePathForScope(workspacePath);
  // 前缀比较必须带上 "/"：只比较 startsWith(ws) 会把 /work/repo2 判成 /work/repo 的子目录，
  // 从而把另一个项目的配置混进本项目分组，用户会误以为那是本项目的技能。
  return normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
    ? "project"
    : "global";
}

// 优先使用服务层给出的 sourceRoots（带 scope 与各自计数），只有旧版本服务层没给时才
// 回退到 sourcePaths 自行推断。反过来做（有 sourceRoots 还拿 sourcePaths 补齐）会重复出行。
function getSourceRoots(
  agent: SettingsSyncAgentSummary,
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): SettingsSyncSourceRootSummary[] {
  const category = getResourceCategory(agent, resourceCategory);
  // agent 没有该类别时返回空数组：上层靠 length===0 判断「这个 agent 不值得显示」，
  // 这里不能返回一个带空路径的占位对象，否则列表里会冒出没有任何内容的行。
  if (!category) {
    return [];
  }
  if (category.sourceRoots && category.sourceRoots.length > 0) {
    return category.sourceRoots;
  }
  // [失败路径] 回退分支把 category 级计数原样摊到每个 path 上，这是已知的粗略近似：
  // 它只影响「是否显示该分组」，不影响真正导入哪些项（导入仍按精确 path 提交）。
  return (category.sourcePaths ?? []).map((path) => ({
    scope: inferSourceRootScope(path, workspacePath),
    path,
    discoveredCount: category.discoveredCount,
    importableCount: category.importableCount,
    skippedCount: category.skippedCount,
  }));
}

// 先按 scope 固定顺序建两组，再往里填行：即使某个 scope 一行都没有也保留空分组，
// 供上层渲染「该项目范围没有可导入项」的空态。若按数据动态生成 scope，
// 用户在切到空 scope 时会找不到任何可点的 tab，误以为功能坏了。
function groupAgentsBySourceRootScope(
  agents: SettingsSyncAgentSummary[],
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): Array<{
  scope: SettingsSyncSourceScope;
  rows: Array<{
    agent: SettingsSyncAgentSummary;
    sourceRoot: SettingsSyncSourceRootSummary;
  }>;
}> {
  return SOURCE_ROOT_SCOPE_ORDER.map((scope) => ({
    scope,
    rows: agents.flatMap((agent) =>
      getSourceRoots(agent, workspacePath, resourceCategory)
        .filter((sourceRoot) => sourceRoot.scope === scope)
        // 过滤掉没有任何 importable 项的来源目录：只列「点进去必然为空」的目录，
        // 会让全选与计数失去意义（分母为 0 却仍显示一行），也诱导用户做无效点击。
        .filter((sourceRoot) =>
          getSourceRootItems(sourceRoot, resourceCategory).some((item) => item.importable),
        )
        .map((sourceRoot) => ({ agent, sourceRoot })),
    ),
  }));
}

// 四个薄包装只负责固定 category，不复用同一个组件实例：
// 让每个入口在 React DevTools 与错误栈里可区分，也避免父级切换类别时
// 复用同一份内部状态（step / selectedKeys）造成跨类别串选。
export function SkillsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="skills" />;
}

// commands 与 skills 的差异只在服务层：命令是单文件、技能是目录，
// 但在本文件里两者的交互完全一致，因此这里不复制任何逻辑，只换 category。
// 一旦将来命令需要多一个「作用域前缀」选项，也必须加在内部实现里按 category 分支，
// 而不是在这里分叉出第二套状态机。
export function CommandsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="commands" />;
}

// plugins 的扫描结果是插件清单而不是文件路径，但选择与导入链路仍然同构；
// 保持同样的包装形态，可以让四个入口的 props 完全一致，
// 设置页无需为不同类别写不同的挂载代码。
export function PluginsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="plugins" />;
}

// mcpServers 是唯一不渲染 importMode 的类别（服务层做配置合并而非文件链接），
// 但这里仍然走同一个组件：开关由内部按 category 判断，
// 而不是在外面换一个组件——两套组件会让「结果展示、错误处理」这些共性逻辑分叉。
export function McpServersImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="mcpServers" />;
}

// 该 hook 的返回值就是一个类别的完整交互状态，同时被弹窗和嵌入式面板消费：
// 因此字段必须是 UI 无关的可序列化状态 + 稳定回调，不能塞 DOM 节点、ref 或 JSX，
// 否则两个消费方会各自绑上不同的渲染假设。
export interface ExternalAgentImportCategoryState {
  // activeScope 只影响「当前展示哪一组来源」，不参与导入目标推导（见 INV-4）。
  activeScope: SettingsSyncSourceScope;
  // discovery 为 null 表示「从未扫描过」，空 agents 表示「扫描过但没有结果」：
  // 两者的区别驱动自动扫描的 effect，合并成一种会让失败后无限自动重试。
  discovery: SettingsSyncDiscoveryResult | null;
  error: string | null;
  expandedSourceKeys: string[];
  importMode: SettingsSyncImportMode;
  importTargetScope: SettingsSyncSourceScope;
  loading: boolean;
  selectedCount: number;
  selectedKeys: string[];
  selections: SettingsSyncSelection[];
  totalImportableCount: number;
  // loadDiscovery 暴露给「重扫」按钮：调用即覆盖 discovery 并清空选择，
  // 调用方不需要（也不应该）自己拼 detect 参数，否则扫描口径会在两处漂移。
  loadDiscovery: () => Promise<void>;
  setActiveSourceScope: (scope: SettingsSyncSourceScope) => void;
  setImportMode: (mode: SettingsSyncImportMode) => void;
  setImportTargetScope: (scope: SettingsSyncSourceScope) => void;
  // setResourceSelection 是批量版本：单行勾选与整组全选共用同一条写入路径，
  // 避免两处各自 setState 在快速连点时互相覆盖（后写的那次会丢掉前一次的点选）。
  setResourceSelection: (keys: string[], checked: boolean) => void;
  toggleExpanded: (key: string) => void;
  toggleSelection: (key: string) => void;
}

// 一个类别一份状态：弹窗与嵌入式面板各自调用一次，互不共享。
// enabled 只控制「是否允许自动扫描」，不控制是否保留状态——关闭弹窗后再打开时，
// 是否重置由上层 open 变化决定，这个 hook 不感知 open 的语义。
export function useExternalAgentImportCategoryState({
  category,
  enabled,
  settingsSyncService,
  workspaceIdentity,
  workspacePath,
}: {
  category: ImportResourceCategory;
  enabled: boolean;
  settingsSyncService: ISettingsSyncService;
  workspacePath: string | null | undefined;
  workspaceIdentity?: string;
}): ExternalAgentImportCategoryState {
  const [loading, setLoading] = useState(false);
  const [discovery, setDiscovery] = useState<SettingsSyncDiscoveryResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [expandedSourceKeys, setExpandedSourceKeys] = useState<string[]>([]);
  // 两个 scope 初值都是 global：首次打开时项目目录尚未确定（workspacePath 可能为 null），
  // 把默认值设成 project 会让按钮一开始就处于禁用态，看起来像功能不可用。
  const [activeScope, setActiveScope] = useState<SettingsSyncSourceScope>("global");
  const [importTargetScope, setImportTargetScope] =
    useState<SettingsSyncSourceScope>("global");
  // 默认 symlink：不复制内容、源更新可跟随，是四类资源里最常用的导入方式；
  // mcpServers 不读这个值，但仍保留状态以免切换类别时控件闪变。
  const [importMode, setImportMode] = useState<SettingsSyncImportMode>("symlink");
  const [error, setError] = useState<string | null>(null);

  // 总数用于底部「共 N 项」与选择计数的分母。这里累加所有 agent 所有类别的 importableCount，
  // 而不是数 discovery 里的条目数组：服务层可能只回摘要不回落全量条目，
  // 按条目数算会在「存在 skipped 项」时把分母算小，出现 N/N 却仍有未选项的矛盾。
  const totalImportableCount = useMemo(
    () =>
      discovery?.agents.reduce(
        (sum, agent) =>
          sum +
          agent.categories.reduce(
            (categorySum, category) => categorySum + category.importableCount,
            0,
          ),
        0,
      ) ?? 0,
    [discovery],
  );

  // [并发] 重扫直接覆盖 discovery 而不做请求序号校验：同一时刻只允许一次扫描
  // （自动扫描有 loading 守卫，按钮在 loading 时禁用），不存在两个 in-flight 请求。
  // 若将来放开并发，必须补 requestId/AbortController，否则慢请求会覆盖新结果。
  const loadDiscovery = useCallback(async () => {
    setLoading(true);
    // 每次扫描先清旧错误：否则扫描成功后错误横幅仍在，用户会以为重扫没生效。
    setError(null);
    try {
      // intent 明确标记 manualImport：服务层据此决定扫描深度与是否复用缓存。
      // 漏传会被当成后台探测，回包字段可能不全，列表就会缺行。
      const nextDiscovery = await settingsSyncService.detect({
        workspacePath: workspacePath ?? undefined,
        workspaceIdentity,
        categories: [category],
        intent: "manualImport",
      });
      setDiscovery(nextDiscovery);
      // 扫描成功必须清空选择与展开态：新结果里被选中的路径可能已不存在
      // （源目录被删除/改名），保留旧选择会提交出一批必然 failed 的条目。
      setSelectedKeys([]);
      setExpandedSourceKeys([]);
      // 两个 scope 一起回到 global：扫描后用户面对的是全新列表，
      // 沿用上一次的 project 视角会让新数据一打开就是空的。
      setActiveScope("global");
      setImportTargetScope("global");
    } catch (loadError) {
      const message = normalizeError(loadError);
      logger.error("[ExternalAgentImportDialog] scan failed", { category, error: message });
      setError(message);
      // [失败路径] 扫描失败也要落一个空 discovery：否则 effect 里 !discovery 恒真，
      // loading 变 false 的瞬间会再次触发自动扫描，形成失败重试风暴（每次失败都再扫）。
      setDiscovery({ agents: [] });
      // 失败时同样清空选择：列表已经不可信，留着勾选只会让用户误以为还能提交。
      setSelectedKeys([]);
    } finally {
      // [资源] loading 必须在 finally 回收：异常逃逸后按钮的禁用态与 effect 守卫都依赖它，
      // 漏掉会让 UI 永远停在「扫描中」，用户只能关掉弹窗再打开。
      setLoading(false);
    }
  }, [category, settingsSyncService, workspaceIdentity, workspacePath]);

  // 自动扫描只在「已启用 + 从未扫描 + 不在扫描中」时触发。discovery 一旦有值（哪怕是空数组）
  // 就不再自动重试，把重试权交给用户点重扫——扫描是 IO 密集操作，
  // 打开弹窗时自动连锁重试会拖慢整个设置页。
  useEffect(() => {
    if (!enabled || discovery || loading) {
      return;
    }
    void loadDiscovery();
  }, [discovery, enabled, loadDiscovery, loading]);

  // 单行勾选与批量勾选都用 Set 复制后重建数组：selectedKeys 是 selections 的 useMemo 依赖，
  // 必须换引用才能触发重算；原地改数组不会让 useMemo 失效，提交时仍是旧选择。
  const toggleSelection = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      // 用展开而不是 Array.from：这里只关心得到一个普通数组，展开写法与其余代码一致。
      return [...next];
    });
  }, []);

  // 批量写入在同一个 updater 里完成：整组全选的几十个 key 必须一次性生效，
  // 拆成多次 setSelectedKeys 会让 React 批处理之外的立即读取（下一次渲染前的
  // selections 计算）看到中间态，出现「全选了一秒又被还原」。
  const setResourceSelection = useCallback((keys: string[], checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return [...next];
    });
  }, []);

  // 展开状态按 sourceKey（含 path）存：同一 agent 在两个目录下的分组要能独立展开；
  // 只用 agent 名做 key 会让两个目录的展开动作互相影响。
  const toggleExpanded = useCallback((key: string) => {
    setExpandedSourceKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }, []);

  // 切来源 scope 时把导入目标一起切到同值：用户切到 project 来源，
  // 绝大多数情况下就是想导到 project；两处不同步会出现「看着项目来源、导到全局」。
  // 反向不成立：改导入目标不应改浏览范围，否则用户刚选好的列表会突然跳走。
  const setActiveSourceScope = useCallback((nextScope: SettingsSyncSourceScope) => {
    setActiveScope(nextScope);
    setImportTargetScope(nextScope);
  }, []);

  // selections 每次都由 selectedKeys 重建，不缓存上一次结果：导入目标或模式变化后，
  // 即使选择集没变，提交内容也必须跟着变，因此 targetScope 与 importMode 都在依赖里。
  // [权衡] 每次渲染重建有开销，但选择集通常只有几十项，可读性优先于这点 CPU。
  const selections = useMemo(
    () => buildExternalAgentImportSelections(selectedKeys, importTargetScope, importMode),
    [importMode, importTargetScope, selectedKeys],
  );

  return {
    // 返回值每次渲染都是新对象，但下游没有依赖它做 memo 的消费者（弹窗直接解构使用），
    // 所以不需要 useMemo 包裹；若将来有人把它放进依赖数组，必须先把返回值稳定下来，
    // 否则每次渲染都会触发一次多余的重算。
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount: selectedKeys.length,
    selectedKeys,
    selections,
    totalImportableCount,
    loadDiscovery,
    setActiveSourceScope,
    setImportMode,
    setImportTargetScope,
    setResourceSelection,
    toggleExpanded,
    toggleSelection,
  };
}

// 弹窗本体只负责三件事：step 状态机、一次导入调用、失败与结果的呈现。
// 扫描与选择全部外包给 useExternalAgentImportCategoryState，本组件不直接调用 detect，
// 这样嵌入式面板（ExternalAgentImportSelectionPanel）能与弹窗共享完全相同的交互语义。
function ExternalAgentImportDialog({
  category,
  open,
  workspacePath,
  workspaceIdentity,
  settingsSyncService,
  onOpenChange,
  onImported,
}: CategorizedExternalAgentImportDialogProps) {
  const { intl } = useZCodeIntl();
  const [step, setStep] = useState<ImportStep>("selection");
  // importing 与 step==="importing" 看起来重复，但用途不同：step 决定渲染哪一页，
  // importing 是 finally 里回收的「有请求在飞」标志，成功路径切到 complete 后它才变 false。
  // 合并成一个值会让「complete 但请求尚未 resolve」这种中间态无法表达。
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<SettingsSyncImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // 先解构再使用：hook 返回的是每次渲染新建的对象，直接把它放进依赖数组会让
  // startImport 每帧都重建；解构后依赖的是 string/array/函数等稳定值，
  // useCallback 才能真正命中缓存（否则导入按钮每次渲染都换新引用，无谓重渲子树）。
  const importState = useExternalAgentImportCategoryState({
    category,
    // enabled 跟 open 走：弹窗关闭后不再自动扫描，但已有 discovery 保留，
    // 再次打开时可以立即渲染上次结果，省掉一次全盘扫描。
    enabled: open,
    settingsSyncService,
    workspacePath,
    workspaceIdentity,
  });
  const {
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount,
    selectedKeys,
    totalImportableCount,
  } = importState;
  // 解构清单必须与 hook 的返回字段保持同步：这里漏掉的字段在 TS 下会报错，
  // 但如果有人加了可选字段，漏掉只会表现为「界面某处永远是默认值」，
  // 所以改动 ExternalAgentImportCategoryState 时要回头核对这一处。

  // 进度是纯展示的估算值：服务层 importSelected 是一次原子调用、不回传中间进度，
  // 所以这里只有 0 / 62 / 100 三个刻度。真实进度不可得，也不该伪造更多刻度，
  // 否则用户会按进度条估算耗时，在慢盘上误以为卡死。
  const importProgress = step === "complete" ? 100 : importing ? 62 : 0;
  // getImportResults 每次从 result 重新投影，而不是导入完成时算一次存起来：
  // result 是唯一事实，派生值多存一份就会在 open 重置时忘记清理，显示上一轮的行。
  const importedResults = useMemo(() => getImportResults(result, category), [category, result]);
  // 扫描错误优先于导入错误：扫描失败时后续的「导入失败」多半是连带结果，
  // 展示更上游的那条才指向真正的修法（例如权限被拒导致整次 detect 失败）。
  const displayError = error ?? importError;

  // 只在 open 变 true 时重置。注意不重置 selectedKeys/discovery：它们由 hook 管理，
  // 重开弹窗复用上次扫描结果可以省一次 IO，用户刚勾好的项也还在。
  // [资源] 重置点放在 open 而不是 unmount：Dialog 关闭后子树可能仍挂载以播完退出动画，
  // 若在 unmount 清理，动画期间会读到已清空的状态并闪一下空列表。
  useEffect(() => {
    if (!open) {
      return;
    }
    setResult(null);
    setImportError(null);
    setStep("selection");
  }, [open]);

  // [并发] startImport 没有内部互斥锁，靠 UI 保证单飞：进入 importing 后按钮被卸载
  // （step 不再等于 selection），因此不存在两次点击同时穿过入口检查。
  // 若将来把导入按钮保留在 importing 页，必须在函数入口补 if (importing) return。
  const startImport = useCallback(async (targetScope: SettingsSyncSourceScope) => {
    // [失败路径] 空选择直接返回而不是抛错：按钮本身已被禁用，这里只是兜住
    // 禁用态被键盘或程序化点击的路径，保持操作幂等（重复点击不会产生请求）。
    if (selectedKeys.length === 0) {
      return;
    }
    // [事务] 三段赋值顺序固定：先置 importing（关掉重复入口），再切 step（切 UI），
    // 最后清旧错误。反序会让 importing 页短暂显示上一次的失败原因，看起来像刚失败。
    setImporting(true);
    setStep("importing");
    setImportError(null);
    try {
      // 日志只记数量与目标，不记路径列表（见 INV-19）；debug 级别因为这是高频交互入口。
      logger.debug("[ExternalAgentImportDialog] import start", {
        category,
        targetScope,
        importMode,
        selectedCount: selectedKeys.length,
      });
      // [权衡] 这里用闭包里的 selectedKeys，而不是等状态更新后再读：导入是用户点击瞬间的
      // 意图快照。期间若后台重扫清空了选择，也不该改变这次提交的内容。
      // targetScope 显式作为参数传入，保证提交目标与进度页显示的目标一致。
      const importResult = await settingsSyncService.importSelected({
        workspacePath: workspacePath ?? undefined,
        workspaceIdentity,
        selections: buildExternalAgentImportSelections(selectedKeys, targetScope, importMode),
      });
      // [事务] 先落 result 再切 complete：两者在同一个同步块里，React 会合并成一次渲染，
      // 不会出现 complete 页读到旧 result 而显示 0/0/0 的中间帧。
      setResult(importResult);
      setStep("complete");
      // [失败路径] onImported 抛错会进入下面的 catch，但此时结果已经落定：
      // catch 只把消息写进 importError 并退回 selection，用户看到的是「刷新失败」
      // 而不是「导入失败」。因此这一句必须排在 setStep 之后，不能前置。
      await onImported();
    } catch (importError) {
      const message = normalizeError(importError);
      logger.error("[ExternalAgentImportDialog] import failed", { category, error: message });
      // 失败只记错误并退回选择页，不清选择（见 INV-9），用户可以原地重试。
      setImportError(message);
      setStep("selection");
    } finally {
      // [资源] finally 只回收 importing 标志；step 由成功/失败分支各自决定。
      // 放在这里统一改 step 会抹掉「失败回选择页」与「成功留结果页」的区别。
      setImporting(false);
    }
  }, [
    onImported,
    category,
    importMode,
    selectedKeys,
    settingsSyncService,
    workspaceIdentity,
    workspacePath,
  ]);

  // 完成态按钮文案换成「完成」而不是「跳过」：此时唯一的语义是关闭弹窗，
  // 继续叫「跳过」会让用户以为还有未做的选择，回头再点一次导入。
  const closeLabel = step === "complete"
    ? intl.formatMessage({ id: `settings.${category}.import.finish` })
    : intl.formatMessage({ id: "settingsSync.action.skip" });

  // 渲染树的四层分工（自上而下）：
  //   1) Dialog/DialogContent 只负责遮罩、定位与关闭手势，不承载业务；
  //   2) 外层 flex 列负责把高度锁在 min(84vh,640px)，避免长列表把弹窗撑出屏幕；
  //   3) 中间列表区是唯一可滚动区域（overflow-auto + min-h-0），
  //      min-h-0 必不可少：flex 子项默认 min-height:auto，去掉后滚动容器会被内容撑开，
  //      表现为整页滚动而不是列表内部滚动；
  //   4) 底部操作条 shrink-0，保证滚动时按钮永远可见。
  // 条件渲染优先级与状态机一致：loading 先于 step（扫描中不该出现导入进度），
  // step 先于列表（importing/complete 时不应再展示可勾选列表，否则用户会以为还能改选择）。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(84vh,640px)] max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden rounded-2xl p-0">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-5">
            <DialogHeader className="shrink-0 sm:-mt-1">
              <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center sm:justify-between">
                <DialogTitle className="flex min-w-0 items-center text-ui-lg">
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: `settings.${category}.import.title` })}
                  </span>
                </DialogTitle>
                {step === "selection" && !loading && discovery?.agents.length ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <SourceScopeSelect
                      category={category}
                      activeScope={activeScope}
                      onActiveScopeChange={importState.setActiveSourceScope}
                    />
                    <ControlHintTooltip
                      title={intl.formatMessage({ id: "settingsSync.action.rescan" })}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={intl.formatMessage({ id: "settingsSync.action.rescan" })}
                        onClick={() => void importState.loadDiscovery()}
                        disabled={loading}
                      >
                        <RefreshCw className="size-3" aria-hidden="true" />
                      </Button>
                    </ControlHintTooltip>
                  </div>
                ) : null}
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
              <div className="h-full overflow-auto p-3">
                {displayError ? (
                  <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
                    {displayError}
                  </div>
                ) : null}

                {loading ? (
                  <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
                    <Loader2Icon className="size-4 animate-spin" />
                    {intl.formatMessage({ id: `settings.${category}.import.scanning` })}
                  </div>
                ) : step === "importing" ? (
                  <div className="space-y-4 rounded-lg bg-surface px-4 py-5">
                    <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
                      <span>{intl.formatMessage({ id: `settings.${category}.import.importing` })}</span>
                      <span>{importProgress}%</span>
                    </div>
                    <Progress value={importProgress} className="h-2 rounded-full bg-background" />
                  </div>
                ) : step === "complete" ? (
                  <div className="space-y-4">
                    <ImportStatsSummary category={category} result={result} />
                    <ImportResultList category={category} results={importedResults} />
                  </div>
                ) : discovery && discovery.agents.length > 0 ? (
                  <ImportSelectionList
                    category={category}
                    discovery={discovery}
                    workspacePath={workspacePath}
                    activeScope={activeScope}
                    selectedKeys={selectedKeys}
                    expandedSourceKeys={expandedSourceKeys}
                    onToggleSelection={importState.toggleSelection}
                    onSetResourceSelection={importState.setResourceSelection}
                    onToggleExpanded={importState.toggleExpanded}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: `settings.${category}.import.empty` })}
                  </div>
                )}
              </div>
            </div>

            <div
              className={cn(
                "flex shrink-0 flex-wrap items-center gap-3",
                step === "complete" ? "justify-end" : "justify-between",
              )}
            >
              {step === "complete" ? null : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage(
                      { id: `settings.${category}.import.summary` },
                      { count: String(totalImportableCount) },
                    )}
                  </div>
                  {step === "selection" && category !== "mcpServers" ? (
                    <ImportModeSelect
                      category={category}
                      importMode={importMode}
                      onImportModeChange={importState.setImportMode}
                    />
                  ) : null}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {step === "complete" ? (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => onOpenChange(false)}
                  >
                    {closeLabel}
                  </Button>
                ) : null}
                {step === "selection" ? (
                  <ImportTargetDropdownButton
                    category={category}
                    targetScope={importTargetScope}
                    disabled={selectedCount === 0 || loading}
                    workspacePath={workspacePath}
                    onTargetScopeChange={importState.setImportTargetScope}
                    onImport={(targetScope) => void startImport(targetScope)}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 嵌入式选择面板：与弹窗共用同一个 hook 实例（由父级创建并传入 state），
// 但自己渲染一套「底部固定操作条」布局。它不持有 result/step，因为面板只负责挑资源，
// 真正的导入口在弹窗里——把两套流程混进一个组件会让面板也必须处理进度与结果。
export function ExternalAgentImportSelectionPanel({
  category,
  state,
  workspacePath,
}: {
  category: ImportResourceCategory;
  state: ExternalAgentImportCategoryState;
  workspacePath: string | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  // 面板不自己扫描：state 由父级持有，父级决定何时 loadDiscovery。
  // 这样面板卸载再挂载不会丢掉已扫描的结果，也不会重复触发全盘扫描。
  // [隐含前提] 这个区块与弹窗使用同一套 ImportSelectionList，因此列表内不出现第二个滚动容器；
  // 面板本身被父级放进固定高度容器，底部操作条 shrink-0 常驻。
  // 三处 #state.error / #state.loading / 空态的先后顺序与弹窗保持一致：
  // 同一份状态在两个入口下的视觉优先级必须相同，否则用户会以为面板「少了一种提示」。
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: `settings.${category}.import.summary` },
            { count: String(state.totalImportableCount) },
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SourceScopeSelect
            category={category}
            activeScope={state.activeScope}
            onActiveScopeChange={state.setActiveSourceScope}
          />
          <ControlHintTooltip
            title={intl.formatMessage({ id: "settingsSync.action.rescan" })}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "settingsSync.action.rescan" })}
              onClick={() => void state.loadDiscovery()}
              disabled={state.loading}
            >
              <RefreshCw className="size-3" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-full overflow-auto p-3">
          {state.error ? (
            <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
              {state.error}
            </div>
          ) : null}
          {state.loading ? (
            <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-4 animate-spin" />
              {intl.formatMessage({ id: `settings.${category}.import.scanning` })}
            </div>
          ) : state.discovery && state.discovery.agents.length > 0 ? (
            <ImportSelectionList
              category={category}
              discovery={state.discovery}
              workspacePath={workspacePath}
              activeScope={state.activeScope}
              selectedKeys={state.selectedKeys}
              expandedSourceKeys={state.expandedSourceKeys}
              onToggleSelection={state.toggleSelection}
              onSetResourceSelection={state.setResourceSelection}
              onToggleExpanded={state.toggleExpanded}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: `settings.${category}.import.empty` })}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: `settings.${category}.import.selectionCount` },
            {
              selected: String(state.selectedCount),
              total: String(state.totalImportableCount),
            },
          )}
        </div>
        <div className="flex items-center gap-3">
          {category !== "mcpServers" ? (
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
              </span>
              <ImportModeSelect
                category={category}
                importMode={state.importMode}
                onImportModeChange={state.setImportMode}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
            </span>
            <ImportTargetScopeSelect
              category={category}
              targetScope={state.importTargetScope}
              workspacePath={workspacePath}
              onTargetScopeChange={state.setImportTargetScope}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// 导入方式选择器：symlink 会跟随源目录更新，copy 是静态快照，
// 两者的取舍必须让用户在点导入之前就看到（tooltip 里按当前模式给不同说明），
// 否则用户按默认的 symlink 导完、后来删掉源目录才发现目标也空了。
function ImportModeSelect({
  category,
  importMode,
  onImportModeChange,
}: {
  category: ImportResourceCategory;
  importMode: SettingsSyncImportMode;
  onImportModeChange: (importMode: SettingsSyncImportMode) => void;
}) {
  const { intl } = useZCodeIntl();
  // 受控组件：value 直接取 state，不设本地副本。若在组件内维护一份 draft，
  // 父级切换类别重置 importMode 时这里会显示旧值（两份状态不同步的典型症状）。
  // 说明图标用 role="img" + aria-label 而不是纯装饰：它承载的是「两种模式差异」这段
  // 无法从控件本身看出的信息，读屏用户也需要能拿到；图标本身 aria-hidden，
  // 避免同一个含义被念两遍。
  return (
    <div className="flex items-center gap-1 text-ui-base text-foreground-subtle">
      <Select
        value={importMode}
        onValueChange={(nextMode) => {
          onImportModeChange(nextMode as SettingsSyncImportMode);
        }}
      >
        <SelectTrigger
          size="sm"
          variant="ghost"
          aria-label={intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
          className="w-fit shrink-0 justify-end border-border bg-surface text-right font-medium text-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-selected *:data-[slot=select-value]:justify-end"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {IMPORT_MODE_ORDER.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {intl.formatMessage({ id: `settings.${category}.import.mode.${mode}` })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ControlHintTooltip
        title={intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
        description={intl.formatMessage({
          id: importMode === "symlink"
            ? `settings.${category}.import.mode.symlink.description`
            : `settings.${category}.import.mode.copy.description`,
        })}
        side="top"
        align="start"
      >
        <span
          role="img"
          aria-label={intl.formatMessage({ id: `settings.${category}.import.modeHelp` })}
          className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:bg-hover hover:text-foreground"
        >
          <AlertCircleIcon className="size-3" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </div>
  );
}

// 主按钮 + 下拉的组合按钮：点击主按钮直接用当前 targetScope 导入，
// 下拉用于临时改目标。两半的禁用条件刻意不同——
// 主按钮额外要求目标可用（project 但无 workspace 时不能点），
// 下拉只要求有选择：即使目标当前不可用，用户也需要能打开菜单看到「项目」为什么灰着。
function ImportTargetDropdownButton({
  category,
  targetScope,
  disabled,
  workspacePath,
  onTargetScopeChange,
  onImport,
}: {
  category: ImportResourceCategory;
  targetScope: SettingsSyncSourceScope;
  disabled: boolean;
  workspacePath: string | null | undefined;
  onTargetScopeChange: (targetScope: SettingsSyncSourceScope) => void;
  onImport: (targetScope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  // 用 Boolean 归一而不是直接判断真值：workspacePath 可能是空字符串，
  // 空串在 JS 里为假但类型上是 string，直接透传会让服务层收到 "" 并按空路径解析。
  const hasWorkspaceTarget = Boolean(workspacePath);
  // global 永远可写（用户目录存在），project 需要真实 workspace 才能解析目标目录；
  // 这里的判定必须与 ImportTargetScopeSelect 里 SelectItem 的 disabled 保持同一表达式，
  // 两处不一致会出现「菜单里能选、主按钮点不动」的死角。
  const canImportToTarget = targetScope === "global" || hasWorkspaceTarget;
  // 按钮文案同时充当可访问名称：用当前目标而不是固定「导入」，
  // 让读屏用户在不看下拉标签的情况下也知道会写到哪。
  const activeTargetLabelId = targetScope === "project"
    ? `settings.${category}.import.target.project`
    : `settings.${category}.import.target.global`;
  // 下拉与主按钮是两个独立可聚焦元素而不是一个 split button 组件：
  // 这样键盘可以分别到达「用当前目标导入」与「改目标」，
  // 无需额外实现左右键切换。代价是视觉上要手动抹掉相邻圆角与边框（rounded-r-none /
  // border-r-0），改样式时两半必须成对调整，否则中间会露出双重边框。
  return (
    <div className="flex items-center">
      <Button
        type="button"
        size="lg"
        disabled={disabled || !canImportToTarget}
        aria-label={intl.formatMessage({ id: activeTargetLabelId })}
        className="rounded-r-none border-r-0"
        onClick={() => onImport(targetScope)}
      >
        {intl.formatMessage({ id: activeTargetLabelId })}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="lg"
            className="rounded-l-none border-l-0 px-2"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => onTargetScopeChange("global")}>
            {intl.formatMessage({ id: `settings.${category}.import.target.global` })}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasWorkspaceTarget}
            onSelect={() => onTargetScopeChange("project")}
          >
            {intl.formatMessage({ id: `settings.${category}.import.target.project` })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// 面板里的目标选择器与下拉按钮共用同一套可用性判断，但这里是 Select 形态：
// project 项用 disabled 而不是直接隐藏，用户能看到「有这个选项、当前不可用」，
// 隐藏会让人误以为功能只支持全局。
function ImportTargetScopeSelect({
  category,
  targetScope,
  workspacePath,
  onTargetScopeChange,
}: {
  category: ImportResourceCategory;
  targetScope: SettingsSyncSourceScope;
  workspacePath: string | null | undefined;
  onTargetScopeChange: (targetScope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  // 与 ImportTargetDropdownButton 中的同名判断必须一致（见该函数注释）；
  // 两处都从 workspacePath 现算，不从 targetScope 反推可用性。
  const hasWorkspaceTarget = Boolean(workspacePath);
  // 触发器的内联样式（justify-end、去掉左右内边距）让它看起来像一段普通文字而不是
  // 表单控件；这是刻意的——导入方式属于次要选项，视觉权重必须低于底部的导入按钮。
  // 改动时注意 *:data-[slot=select-value]:justify-end 这一条：它作用于内部 value 节点，
  // 去掉后文字会贴左，与触发器右对齐的箭头错位。
  return (
    <Select
      value={targetScope}
      onValueChange={(nextScope) => {
        onTargetScopeChange(nextScope as SettingsSyncSourceScope);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        aria-label={intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
        className="w-fit shrink-0 justify-end border-border bg-surface text-right font-medium text-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-selected *:data-[slot=select-value]:justify-end"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="global">
          {intl.formatMessage({ id: `settings.${category}.import.scope.global` })}
        </SelectItem>
        <SelectItem value="project" disabled={!hasWorkspaceTarget}>
          {intl.formatMessage({ id: `settings.${category}.import.scope.project` })}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

// 三项统计刻意并列展示而不是只给「成功 N」：部分成功是常见终态，
// 用户需要一眼看出 skipped（已存在/已跳过）与 failed（真失败）的比例，
// 只报成功数会让人误以为「没导入的都失败了」。
function ImportStatsSummary({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: SettingsSyncImportResult | null;
}) {
  const { intl } = useZCodeIntl();
  // result 为 null 时全部回落 0：统计条在 complete 前的渲染路径上也可能被挂上，
  // 这里不做条件渲染是刻意的——避免整块高度跳变。
  // 三项用 flex-wrap：窄屏（手机 Web / 小窗口）放不下时换行而不是横向滚动——
  // 统计条横向滚动的可发现性极差，用户会以为只有两项。
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface px-3 py-2 text-ui-xs text-foreground-subtle">
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.imported` })}
        value={result?.successCount ?? 0}
      />
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.skipped` })}
        value={result?.skippedCount ?? 0}
      />
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.failed` })}
        value={result?.failedCount ?? 0}
      />
    </div>
  );
}

// 单个统计数字：数值用等宽字体并排在标签之前，保证三组数字纵向对齐；
// 抽成 `ImportStat` 而非内联 3 份，让「数字 + 标签」的字重与间距只维护一处。
function ImportStat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono text-ui-base font-medium text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

// 逐项结果列表：空数组不是错误，而是「服务层没有回传任何 item 结果」，
// 例如整批因目标目录不可写而在任务级失败——此时统计条会显示 failed，
// 列表给一句明确说明，避免用户盯着一片空白猜。
function ImportResultList({
  category,
  results,
}: {
  category: ImportResourceCategory;
  results: ImportItemResult[];
}) {
  const { intl } = useZCodeIntl();
  // key 里带 status：同一路径可能同时出现「先 skipped 后 imported」两条（重试产生的），
  // 只用 path 会让 React 把后一条复用到前一个节点上，展示的状态与数据错位。
  // 容器用 divide-y 而不是逐行画边框：结果行数量不定，逐行加 border 会在首尾各多出一条，
  // 且 hover 态下容易看出接缝。整块圆角裁剪交给外层 overflow-hidden。
  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: `settings.${category}.import.resultList` })}
      </div>
      <div className="overflow-hidden rounded-lg bg-card">
        {results.length === 0 ? (
          <div className="px-3 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.${category}.import.resultEmpty` })}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {results.map((itemResult) => (
              <ImportResultRow
                key={`${itemResult.status}:${itemResult.sourceScope}:${itemResult.path}`}
                category={category}
                result={itemResult}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// 单条结果行：状态徽标 + 名称 +（若有）版本。
// 这里不显示完整路径：结果列表在窄弹窗里，路径会挤掉名称；
// 需要定位真实文件的用户可以从来源列表里对照，而不是靠这里被截断的路径。
function ImportResultRow({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: ImportItemResult;
}) {
  // 名称 truncate + 版本徽标 shrink 不生效的顺序很重要：名称在外层 min-w-0 容器里截断，
  // 版本徽标是固定高度的小块，不能被压扁。若把 truncate 放在最外层，
  // 版本会跟着名称一起被裁掉，用户看不到版本号。
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-3 py-2">
      <ImportStatusBadge category={category} result={result} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{result.name}</span>
        {"version" in result && result.version ? (
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
          >
            {result.version.startsWith("v") ? result.version : `v${result.version}`}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

// 状态徽标是纯视觉元素（一个小圆点），所以必须把语义压进 aria-label 与 title：
// 否则色盲用户与读屏用户拿不到 imported/skipped/failed 的区分，
// 而这三者的后续动作完全不同（成功不用管、跳过是已存在、失败要去修权限或重试）。
function ImportStatusBadge({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: ImportItemResult;
}) {
  const { intl } = useZCodeIntl();
  // 三态用嵌套三元而不是映射表：这里只有三种状态，且类型是封闭联合，
  // 写死分支能保证新增状态时 TypeScript 在 Icon 推导处报错，提醒补齐视觉与文案。
  const label = intl.formatMessage({
    id: result.status === "imported"
      ? `settings.${category}.import.imported`
      : result.status === "skipped"
        ? `settings.${category}.import.skipped`
        : `settings.${category}.import.failed`,
  });
  // skipReason 只在 skipped 时有意义（已存在 / 不可导入 / 冲突），拼进可访问名里，
  // 让用户不必展开详情就能知道「为什么跳过」——这是用户最常见的追问。
  const reasonLabel = result.skipReason
    ? intl.formatMessage({ id: `settings.${category}.import.skipReason.${result.skipReason}` })
    : null;
  // 用 ": " 拼接而不是另起一个元素：徽标只有一个节点，
  // 读屏会把 aria-label 当作整体朗读，中间插入子元素会打断这句话。
  const accessibleLabel = reasonLabel ? `${label}: ${reasonLabel}` : label;
  // 图标与状态一一对应：成功打勾、跳过感叹号、失败叉号。
  // 颜色只做冗余提示，不作为唯一区分手段（见上面的 aria-label）。
  const Icon = result.status === "imported"
    ? CheckIcon
    : result.status === "skipped"
      ? AlertCircleIcon
      : XIcon;

  // 三种状态用 cn 逐条匹配而不是拼模板字符串：Tailwind 只识别完整类名，
  // 动态拼接 `bg-${status}` 这类写法在构建时会被摇掉，最终三态同色。
  // 这里的条件是互斥的（status 是封闭联合），所以后两条不会覆盖前一条。
  return (
    <span
      aria-label={accessibleLabel}
      role="img"
      className={cn(
        "flex size-3 shrink-0 items-center justify-center rounded-full",
        result.status === "imported" && "bg-success text-success-foreground",
        result.status === "skipped" && "bg-warning text-warning-foreground",
        result.status === "failed" && "bg-destructive text-destructive-foreground",
      )}
      title={accessibleLabel}
    >
      <Icon className="size-2" aria-hidden="true" />
    </span>
  );
}

// 来源范围切换器（global / project）：只切「看哪一组」，不触发重新扫描。
// 两组的行来自同一份 discovery，切 scope 是纯前端过滤，
// 因此切换必须是瞬时的——若在这里调 loadDiscovery 会清空用户已勾选的项。
function SourceScopeSelect({
  category,
  activeScope,
  onActiveScopeChange,
}: {
  category: ImportResourceCategory;
  activeScope: SettingsSyncSourceScope;
  onActiveScopeChange: (scope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  // 选项顺序直接复用 SOURCE_ROOT_SCOPE_ORDER，与分组渲染顺序同源；
  // 各写一份数组会在调整顺序时出现「下拉顺序与列表顺序不一致」。
  // 用 ghost + size="sm"：这个控件只在标题栏右侧出现，视觉权重必须低于标题；
  // 保持 SelectValue 的 justify-end 让「global / project」贴右对齐，与重扫按钮成组。
  return (
    <Select
      value={activeScope}
      onValueChange={(nextScope) => {
        onActiveScopeChange(nextScope as SettingsSyncSourceScope);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        aria-label={intl.formatMessage({ id: `settings.${category}.import.scopeLabel` })}
        className="w-fit shrink-0 justify-end text-right text-foreground-subtle hover:text-foreground *:data-[slot=select-value]:justify-end"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SOURCE_ROOT_SCOPE_ORDER.map((scope) => (
          <SelectItem key={scope} value={scope}>
            {formatSourceRootScope(scope, intl, category)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// 选择列表：按 activeScope 展示一组来源目录，支持「整组全选 / 单行勾选 / 展开看明细」。
// 三层选择语义必须互不污染：
//   1) 资源行 → 单个 importable 项；
//   2) 来源行 → 该目录下所有 importable 项；
//   3) 全选行 → 当前 scope 下所有来源目录的所有 importable 项（不跨 scope）。
// 三者都只是对同一个 selectedKeys 的增删，不维护各自的「是否全选」布尔值——
// 布尔值会在外部改写选择集（重扫、其他 scope 全选）后与真实集合脱节。
function ImportSelectionList({
  category,
  discovery,
  workspacePath,
  activeScope,
  selectedKeys,
  expandedSourceKeys,
  onToggleSelection,
  onSetResourceSelection,
  onToggleExpanded,
}: {
  category: ImportResourceCategory;
  discovery: SettingsSyncDiscoveryResult;
  workspacePath: string | null | undefined;
  activeScope: SettingsSyncSourceScope;
  selectedKeys: string[];
  expandedSourceKeys: string[];
  onToggleSelection: (key: string) => void;
  onSetResourceSelection: (keys: string[], checked: boolean) => void;
  onToggleExpanded: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 把数组转成 Set 再查成员：列表可能有上千项，includes 的 O(n) 在每次勾选后的
  // 全量重渲染里会被调用 n 次，退化成 O(n²)，在有大量技能目录的机器上能明显卡顿。
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const expanded = useMemo(() => new Set(expandedSourceKeys), [expandedSourceKeys]);
  // 分组在渲染期现算：它依赖 workspacePath（判断哪个目录算项目级），
  // 把分组结果存进 state 会在 workspace 切换后继续显示旧归属。
  const scopes = useMemo(
    () => groupAgentsBySourceRootScope(discovery.agents, workspacePath, category),
    [category, discovery.agents, workspacePath],
  );
  // activeGroup 一定存在（两个 scope 都被预建），用 find 而不是索引访问：
  // 索引依赖 SOURCE_ROOT_SCOPE_ORDER 的内部顺序，改动顺序就会静默取错分组。
  const activeGroup = scopes.find((scope) => scope.scope === activeScope);
  // activeGroup 允许为 undefined：scopes 由常量顺序生成，理论上一定命中，
  // 但下游全部用可选链兜底而不是非空断言——这个组件会在 discovery 更新与
  // activeScope 更新之间的中间渲染里被执行一次，非空断言会在这里抛错白屏。
  // 当前 scope 下所有可导入项的 key：既是全选的作用对象，也是全选态的分母。
  // 只收集 importable=true 的项（见 INV-12），skipped 项不参与，否则全选永远点不满。
  const activeImportableResourceKeys = useMemo(
    () =>
      activeGroup?.rows.flatMap(({ agent, sourceRoot }) => {
        // 再查一次类别而不是复用上面的过滤结果：分组只保证「有 importable 项」，
        // 不携带 category 对象本身；这里返回 [] 是防御性写法，
        // 避免将来分组逻辑放宽后读到 undefined 抛错。
        const resourceCategory = getResourceCategory(agent, category);
        if (!resourceCategory) {
          return [];
        }
        // item.path 原样进 key，不做归一化：这是后续提交给服务层的真实路径（见 INV-3）。
        return getSourceRootItems(sourceRoot, category)
          .filter((item) => item.importable)
          .map((item) =>
            getResourceSelectionKey({
              agent: agent.agent,
              category,
              sourceScope: sourceRoot.scope,
              resourcePath: item.path,
            }),
          );
      }) ?? [],
    [activeGroup, category],
  );
  const activeSelectedCount = activeImportableResourceKeys.filter((key) =>
    selected.has(key),
  ).length;
  // 全选态要求集合非空：空集合时 length>0 为假，全选框就不会显示为已勾选。
  // 少了这个前提，一个没有任何可导入项的空 scope 会显示「已全选」，
  // 用户点了清空却看不出任何变化。
  const allActiveSelected =
    activeImportableResourceKeys.length > 0 &&
    activeSelectedCount === activeImportableResourceKeys.length;
  // 半选态：0 < 已选 < 总数。边界两侧都必须严格，
  // 否则「一项都没选」与「全选」都会同时满足半选条件，出现勾号与横杠并存。
  const partiallyActiveSelected =
    activeSelectedCount > 0 && activeSelectedCount < activeImportableResourceKeys.length;
  // 同一个按钮承担全选与清空，文案取自当前状态：不按状态换文案的话，
  // 用户在已全选时点它会得到「反选」的效果却写着「全选」，无法预测。
  const toggleAllLabel = intl.formatMessage({
    id: allActiveSelected
      ? `settings.${category}.import.clearAll`
      : `settings.${category}.import.selectAll`,
  });

  // 全选行只在当前 scope 有可导入项时渲染：没有分母时展示「全选 0/0」没有意义。
  // role="checkbox" + aria-checked="mixed" 是这里唯一的无障碍表达手段——
  // 视觉上的横杠图标对读屏无意义，必须由 aria 状态补上第三态。
  // 注意 aria-checked 传的是布尔值或 "mixed" 字符串，不是受控状态：
  // 真正的勾选在 selectedKeys 里，点击走 onSetResourceSelection 反选整组。
  return (
    <div className="flex w-full flex-col gap-1">
      {activeImportableResourceKeys.length > 0 ? (
        <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={partiallyActiveSelected ? "mixed" : allActiveSelected}
            aria-label={toggleAllLabel}
            onClick={() => onSetResourceSelection(activeImportableResourceKeys, !allActiveSelected)}
            className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-ui-base text-foreground-subtle transition-colors hover:text-foreground"
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
                (allActiveSelected || partiallyActiveSelected) &&
                  "border-primary bg-primary text-primary-foreground",
              )}
            >
              {allActiveSelected ? <CheckIcon className="size-3.5" aria-hidden="true" /> : null}
              {partiallyActiveSelected ? (
                <MinusIcon className="size-3.5" aria-hidden="true" />
              ) : null}
            </span>
            <span className="shrink-0">{toggleAllLabel}</span>
          </button>
          <div className="min-w-0 text-right text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: `settings.${category}.import.selectionCount` },
              {
                selected: String(activeSelectedCount),
                total: String(activeImportableResourceKeys.length),
              },
            )}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        {activeGroup?.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-3 py-6 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.${category}.import.scopeEmpty` })}
          </div>
        ) : null}
        {activeGroup?.rows.map(({ agent, sourceRoot }) => {
          // 每个来源行都重新确认类别存在：rows 只保证「该目录有 importable 项」，
          // 不保证 agent 对象仍带该类别（服务层回包的 categories 可能被裁剪过）。
          const resourceCategory = getResourceCategory(agent, category);
          if (!resourceCategory) {
            return null;
          }
          // key 与 sourceKey 是两个层级：key 是 agent+category+scope（同 agent 同 scope 唯一），
          // sourceKey 再拼上 path，用于展开集合与 React key——同一 agent 的两个目录
          // 必须能分别展开，只用 key 会让它们共用一个展开状态。
          const key = getSourceSelectionKey(agent.agent, category, sourceRoot.scope);
          const sourceKey = `${key}:${sourceRoot.path}`;
          // 行内只列 importable 项：skipped 项在扫描阶段就已经判定不可导入，
          // 展示出来只会让用户反复尝试勾选一个永远失败的目标。
          const items = getSourceRootItems(sourceRoot, category).filter((item) => item.importable);
          const importableResourceKeys = items
            .map((item) =>
              getResourceSelectionKey({
                agent: agent.agent,
                category,
                sourceScope: sourceRoot.scope,
                resourcePath: item.path,
              }),
            );
          // 已选数按「可导入项」计算，而不是按 selectedKeys 里属于本来源的所有 key：
          // 后者会把上次扫描残留、当前已不可导入的 key 也算进去，出现选中数超过总数。
          const selectedImportableCount = importableResourceKeys.filter((itemKey) =>
            selected.has(itemKey),
          ).length;
          // 全选与半选同样要求集合非空，理由与上面 scope 级全选一致：
          // 空集合下 0 === 0 会被误判成「已全选」。
          const checked =
            importableResourceKeys.length > 0 &&
            selectedImportableCount === importableResourceKeys.length;
          const partiallyChecked =
            selectedImportableCount > 0 && selectedImportableCount < importableResourceKeys.length;
          // 没有任何可导入项的来源行整体禁用：按钮仍渲染（保留布局与目录名），
          // 但不可点击，避免用户以为漏点了什么。
          const disabled = importableResourceKeys.length === 0;
          const isExpanded = expanded.has(sourceKey);

          // 一行分成两个按钮而不是一个可点击区域：
          // 左侧复选框只切换 `importableResourceKeys` 整组勾选，文字区只切换 `expanded`。
          // 合并成一个 onClick 会让「想展开看看」顺手把整组取消勾选，
          // 这是列表里最容易误操作的一处，必须物理分开。
          // React key 用 sourceKey（含 path），展开态也以它为基准；
          // 若用 key（不含 path），同一 agent 的两个目录会共享展开态并互相顶掉。
          return (
            <div key={sourceKey} className="rounded-lg">
              <div
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                  disabled
                    ? "opacity-70"
                    : "hover:bg-surface-hover/50",
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={intl.formatMessage({
                    id: checked
                      ? `settings.${category}.import.deselectSource`
                      : `settings.${category}.import.selectSource`,
                  })}
                  onClick={() => onSetResourceSelection(importableResourceKeys, !checked)}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md",
                    disabled ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border border-border",
                      (checked || partiallyChecked) && !disabled &&
                        "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {checked && !disabled ? <CheckIcon className="size-3.5" /> : null}
                    {partiallyChecked && !disabled ? <MinusIcon className="size-3.5" /> : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleExpanded(sourceKey)}
                  className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-left"
                >
                  <span className="text-ui-base font-medium text-foreground">
                    {formatAgentName(agent.agent, intl)}
                  </span>
                  <span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">
                    {sourceRoot.path}
                  </span>
                  {items.length > 0 ? (
                    <span className="text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage(
                        { id: `settings.${category}.import.itemCount` },
                        { count: String(items.length) },
                      )}
                    </span>
                  ) : null}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: isExpanded
                      ? `settings.${category}.import.collapseSource`
                      : `settings.${category}.import.expandSource`,
                  })}
                  onClick={() => onToggleExpanded(sourceKey)}
                  className="shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                </Button>
              </div>
              {isExpanded ? (
                <div className="ml-9 border-l border-border pl-3">
                  {items.map((item) => (
                    <ResourceSelectionRow
                      key={`${sourceKey}:${item.path}`}
                      agent={agent}
                      category={category}
                      sourceScope={sourceRoot.scope}
                      selected={selected}
                      item={item}
                      onToggleSelection={onToggleSelection}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 资源明细行：一个可勾选的项。key 在渲染期现算而不是从父级传下来，
// 保证与父级全选时构造的 key 使用同一函数；两处各自拼字符串会在字段顺序或
// undefined 处理上出现细微差异，表现为「全选后这一行仍显示未勾选」。
function ResourceSelectionRow({
  agent,
  category,
  sourceScope,
  selected,
  item,
  onToggleSelection,
}: {
  agent: SettingsSyncAgentSummary;
  category: ImportResourceCategory;
  sourceScope: SettingsSyncSourceScope;
  selected: Set<string>;
  item: ImportItemSummary;
  onToggleSelection: (key: string) => void;
}) {
  const itemKey = getResourceSelectionKey({
    agent: agent.agent,
    category,
    sourceScope,
    resourcePath: item.path,
  });
  // checked 直接从父级的 Set 读，不在行内维护本地勾选态：
  // 本地态会在「全选」这类外部改写后与真实集合不一致（勾选框与提交内容分叉）。
  const checked = selected.has(itemKey);

  // 点击整行而不是只有复选框可点：资源行的高度只有 32px 左右，
  // 让整行成为点击热区能显著降低误点率；复选框本身仍保留 aria 语义与键盘可达性。
  // 这里不额外做 disabled 判断：调用方只会渲染 importable 的项（见 ImportSelectionList）。
  return (
    <button
      type="button"
      onClick={() => onToggleSelection(itemKey)}
      className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
            checked && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {checked ? <CheckIcon className="size-3.5" /> : null}
        </span>
        <span className="min-w-0 truncate text-ui-base text-foreground">
          {item.name}
        </span>
        {"version" in item && item.version ? (
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
          >
            {item.version.startsWith("v") ? item.version : `v${item.version}`}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}
