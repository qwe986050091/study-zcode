// INV-01 回车确认前先查输入法：守住位置 组合状态判断；改错故障 选词回车直接提交。
// INV-02 平台事件与本地状态双读：守住位置 双字段传入；改错故障 时序差异漏判。
// INV-03 组合态回车不改默认：守住位置 提前返回；改错故障 输入法候选被吞掉。
// INV-04 非组合态回车阻断默认：守住位置 阻止默认；改错故障 表单被回车提交两次。
// INV-05 确认只走一条路：守住位置 处理器调用；改错故障 按钮与回车行为分叉。
// INV-06 组合开始置位：守住位置 组合开始回调；改错故障 首次输入即误判已组合。
// INV-07 组合结束清除置位：守住位置 组合结束回调；改错故障 组合态永久粘住。
// INV-08 组合状态用引用保存：守住位置 引用容器；改错故障 每次渲染重置状态。
// INV-09 取消只关闭不提交：守住位置 取消回调；改错故障 放弃修改仍改写任务名。
// INV-10 输入值完全受控：守住位置 值属性；改错故障 界面输入与状态脱节。
// INV-11 输入框引用由调用方注入：守住位置 引用属性；改错故障 打开后无法自动聚焦。
// INV-12 标题与占位走国际化：守住位置 格式化调用；改错故障 界面出现硬编码文案。
// INV-13 弹框开合交给宿主：守住位置 受控属性；改错故障 内部状态与宿主不同步。
// INV-14 忽略路径记录调试日志：守住位置 日志调用；改错故障 输入法问题无法定位。
// INV-15 确认路径记录长度摘要：守住位置 日志字段；改错故障 排查时看不到长度差异。
// INV-16 日志只带长度不带原文：守住位置 字段选择；改错故障 任务名泄漏进日志。
// INV-17 关闭描述与标题并列：守住位置 头部结构；改错故障 读屏缺少对话框名。
// INV-18 按钮尺寸与间距统一：守住位置 类名常量；改错故障 两个按钮高低不齐。
//
// 模块职责：任务重命名的受控对话框，处理输入法组合与回车确认。
// 状态所有权：输入值与开合由调用方持有，组合标记由本地引用持有。
// 阅读顺序：先看属性契约，再看组合标记，最后看弹框结构与两个按钮。
import { useRef } from "react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";

// open / value / inputRef 全部受控，组件不持有可写副本。
// compositionActiveRef 用引用保存组合标记。
// onConfirm 与 onCancel 都回传宿主，组件不决定结果。
// 组件不持有 useState，内部无可写状态。
export function TaskRenameDialog({
  open,
  value,
  inputRef,
  intl,
  onOpenChange,
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // compositionActiveRef 初值 false，表示未在组合。
  // onCompositionStart 置为 true。
  // onCompositionEnd 置回 false。
  // Enter 前读取该值，组合中不提交。
  const compositionActiveRef = useRef(false);

  // Dialog 的 open / onOpenChange 由宿主受控。
  // Input 的 value / onChange 绑定宿主值。
  // DialogFooter 放取消与确认两个 Button。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden rounded-2xl p-0">
        <div className="flex min-w-0 flex-col gap-6 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>{intl.formatMessage({ id: "taskList.rename" })}</DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col space-y-4">
            <Input
              ref={inputRef}
              value={value}
              size="lg"
              placeholder={intl.formatMessage({ id: "taskList.renamePlaceholder" })}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  if (
                    isImeComposingKeyEvent({
                      compositionActive: compositionActiveRef.current,
                      nativeEvent: event.nativeEvent,
                    })
                  ) {
                    // task 重命名里中文输入法 Enter 是候选确认，不是确认按钮。
                    // 同时读取本地 composition 状态，避免平台事件时序让 isComposing 提前变 false。
                    logger.debug("[TaskRenameDialog] ignore rename enter during IME", {
                      valueLength: value.length,
                    });
                    return;
                  }
                  event.preventDefault();
                  logger.info("[TaskRenameDialog] rename confirm via enter", {
                    valueLength: value.length,
                    trimmedLength: value.trim().length,
                  });
                  onConfirm();
                }
              }}
            />
          </div>
          <DialogFooter className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={onCancel}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={() => {
                logger.info("[TaskRenameDialog] rename confirm via button", {
                  valueLength: value.length,
                  trimmedLength: value.trim().length,
                });
                onConfirm();
              }}
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
