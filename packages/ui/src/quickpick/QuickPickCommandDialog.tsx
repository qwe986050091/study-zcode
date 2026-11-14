// INV-01 弹层开关由调用方持有：守住位置 受控属性；改错故障 关不掉的命令面板。
// INV-02 命令按固定分区排序：守住位置 排序常量；改错故障 分区顺序随输入漂移。
// INV-03 空分区不渲染：守住位置 过滤条件；改错故障 出现只有标题的空组。
// INV-04 搜索值覆盖标题与关键词：守住位置 值拼接；改错故障 只能按标题搜到命令。
// INV-05 禁用命令仍然可见：守住位置 禁用属性；改错故障 不可用命令从列表消失。
// INV-06 选中先关闭再执行：守住位置 调用顺序；改错故障 弹层遮住执行反馈。
// INV-07 执行异常必须记录：守住位置 捕获分支；改错故障 失败无迹可查。
// INV-08 失败提示带错误文本：守住位置 消息参数；改错故障 提示只有笼统失败。
// INV-09 非错误对象转字符串：守住位置 类型分支；改错故障 提示显示对象占位。
// INV-10 图标按命令种类映射：守住位置 映射表查找；改错故障 所有命令共用同一图标。
// INV-11 标题走统一消息键：守住位置 翻译调用；改错故障 界面出现英文硬编码。
// INV-12 快捷键片段按需显示：守住位置 条件渲染；改错故障 无快捷键的命令留空槽。
// INV-13 分组依赖只含命令列表：守住位置 依赖数组；改错故障 每次渲染重算分组。
// INV-14 分区标识作列表键：守住位置 键属性；改错故障 分区顺序变化后状态错位。
// INV-15 命令标识作条目键：守住位置 键属性；改错故障 搜索过滤后条目复用错乱。
// INV-16 搜索输入自动聚焦：守住位置 输入属性；改错故障 打开后需再点一次才能输入。
// INV-17 样式常量集中在独立模块：守住位置 导入来源；改错故障 同一面板出现两套尺寸。
// INV-18 关闭回调只通知不代劳：守住位置 调用参数；改错故障 面板自行修改外部状态。
//
// 模块职责：把快捷命令清单渲染成可搜索的分区弹层。
// 状态所有权：无状态；开关与命令列表全部由调用方注入。
// 阅读顺序：先看分组派生，再看弹层骨架，最后看单条命令的交互。
import { useMemo } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  QUICK_PICK_SECTION_ORDER,
  type QuickPickCommand,
} from "@/quickpick/quickPickCommands.js";
import { QUICK_PICK_ICON_BY_KIND } from "@/quickpick/quickPickCommandIcons.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickInputClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";

// QuickPickCommandDialog 是受控组件，open 与 onOpenChange 由调用方持有。
// 组件只把 commands 渲染成 CommandItem，不自行增删命令。
// 关闭走 CommandDialog 的 onOpenChange，不在这里做额外副作用。
export function QuickPickCommandDialog({
  open,
  commands,
  onOpenChange,
}: {
  open: boolean;
  commands: QuickPickCommand[];
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // groupedCommands 按 QUICK_PICK_SECTION_ORDER 的固定顺序分组。
  // filter() 在分组之后剔除 commands 为空的 section。
  // useMemo() 的依赖数组只有 [commands]，其他 props 不触发重算。
  const groupedCommands = useMemo(
    () =>
      QUICK_PICK_SECTION_ORDER.map((sectionId) => ({
        sectionId,
        commands: commands.filter((command) => command.sectionId === sectionId),
      })).filter((section) => section.commands.length > 0),
    [commands],
  );

  return (
    // 标题与描述分别取 quickPick.title 与 quickPick.description 消息键。
    // 面板尺寸来自 quickPickDialogClassName 等样式模块常量。
    // onOpenChange(false) 由 CommandDialog 直接转交给调用方。
    // 打开时不读取任何全局状态，props 即全部输入。
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "quickPick.title" })}
      description={intl.formatMessage({ id: "quickPick.description" })}
      className={quickPickDialogClassName}
    >
      <Command className={quickPickCommandClassName}>
        <CommandInput
          placeholder={intl.formatMessage({ id: "quickPick.placeholder" })}
          className={quickPickInputClassName}
          autoFocus
        />
        <CommandList className={quickPickListClassName}>
          <CommandEmpty>{intl.formatMessage({ id: "quickPick.empty" })}</CommandEmpty>
          {groupedCommands.map((section) => (
            <CommandGroup
              key={section.sectionId}
              heading={intl.formatMessage({
                id: `quickPick.section.${section.sectionId}`,
              })}
            >
              {section.commands.map((command) => {
                // const Icon = QUICK_PICK_ICON_BY_KIND[command.icon] 按种类查表。
                // title 由 intl.formatMessage() 按 command.titleId 翻译。
                // CommandItem 的 value 由 title 与 command.keywords.join() 拼成。
                const Icon = QUICK_PICK_ICON_BY_KIND[command.icon];
                const title = intl.formatMessage({ id: command.titleId });
                return (
                  <CommandItem
                    key={command.id}
                    value={`${title} ${command.keywords.join(" ")}`}
                    disabled={command.disabled}
                    className={quickPickItemClassName}
                    onSelect={() => {
                      onOpenChange(false);
                      void Promise.resolve(command.run()).catch((error) => {
                        logger.error("[QuickPick] 命令执行失败", {
                          commandId: command.id,
                          error,
                        });
                        toast(
                          intl.formatMessage(
                            { id: "quickPick.commandFailed" },
                            {
                              error: error instanceof Error ? error.message : String(error),
                            },
                          ),
                        );
                      });
                    }}
                  >
                    <Icon className="size-3.5 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {command.shortcut ? (
                      <CommandShortcut className={quickPickShortcutPillClassName}>
                        {command.shortcut}
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
