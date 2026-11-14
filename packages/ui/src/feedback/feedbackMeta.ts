// INV-01 四种反馈类型保持固定顺序：守住位置 FEEDBACK_TYPE_META；改错故障 选择器顺序随版本漂移。
// INV-02 类型值对接共享枚举：守住位置 TypeMeta.value；改错故障 提交值后端不识别。
// INV-03 每项都带图标与选中色：守住位置 iconText；改错故障 选中态失去类型区分。
// INV-04 三档严重度固定：守住位置 SEVERITY_META；改错故障 表单出现第四档。
// INV-05 严重度提示只保留缩写：守住位置 hint；改错故障 列表被长文案撑开。
// INV-06 状态表覆盖全部枚举值：守住位置 STATUS_META 类型；改错故障 缺项时渲染崩溃。
// INV-07 归档与答复关闭共用样式：守住位置 两个键；改错故障 同一终态显示两种颜色。
// INV-08 归档是接口归一后的值：守住位置 注释与键；改错故障 后端改名后崩溃。
// INV-09 拒绝态用最浅前景色：守住位置 已拒绝 项；改错故障 拒绝与通过同样醒目。
// INV-10 状态颜色只表达分组：守住位置 className；改错故障 颜色被误读成优先级。
// INV-11 严重度徽章三档齐全：守住位置 SEVERITY_BADGE；改错故障 某档无边框样式。
// INV-12 模块文案标识集中一处：守住位置 FEEDBACK_MODULE_MESSAGE_IDS；改错故障 文案散落各组件。
// INV-13 模块键为后端枚举：守住位置 Record 类型；改错故障 拼写不一致导致空文案。
// INV-14 其它作为兜底项：守住位置 末项；改错故障 未列模块显示空白。
// INV-15 状态文案标识同样集中：守住位置 FEEDBACK_STATUS_MESSAGE_IDS；改错故障 状态名直接外露。
// INV-16 归档映射到已完成文案：守住位置 已归档 项；改错故障 用户看到内部命名。
// INV-17 格式化函数不读全局：守住位置 入参 formatter；改错故障 组件无法替换国际化实现。
// INV-18 本文件只有常量与纯函数：守住位置 无副作用模块；改错故障 导入时触发注册。
//
// 模块职责：反馈工单的类型、严重度、状态与模块展示元数据。
// 状态所有权：无状态；全部为只读常量表与标签格式化函数。
// 阅读顺序：先看类型与严重度，再读状态表，最后看文案标识与格式化。
import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketType,
} from "@zcode/shared";
import type { ComponentType, SVGProps } from "react";
import {
  FeedbackBugIcon,
  FeedbackIdeaIcon,
  FeedbackPerformanceIcon,
  FeedbackQuestionIcon,
} from "@/feedback/feedbackIcons.js";

interface TypeMeta {
  value: FeedbackTicketType;
  label: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** 选中时图标颜色 */
  iconText: string;
}

type MessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

// 顺序就是选择器的展示顺序（bug → usage → feature → performance），value 与共享反馈类型枚举一一对应。
// 每项含 label/description/Icon/iconText；iconText 带 `dark:` 变体，新增类型必须同时补 Icon 与两套颜色。
export const FEEDBACK_TYPE_META: TypeMeta[] = [
  {
    value: "bug",
    label: "遇到 Bug",
    description: "报错、崩溃、功能不符合预期",
    Icon: FeedbackBugIcon,
    iconText: "text-rose-500 dark:text-rose-400",
  },
  {
    value: "usage",
    label: "不会使用",
    description: "操作不清楚、配置不确定",
    Icon: FeedbackQuestionIcon,
    iconText: "text-sky-500 dark:text-sky-400",
  },
  {
    value: "feature",
    label: "想提建议",
    description: "希望支持的新能力或体验优化",
    Icon: FeedbackIdeaIcon,
    iconText: "text-amber-500 dark:text-amber-400",
  },
  {
    value: "performance",
    label: "运行很慢",
    description: "卡顿、响应慢、资源占用异常",
    Icon: FeedbackPerformanceIcon,
    iconText: "text-violet-500 dark:text-violet-400",
  },
];
// 三档按 P1 → P2 → P3 排列，数组顺序即选择器里的优先级顺序；value 必须与后端 FeedbackTicketSeverity 字面量一致。
// hint 只放级别缩写（P1/P2/P3）供紧凑场景；dot 给圆点配色，label 用于表单选项。
export const SEVERITY_META: {
  value: FeedbackTicketSeverity;
  label: string;
  hint: string;
  dot: string;
}[] = [
  { value: "P1-高", label: "完全用不了", hint: "P1", dot: "bg-rose-500" },
  { value: "P2-中", label: "影响使用", hint: "P2", dot: "bg-amber-500" },
  { value: "P3-低", label: "小问题/建议", hint: "P3", dot: "bg-emerald-500" },
];

interface StatusMeta {
  className: string;
  dot: string;
}

// 键必须覆盖 FeedbackTicketStatus 的全部枚举值：查不到 meta 时状态标记会直接崩。
// 答复关闭与已归档共用绿色样式（接口会把历史「答复关闭」归一为「已归档」）；已拒绝用最浅前景色，颜色只分组不排优先级。
export const STATUS_META: Record<FeedbackTicketStatus, StatusMeta> = {
  已提交: {
    className: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  信息不足: {
    className: "text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  已采纳: {
    className: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  答复关闭: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  // 公开反馈接口会把历史「答复关闭」归一为「已归档」返回。
  // 客户端必须同时识别两种终态，否则我的反馈列表渲染状态标记时会拿不到 meta 而崩溃。
  已归档: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已拒绝: {
    className: "text-foreground-subtle",
    dot: "bg-foreground-subtlest",
  },
  开发中: {
    className: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  已解决: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已上线: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

export const SEVERITY_BADGE: Record<
  FeedbackTicketSeverity,
  { label: string; className: string }
> = {
  "P1-高": {
    label: "P1",
    className: "text-rose-600 dark:text-rose-400 border-rose-500/40",
  },
  "P2-中": {
    label: "P2",
    className: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  },
  "P3-低": {
    label: "P3",
    className: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40",
  },
};

// 键是后端 FeedbackTicketModule 的枚举值；值是 intl 文案 id（feedback.module.*），只在本表做映射。
// 新增模块必须同批补一行，否则界面会掉回兜底文案；「其它」是兜底项。
export const FEEDBACK_MODULE_MESSAGE_IDS: Record<FeedbackTicketModule, string> = {
  "Plugin / MCP": "feedback.module.pluginMcp",
  Agent任务执行失败: "feedback.module.agentTaskFailed",
  "模型配置 / API Key": "feedback.module.modelConfigApiKey",
  模型调用报错: "feedback.module.modelCallError",
  "权限 / 配置保存": "feedback.module.permissionConfigSave",
  SSH连接失败: "feedback.module.sshConnectionFailed",
  WSL连接失败: "feedback.module.wslConnectionFailed",
  "UI布局 / 交互": "feedback.module.uiLayoutInteraction",
  "模型响应慢 / 额度": "feedback.module.modelSlowQuota",
  "崩溃 / Internal Error": "feedback.module.crashInternalError",
  "文档 / 使用咨询": "feedback.module.docsUsage",
  其它: "feedback.module.other",
};

export const FEEDBACK_STATUS_MESSAGE_IDS: Record<FeedbackTicketStatus, string> = {
  已提交: "feedback.status.pendingReview",
  信息不足: "feedback.status.needInfo",
  已采纳: "feedback.status.accepted",
  答复关闭: "feedback.status.closedByReply",
  // 后端 closed 仍归一为「已归档」兼容值，但不能把接口内部命名直接暴露给用户。
  // 这里映射到 completed 展示文案，让“我的反馈”列表和详情统一显示为「已完成」。
  已归档: "feedback.status.completed",
  已拒绝: "feedback.status.rejected",
  开发中: "feedback.status.inDevelopment",
  已解决: "feedback.status.resolved",
  已上线: "feedback.status.released",
};

export function formatFeedbackModuleLabel(
  module: FeedbackTicketModule,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_MODULE_MESSAGE_IDS[module] });
}

export function formatFeedbackStatusLabel(
  status: FeedbackTicketStatus,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_STATUS_MESSAGE_IDS[status] });
}
