// bots/commandParser.ts — 把聊天文本解析成 BotCommand。
//
// INV-01 非命令文本原样返回 message；单独的数字 0 是历史取消选择快捷键。
// INV-02 命令名大小写不敏感，中文别名必须与英文等价。
// INV-03 缺参数的命令返回 unknown 而不是静默降级成 list，便于用户发现用法错误。
// INV-04 解析是纯函数，不做权限判断；授权在 botConfigHelpers 里按命令名判定。
// [兼容] thoughtlevel 保留三种拼写，历史客户端可能发送任意一种。
import type { BotCommand } from "@zcode/shared";

// 拆分 /name rest；不是命令返回 null。
function splitCommand(text: string): { name: string; rest: string } | null {
  // 先 trim，命令必须从行首斜杠开始。
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  // 前导斜杠已判存在，这里用 body = trimmed.slice(1) 去掉它再按空白切分。
  const body = trimmed.slice(1);
  // 只按第一个空白切分，rest 内部空白保留。
  const firstSpace = body.search(/\s/u);
  if (firstSpace === -1) {
    // 无参数形态。
    return { name: body.toLowerCase(), rest: "" };
  }
  return {
    name: body.slice(0, firstSpace).toLowerCase(),
    rest: body.slice(firstSpace + 1).trim(),
  };
}

// 主入口：switch 顺序不影响结果，命令名互不重叠。
export function parseBotCommand(text: string): BotCommand {
  const parsed = splitCommand(text);
  // 非命令分支（见 INV-01）。
  if (!parsed) {
    return text.trim() === "0" ? { type: "selection.cancel" } : { type: "message", text };
  }

  // name 已小写，rest 已 trim。
  const { name, rest } = parsed;
  switch (name) {
    // leave 映射成 topic.leave，让群话题退出与普通消息走同一分发口。
    case "leave":
      return { type: "topic.leave" };
    // on/off 缺省表示查询当前状态。
    case "history":
      return !rest || rest === "on" || rest === "off"
        ? { type: "group.history", ...(rest ? { enabled: rest === "on" } : {}) }
        : { type: "unknown", name, raw: text };
    // 必须带 commandId，缺参视为用法错误。
    case "queue-cancel":
      return rest
        ? { type: "queue.cancel", commandId: rest }
        : { type: "unknown", name, raw: text };
    case "enable":
      return { type: "group.enable" };
    case "disable":
      return { type: "group.disable" };
    // 绑定码必须是唯一参数。
    case "bind":
      return rest ? { type: "bind", code: rest } : { type: "unknown", name, raw: text };
    // 帮助文本。
    case "help":
    case "帮助":
      return { type: "help" };
    // cancel 与「取消」都映射成 selection.cancel，两种语言写法共用同一分支。
    case "cancel":
    case "取消":
      return { type: "selection.cancel" };
    // 状态查询。
    case "status":
    case "状态":
      return { type: "status" };
    // new/clear/新建 语义相同：开启新任务。
    case "new":
    case "clear":
    case "新建":
      return { type: "new" };
    // reconnect 与「重连」映射成 reconnect 类型，交给上层重建远端连接。
    case "reconnect":
    case "重连":
      return { type: "reconnect" };
    // 无参数列出工作区，有参数切换。
    case "workspace":
    case "project":
    case "项目":
      return rest ? { type: "workspace.set", value: rest } : { type: "workspace.list" };
    // 支持 provider 与 model 两级写法。
    case "model":
    case "模型":
      if (!rest) {
        return { type: "model.list" };
      }
      if (rest.startsWith("provider ")) {
        return { type: "model.provider.set", value: rest.slice("provider ".length).trim() };
      }
      if (rest.startsWith("model ")) {
        return { type: "model.set", value: rest.slice("model ".length).trim() };
      }
      return { type: "model.set", value: rest };
    // 无参数列出模式，有参数设置。
    case "mode":
    case "模式":
      return rest ? { type: "mode.set", value: rest } : { type: "mode.list" };
    // 三种拼写 + 中文别名（见兼容说明）。
    case "thoughtlevel":
    case "thought_level":
    case "thought-level":
    case "think":
    case "思考":
      return rest ? { type: "thoughtLevel.set", value: rest } : { type: "thoughtLevel.list" };
    // 任务选择：无参数列出。
    case "task":
      return rest ? { type: "task.set", value: rest } : { type: "task.list" };
    // 回复颗粒度：无参数列出。
    case "reply":
    case "回复":
      return rest ? { type: "reply.set", value: rest } : { type: "reply.list" };
    // stop 与「停止」都返回 { type: "stop" }，由运行态自身中断当前任务。
    case "stop":
    case "停止":
      return { type: "stop" };
    // 权限响应必须带值。
    case "permission":
      return rest
        ? { type: "permission.respond", value: rest }
        : { type: "unknown", name, raw: text };
    // 提交关键字走 submit，其余作为回答内容。
    case "elicitation":
    case "answer":
    case "回答":
      if (!rest) {
        return { type: "unknown", name, raw: text };
      }
      if (["submit", "done", "完成", "提交"].includes(rest.toLowerCase())) {
        return { type: "elicitation.submit" };
      }
      return { type: "elicitation.respond", value: rest };
    // 审批需要 requestId + optionId 两个参数。
    case "approve": {
      const [requestId, optionId] = rest.split(/\s+/u);
      return requestId && optionId
        ? { type: "approve", requestId, optionId }
        : { type: "unknown", name, raw: text };
    }
    // 拒绝只需 requestId。
    case "deny":
      return rest ? { type: "deny", requestId: rest } : { type: "unknown", name, raw: text };
    // 未知命令保留原始文本，供上层提示或透传。
    default:
      return { type: "unknown", name, raw: text };
  }
}
