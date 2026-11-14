// bots/commandOrder.ts — Bot 菜单与命令策略的稳定展示顺序。
//
// INV-01 策略命令顺序是外部可见契约：菜单渲染、帮助文本与命令解析共用同一序列，
//        调整顺序会改变用户看到的菜单与快捷指令编号，必须与 @zcode/shared 的
//        BotCommandPolicy 键集合同步增删。
// INV-02 help 固定在最前、bind 固定在最后；两者不属于策略命令，不能被
//        BOT_POLICY_COMMAND_ORDER 覆盖。
// INV-03 导出为 as const 只读元组；调用方按位置取用时不要展开成可变数组。
import type { BotCommandPolicy } from "@zcode/shared";
const BOT_POLICY_COMMAND_ORDER = [
  "status",
  "new",
  "workspace",
  "model",
  "mode",
  "thoughtLevel",
  "reply",
] as const satisfies readonly (keyof BotCommandPolicy)[];

export const BOT_MENU_COMMAND_ORDER = [
  "help",
  ...BOT_POLICY_COMMAND_ORDER,
  "bind",
] as const;
