// INV-01 有任意模态在场时不得开营销弹窗：守住位置 canOpenMarketingPopup 的查询；改错故障 弹窗叠在登录或支付流程之上。
// INV-02 隐藏标签页同样不弹：守住位置 visibilityState 判断；改错故障 后台恢复时一次性弹多个。
// INV-03 选择器表是唯一白名单：守住位置 拼接数组；改错故障 新模态漏登记后弹窗穿插。
// INV-04 HTML 标签只取纯文本：守住位置 template.content.textContent；改错故障 富文本混入可执行节点。
// INV-05 解析前先移除五类危险节点：守住位置 querySelectorAll；改错故障 带副作用属性的节点被执行。
// INV-06 取不到文本时退化为空串：守住位置 空值合并；改错故障 标题渲染出 null。
// INV-07 按钮 id 按数组下标生成：守住位置 button 加 index；改错故障 两个按钮抢同一个 action。
// INV-08 actions 与 buttons 共用同一 key：守住位置 同一 index；改错故障 点击后找不到对应动作。
// INV-09 只有 close 走次要样式：守住位置 variant 三元；改错故障 主次按钮视觉反转。
// INV-10 计划查看按钮可被文案覆盖：守住位置 labelOverride 的三重条件；改错故障 升级页显示通用按钮名。
// INV-11 navigate 目标只映射到两个内页：守住位置 destination 三元；改错故障 未知 page 值把用户带到空白页。
// INV-12 动作类型必须穷尽：守住位置 末尾的 claim_plan 兜底；改错故障 新增动作被默默当成领取计划。
// INV-13 plaintext 统一归一为 plain_text：守住位置 formatted 字段；改错故障 渲染层按未知 format 处理。
//
// 模块职责：把服务端下发的营销弹窗载荷适配成通用云内容弹窗的入参。
// 阅读顺序：先看可弹出条件与 HTML 取文本，再看按钮映射与动作表。
import { additionalRequestModalSelectors } from "@/request-security-edition/errors.js";
import { isStartPlanModelProviderId, type MarketingPopup } from "@zcode/shared";
import type {
  CloudContentDialogPayload,
  CloudDialogHero,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

// `canOpenMarketingPopup` 先看 `visibilityState`：标签页不可见时不弹，免得用户回来撞见一串弹窗。
// 只要 `[role="dialog"]` 或 `[role="alertdialog"]` 在场就算被打断，本次机会直接放弃。
// 选择器列表覆盖三类弹窗：通用对话框角色以及升级入口与补充材料（`additionalRequestModalSelectors`）。
export function canOpenMarketingPopup() {
  return (
    document.visibilityState !== "hidden" &&
    !document.querySelector(
      [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[data-testid="coding-plan-upgrade-surface"]',
        ...additionalRequestModalSelectors,
      ].join(", "),
    )
  );
}

export function marketingLabel(text: MarketingPopup["title"]): string {
  if (text.format !== "html") return text.content;
  // 用 template 解析不会触发图片加载与脚本执行。
  // 先删危险节点再取 textContent，双保险。
  // 取不到文本时返回空串，调用方不需要再判空。
  const template = document.createElement("template");
  template.innerHTML = text.content;
  template.content
    .querySelectorAll("script,style,iframe,object,svg,math,template")
    .forEach((node) => node.remove());
  return template.content.textContent?.trim() ?? "";
}

export function adaptMarketingPopup(
  id: string,
  locale: "zh-CN" | "en-US",
  popup: MarketingPopup,
  hero: CloudDialogHero | null,
  viewPlanLabel?: string,
): CloudContentDialogPayload {
  const actions: CloudContentDialogPayload["actions"] = {};
  // 下标即稳定 key：服务端按钮顺序变化会改变 key，属于预期。
  // 文案覆盖只对指定 provider 的模型设置页生效。
  // formattedLabel 在覆盖时强制纯文本，避免套用富文本格式。
  // 每个按钮同时产出一条 action，两者共用同一个 key。
  const buttons = popup.buttons.map((button, index) => {
    const key = `button-${index}`;
    const action = button.action;
    const labelOverride =
      viewPlanLabel &&
      action.type === "navigate" &&
      action.args.page === "settings" &&
      action.args.section === "models" &&
      isStartPlanModelProviderId(action.args.provider_id ?? "")
        ? viewPlanLabel
        : undefined;
    // 四种服务端动作映射到三种通用动作，close 不跳转。
    // navigate 只区分插件市场与设置，其它值一律落到设置。
    // claim_plan 是唯一兜底分支，新增类型必须先在这里补映射。
    actions[key] =
      action.type === "close"
        ? { type: "close" }
        : action.type === "open_url"
          ? { type: "open_external", url: action.args.url }
          : action.type === "copy_text"
            ? { type: "copy_text", text: action.args.text }
            : action.type === "navigate"
              ? {
                  type: "navigate",
                  destination:
                    action.args.page === "plugin_marketplace" ? "plugin_store" : "settings",
                }
              : { type: "claim_plan", planId: action.args.plan_id };
    return {
      id: key,
      actionId: key,
      label: labelOverride ?? marketingLabel(button.text),
      formattedLabel: {
        format:
          labelOverride || button.text.format === "plaintext"
            ? ("plain_text" as const)
            : button.text.format,
        text: labelOverride ?? button.text.content,
      },
      variant: action.type === "close" ? ("secondary" as const) : ("primary" as const),
      theme: button.theme ?? { variant: "default" as const },
    };
  });
  return {
    // revision 固定为 1：同一弹窗不参与增量更新。
    // 标题与描述分别给出可渲染文本与原始格式，供不同端取用。
    schemaVersion: 1,
    id,
    revision: 1,
    kind: "campaign",
    locale,
    dialog: {
      title: marketingLabel(popup.title),
      formattedTitle: {
        format: popup.title.format === "plaintext" ? "plain_text" : popup.title.format,
        text: popup.title.content,
      },
      description: {
        format: popup.description.format === "plaintext" ? "plain_text" : popup.description.format,
        text: popup.description.content,
      },
      hero,
      buttons,
    },
    actions,
  };
}
