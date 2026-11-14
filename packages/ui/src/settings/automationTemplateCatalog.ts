// INV-01 守住位置：catalog 只做纯投影，输入是 scenes，输出是新对象；改错故障：在此写入缓存或自行拉取远程会让模板出现第二份真源。
// INV-02 守住位置：scheduled 与 off-peak 都从 scenes 的 options.prompts 读取；改错故障：另开数据源会漏掉服务端新增的模板。
// INV-03 守住位置：hasLocalizedTitle 是进入目录的唯一门槛；改错故障：放行无标题项会让列表出现空白卡片。
// INV-04 守住位置：被丢弃的 scheduled 模板 id 必须进 rejectedScheduledTemplateIds；改错故障：静默丢弃会让调用方无法区分「没配模板」与「配置被拒」。
// INV-05 守住位置：cronExpr 必须同时通过 Service 校验与编辑器可视化校验；改错故障：只做前者会让六段表达式进入模板后被静默改写。
// INV-06 守住位置：cron 的各语言内容不一致时整项拒绝；改错故障：任选一种语言会让点击结果随 locale 漂移。
// INV-07 守住位置：normalizeTemplateId 只剥离 item- 与 item_ 前缀；改错故障：扩大剥离范围会让不同 id 归一成同一个图标。
// INV-08 守住位置：图标由 id 关键词推导，不回读模板文案；改错故障：改用标题会让本地化改名后图标跳变。
// INV-09 守住位置：CUSTOMIZE_TEMPLATE 的 title 与 description 保持空对象；改错故障：塞入硬编码文案会与 locale 真源分歧。
// INV-10 守住位置：customize 项的 prompt 保留双语言空串；改错故障：预填默认 prompt 会让首页入口带上用户没见过的指令。
// INV-11 守住位置：isCustomizeItem 只对归一化后的 customize 判真；改错故障：放宽匹配会让远程同名项被当成本地入口。
// INV-12 守住位置：远程 customize 项的标题与描述由本地常量覆盖；改错故障：保留远程文案会出现两套 Customize 文案。
// INV-13 守住位置：appendLocalCustomizeTemplate 先过滤再截取；改错故障：先截取会让远程同名项占掉远程模板名额。
// INV-14 守住位置：首页限额常量只作用于首页；改错故障：把它套到 Automations 模板区会截断远程目录。
// INV-15 守住位置：resolveAutomationTemplateText 按 locale 选主语言并回退另一语言；改错故障：去掉回退会让只配单语的模板显示为空。
// INV-16 守住位置：materialize 系列只落地文案，不改结构与图标；改错故障：在落地层改结构会让草稿与目录不一致。
// INV-17 守住位置：homepageDescription 到 description 的字段折叠只在 resolveOffPeakTemplateText 内；改错故障：散落到组件会让 customize 取错 message id。
// INV-18 守住位置：所有导出保持纯函数且无模块级可变状态；改错故障：引入共享可变对象会让不同窗口互相污染模板。
//
// 模块职责：把服务端 ClientSceneConfig 投影成 Automation 模板目录，并提供标题与描述的落地工具。
// 状态所有权：模板内容以服务端 scene 配置为真源，本模块只持有不可变的本地 Customize 常量，不缓存投影结果。
// 阅读顺序：先看类型契约，再看准入与 cron 校验，最后看首页截断与文案落地。
import type { ClientSceneConfig, ClientSceneItem } from "@zcode/services";
import type { AutomationScheduledTemplateIconName } from "@/settings/AutomationScheduledTemplateIcon.js";
import type { OffPeakTemplateIconName } from "@/settings/OffPeakTemplateIcon.js";
import { canVisualizeCronInAutomationEditor } from "@/settings/automationFormat.js";

// 对外契约：cn 与 en 都可缺省，空值表示该语言没有配置，而不是另一语言的占位。
// 调用方必须经 resolveAutomationTemplateText 取文案，不要直接读 cn 或 en 字段。
// 直接读字段会把「未配置」与「配置成空串」混为一谈，列表会出现空标题。
// 新增语言时先扩展该结构，再改 resolve 逻辑，否则回退分支会漏掉新语言。
export interface AutomationTemplateLocalizedText {
  cn?: string;
  en?: string;
}

interface AutomationTemplateBase {
  id: string;
  iconName?: string;
  title: AutomationTemplateLocalizedText;
  description: AutomationTemplateLocalizedText;
  prompt: AutomationTemplateLocalizedText;
}

export interface ScheduledAutomationTemplate extends AutomationTemplateBase {
  cronExpr: string;
  icon: AutomationScheduledTemplateIconName;
}

export interface OffPeakAutomationTemplate extends AutomationTemplateBase {
  homepageDescription?: AutomationTemplateLocalizedText;
  customize: boolean;
  icon: OffPeakTemplateIconName;
}

// 文案注入边界：Customize 的标题与描述来自 locale 真源，本文件只保存 message id。
// 把译文直接写进 catalog 会让同一句话出现两处真源，翻译更新后界面不一致。
// 这里保持最小签名，只接收 id，避免 catalog 反向依赖 i18n 实现。
// message id 常量只有 title 与 description 两个键，homepageDescription 在使用侧折叠到 description。
// 新增字段时先补 message id 再补类型，否则渲染侧会拿到未定义的值。
type FormatAutomationMessage = (descriptor: { id: string }) => string;

const CUSTOMIZE_TEMPLATE_MESSAGE_IDS = {
  title: "offPeak.newTask.template.customize.title",
  description: "offPeak.newTask.template.customize.description",
} as const;

export interface AutomationTemplateCatalog {
  scheduled: ScheduledAutomationTemplate[];
  offPeak: OffPeakAutomationTemplate[];
  rejectedScheduledTemplateIds: string[];
}

// CUSTOMIZE_TEMPLATE 是首页与模板区共用的本地兜底项，只保留这一份，不要在别处再构造同类对象。
// title 与 description 刻意留空，渲染时由 resolveOffPeakTemplateText 走 message id 取译文。
// prompt 保留双语言空串，表示该入口不预填任何指令，用户必须自己输入。
// customize 标记为 true，是后续过滤与文案分支的唯一判据。
// icon 固定为 customize，保证本地入口与远程项在视觉上可区分。
// 若把它改成普通远程项，首页会追加出第二个 Customize 入口。
const CUSTOMIZE_TEMPLATE: OffPeakAutomationTemplate = {
  id: "customize",
  // Customize 是本地保底入口，稳定文案由 locale 真源在渲染时解析，避免 catalog 再保存一份双语副本。
  title: {},
  description: {},
  prompt: { cn: "", en: "" },
  customize: true,
  icon: "customize",
};

// id 归一化只剥离形如 item- 与 item_ 的前缀，用于图标推导与 customize 判定。
// 正则带 i 标志，避免大小写差异让同一模板落到不同分支。
// 不要在归一化里做 trim 或去空格，服务端 id 的空白应视为配置错误而不是被悄悄修正。
// 归一化结果不得对外输出，id 原值才是草稿与拒绝列表的标识。
// 改匹配范围时同步检查 scheduledIcon 与 offPeakIcon 的关键词命中顺序。
function normalizeTemplateId(id: string): string {
  return id.replace(/^item[-_]?/i, "");
}

function resolveTemplateIconName(item: ClientSceneItem): string | undefined {
  return item.img?.trim() || undefined;
}

function resolveOffPeakHomepageDescription(item: ClientSceneItem): AutomationTemplateLocalizedText {
  return {
    cn: item.descs?.cn?.trim() || item.contents.cn,
    en: item.descs?.en?.trim() || item.contents.en,
  };
}

function scheduledIcon(id: string): AutomationScheduledTemplateIconName {
  const normalized = normalizeTemplateId(id).toLowerCase();
  if (normalized.includes("morning") || normalized.includes("standup")) return "target";
  if (normalized.includes("risk") || normalized.includes("ci")) return "activity";
  if (normalized.includes("release") || normalized.includes("file")) return "file";
  return "list";
}

function offPeakIcon(id: string, customize: boolean): OffPeakTemplateIconName {
  if (customize) return "customize";
  const normalized = normalizeTemplateId(id).toLowerCase();
  if (normalized.includes("standup") || normalized.includes("git")) {
    return "standupGitSummary";
  }
  if (normalized.includes("ci") || normalized.includes("flaky")) return "ciFlakyReport";
  if (normalized.includes("documentation") || normalized.includes("doc")) {
    return "documentationSyncCheck";
  }
  return "followUpMonitor";
}

function isCustomizeItem(item: ClientSceneItem): boolean {
  return normalizeTemplateId(item.id).toLowerCase() === "customize";
}

function hasLocalizedTitle(item: ClientSceneItem): boolean {
  return Boolean(item.labels.cn?.trim() || item.labels.en?.trim());
}

// cron 引用解析的契约：返回 null 表示拒绝该项，返回字符串表示可安全落地的表达式。
// scene 缺少 cronExpr 选项或模板未声明 defaults.cronExpr 时立即返回 null，不要猜默认值。
// 只取排序后的第一个非空本地化值，并要求各语言一致，防止点击结果随 locale 漂移。
// 双检顺序是 Service 校验加编辑器可视化，二者都通过才允许返回。
// 只做 Service 校验会让六段与七段表达式进入模板，用户尚未编辑就被静默改写。
// 要放开新语法时先确认编辑器可无损回写，否则拒绝优于悄悄降级。
function resolveReferencedCronExpr(
  scene: ClientSceneConfig,
  promptItem: ClientSceneItem,
  isValidCronExpr: (cronExpr: string) => boolean,
): string | null {
  const cronItemIds = promptItem.defaults?.cronExpr;
  const cronItems = scene.options.cronExpr?.items;
  if (!cronItemIds?.length || !cronItems) return null;

  for (const cronItemId of cronItemIds) {
    const cronItem = cronItems.find((item) => item.id === cronItemId);
    if (!cronItem) continue;
    const localizedValues = [cronItem.contents.en, cronItem.contents.cn]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const cronExpr = localizedValues[0];
    if (!cronExpr) continue;
    // cron 不是自然语言；不同 locale 配置成不同表达式会让点击结果不可预测，按非法配置拒绝。
    if (localizedValues.some((value) => value !== cronExpr)) return null;
    // Croner 支持六/七段等表达式，但 Automation builder 只能无损编辑其中的
    // 五段子集。只做 Service 校验会让模板在打开表单后、用户尚未编辑时就被静默改写。
    if (isValidCronExpr(cronExpr) && canVisualizeCronInAutomationEditor(cronExpr)) {
      return cronExpr;
    }
  }
  return null;
}

// scheduled 场景按 scene 字段精确匹配，找不到就返回空目录加空拒绝列表，不回退到第一个场景。
// 拒绝列表必须与 scheduled 同源生成，调用方靠它区分「服务端没配」与「配置被拒」。
// 两个早返回分支都不能只跳过而不记录 id，否则问题模板会完全消失。
// hasLocalizedTitle 先于 cron 校验，保证标题缺失与表达式非法的诊断口径一致。
// 输出顺序跟随 items 原顺序，不要排序或去重，模板位次属于产品契约。
// iconName 只在非空时写入，空串会让下游误判为显式指定了图标。
function mapScheduledTemplates(
  scenes: readonly ClientSceneConfig[],
  isValidCronExpr: (cronExpr: string) => boolean,
): Pick<AutomationTemplateCatalog, "scheduled" | "rejectedScheduledTemplateIds"> {
  const scene = scenes.find((candidate) => candidate.scene === "scheduled-task");
  const items = scene?.options.prompts?.items ?? [];
  if (!scene) return { scheduled: [], rejectedScheduledTemplateIds: [] };

  const scheduled: ScheduledAutomationTemplate[] = [];
  const rejectedScheduledTemplateIds: string[] = [];
  for (const item of items) {
    if (!hasLocalizedTitle(item)) {
      rejectedScheduledTemplateIds.push(item.id);
      continue;
    }
    const cronExpr = resolveReferencedCronExpr(scene, item, isValidCronExpr);
    if (!cronExpr) {
      rejectedScheduledTemplateIds.push(item.id);
      continue;
    }
    const iconName = resolveTemplateIconName(item);
    scheduled.push({
      id: item.id,
      ...(iconName ? { iconName } : {}),
      title: item.labels,
      description: item.contents,
      prompt: item.contents,
      cronExpr,
      icon: scheduledIcon(item.id),
    });
  }
  return { scheduled, rejectedScheduledTemplateIds };
}

// off-peak 场景同样按 scene 精确匹配，缺失时 items 退化为空数组并返回空列表。
// customize 项的三个文案字段被本地常量覆盖，其余字段仍取远程项，避免整项被替换。
// homepageDescription 与 description 分开取值，首页摘要与列表描述允许不同。
// 过滤发生在映射之前，无标题项不会产出一半字段缺失的对象。
function mapOffPeakTemplates(scenes: readonly ClientSceneConfig[]): OffPeakAutomationTemplate[] {
  const scene = scenes.find((candidate) => candidate.scene === "off-peak-task");
  const items = scene?.options.prompts?.items ?? [];
  return items.filter(hasLocalizedTitle).map((item): OffPeakAutomationTemplate => {
    const customize = isCustomizeItem(item);
    const iconName = resolveTemplateIconName(item);
    return {
      id: item.id,
      ...(iconName ? { iconName } : {}),
      title: customize ? CUSTOMIZE_TEMPLATE.title : item.labels,
      description: customize ? CUSTOMIZE_TEMPLATE.description : item.contents,
      homepageDescription: customize
        ? CUSTOMIZE_TEMPLATE.description
        : resolveOffPeakHomepageDescription(item),
      prompt: item.contents,
      customize,
      icon: offPeakIcon(item.id, customize),
    };
  });
}

// 首页只展示两条远程 off-peak 模板，常量集中在此，避免多个调用点各写一个字面量。
// 截断只发生在 appendLocalCustomizeTemplate，Automations 模板区必须保留远程目录原样。
// 先过滤 customize 再截断，远程同名项不会占用名额或挤掉最后一项的位置。
const HOMEPAGE_REMOTE_OFF_PEAK_TEMPLATE_LIMIT = 2;

/**
 * New task 首页专用选择规则；Automations 模板区必须保持远程目录原样。
 * 首页始终使用本地 Customize，避免远程同名项占用两条远程模板名额或改变最后一项的位置。
 */
export function appendLocalCustomizeTemplate(
  templates: readonly OffPeakAutomationTemplate[],
): OffPeakAutomationTemplate[] {
  return [
    ...templates
      .filter((template) => !template.customize)
      .slice(0, HOMEPAGE_REMOTE_OFF_PEAK_TEMPLATE_LIMIT),
    CUSTOMIZE_TEMPLATE,
  ];
}

export function mapClientScenesToAutomationTemplates(
  scenes: readonly ClientSceneConfig[],
  isValidCronExpr: (cronExpr: string) => boolean,
): AutomationTemplateCatalog {
  return {
    ...mapScheduledTemplates(scenes, isValidCronExpr),
    offPeak: mapOffPeakTemplates(scenes),
  };
}

export function resolveAutomationTemplateText(
  text: AutomationTemplateLocalizedText,
  locale?: string,
): string {
  const isChinese = locale?.startsWith("zh") ?? false;
  const primary = isChinese ? text.cn : text.en;
  const fallback = isChinese ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}

export function resolveOffPeakTemplateText(
  template: OffPeakAutomationTemplate,
  field: "title" | "description" | "homepageDescription",
  locale: string,
  formatMessage: FormatAutomationMessage,
): string {
  if (template.customize) {
    const messageField = field === "homepageDescription" ? "description" : field;
    return formatMessage({ id: CUSTOMIZE_TEMPLATE_MESSAGE_IDS[messageField] });
  }
  const text =
    field === "homepageDescription"
      ? (template.homepageDescription ?? template.description)
      : template[field];
  return resolveAutomationTemplateText(text, locale);
}

export function materializeScheduledTemplateDraft(
  template: ScheduledAutomationTemplate,
  locale: string,
): { templateId: string; title: string; cronExpr: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    cronExpr: template.cronExpr,
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}

export function materializeOffPeakTemplateDraft(
  template: OffPeakAutomationTemplate,
  locale: string,
): { templateId: string; title: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}
