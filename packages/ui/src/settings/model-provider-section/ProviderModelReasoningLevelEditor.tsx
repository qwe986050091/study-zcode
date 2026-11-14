// INV-01 受控组件：守住位置 values 只读入参；改错故障：组件内部缓存档位，外部重置后展示过期数据。
// INV-02 空值不落盘：守住位置 commitEdit 的判空；改错故障：空档位写入配置。
// INV-03 重名不落盘：守住位置 commitEdit 的去重比较；改错故障：两个档位同名无法区分。
// INV-04 原样失焦不覆盖：守住位置 同值提前返回分支；改错故障：仅查看档位就把整组写成个人配置。
// INV-05 追加与替换分离：守住位置 下标等于长度的分支；改错故障：新增档位覆盖已有档位。
// INV-06 至少保留一档：守住位置 删除按钮的 length 判断；改错故障：删空后无法新增。
// INV-07 顺序即时提交：守住位置 move 中的 onChange；改错故障：拖拽后先回位再跳转。
// INV-08 越界保护：守住位置 move 的范围判断；改错故障：负数或越界下标产生空档位。
// INV-09 编辑互斥：守住位置 editingIndex 的比较；改错故障：多个输入框同时可编辑。
// INV-10 新增槽语义：守住位置 editingIndex 等于长度；改错故障：新增按钮无法进入输入态。
// INV-11 焦点跟随：守住位置 focus 的 effect；改错故障：进入编辑后需手动点击输入框。
// INV-12 拖拽反馈：守住位置 draggingIndex 的样式；改错故障：拖动时无视觉反馈。
// INV-13 拖拽结束清理：守住位置 onDragEnd 与 drop 的重置；改错故障：高亮残留到下一次交互。
// INV-14 键盘等价：守住位置 Alt 加方向键；改错故障：键盘用户无法调整顺序。
// INV-15 回车与空格：守住位置 chip 的按键分支；改错故障：键盘无法进入编辑。
// INV-16 高度一致：守住位置 外层 border-box；改错故障：档位比输入框高 2px，横向错位。
// INV-17 覆盖态样式：守住位置 modelEditorControlStyle 的入参；改错故障：个人配置态外观与默认态无差异。
// INV-18 无障碍标签：守住位置 删除与新增的 aria 文案；改错故障：读屏只念到图标。
//
// 模块职责：编辑模型推理档位的字符串列表，支持拖拽排序、键盘排序与就地编辑。
// 状态所有权：编辑态与拖拽态属于本组件；档位数据由父组件通过 values 持有。
// 阅读顺序：入参与状态 → 焦点 → 提交与排序 → 键盘与拖放 → 渲染结构。
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { modelEditorControlStyle } from "@/settings/model-provider-section/modelEditorControlStyle.js";

// 入参分两类：values 是只读数据源，overridden 只影响覆盖态样式。
// onChange 是唯一出口，任何增删改排都要经由它回到父组件。
// 组件不自建默认档位，空列表时就只有新增按钮。
//
export function ProviderModelReasoningLevelEditor({
  values,
  overridden,
  addLabel,
  deleteLabel,
  onChange,
}: {
  values: readonly string[];
  overridden: boolean;
  addLabel: string;
  deleteLabel: string;
  onChange: (values: readonly string[]) => void;
}) {
  // 编辑下标为 null 表示无人编辑，等于 values 长度表示正在新增。
  // draggingIndex 只服务拖拽视觉反馈，不参与数据写回。
  //
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入编辑后 inputRef 自动聚焦，键盘用户无需再点一次输入框。
  // 依赖只有编辑下标，切换编辑目标即重新聚焦。
  //
  useEffect(() => {
    if (editingIndex !== null) inputRef.current?.focus();
  }, [editingIndex]);

  const beginEdit = (index: number, value = values[index] ?? "") => {
    setEditingIndex(index);
    setEditingValue(value);
  };
  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingValue("");
  };
  // 提交前先判空去重：nextValue 为空或与其它档位重名都不落盘。
  // 打开后原样失焦不算用户覆盖，避免仅查看就把整组写成个人配置。
  // 校验失败时保持 editingIndex 不变，用户可以继续修正。
  // editingIndex 等于 values.length 时走追加，否则原地替换。
  // 提交后把 editingIndex 置空，让输入框与档位互斥展示。
  //
  const commitEdit = () => {
    if (editingIndex === null) return;
    const nextValue = editingValue.trim();
    if (
      !nextValue ||
      values.some((value, index) => index !== editingIndex && value === nextValue)
    ) {
      return;
    }
    // 打开后原样失焦不是用户覆盖；否则仅查看档位就会把整组写成个人配置。
    if (editingIndex < values.length && nextValue === values[editingIndex]) {
      cancelEdit();
      return;
    }
    const next = [...values];
    if (editingIndex === values.length) next.push(nextValue);
    else next[editingIndex] = nextValue;
    onChange(next);
    cancelEdit();
  };
  // 越界或原地移动直接返回，拖拽不会产生多余的写回。
  // 先取出再插入，得到新的顺序数组后交给上层。
  // 拖拽结束即提交顺序，不等外部刷新，避免先回位再跳转。
  //
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) return;
    const next = [...values];
    const [value] = next.splice(from, 1);
    next.splice(to, 0, value!);
    // drop 时立即提交本地顺序，避免等待外部刷新后先回位再跳转。
    onChange(next);
  };
  // Alt 加左右方向键调整档位顺序，与拖拽等价。
  // 回车与空格进入编辑，并阻止默认行为避免页面滚动。
  //
  const handleChipKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      move(index, event.key === "ArrowLeft" ? index - 1 : index + 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      beginEdit(index);
    }
  };
  // handleDrop 按 draggingIndex 与 targetIndex 调用 move。
  // targetIndex 越界由 move 兜底，这里不重复校验。
  // 无论是否发生移动都把 draggingIndex 置空，避免高亮残留。
  //
  const handleDrop = (event: DragEvent<HTMLDivElement>, targetIndex: number) => {
    event.preventDefault();
    if (draggingIndex !== null) move(draggingIndex, targetIndex);
    setDraggingIndex(null);
  };

  // 档位外层是普通 div；若沿用 content-box，h-8 会再叠加 2px 边框，
  // 导致静态档位、编辑框和新增按钮的实际高度不一致。
  return (
    <div
      // 外层用 border-box，h-8 不再叠加边框，档位与输入框、新增按钮高度一致。
      // 正在编辑的那一档关闭拖拽，避免拖拽事件抢走输入焦点。
      // 删除按钮在只剩一档时禁用，保证列表永远非空。
      //
      className="flex flex-wrap items-center gap-1.5"
      data-personal-override={overridden}
      data-model-reasoning-level-editor="true"
    >
      {values.map((value, index) => (
        <div
          key={`${value}-${index}`}
          data-model-reasoning-chip="true"
          data-personal-override={overridden}
          draggable={editingIndex !== index}
          onDragStart={(event) => {
            setDraggingIndex(index);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => handleDrop(event, index)}
          onDragEnd={() => setDraggingIndex(null)}
          className={cn(
            "group box-border inline-flex h-8 select-none items-center rounded-lg border focus-within:bg-hover",
            modelEditorControlStyle(overridden, false),
            draggingIndex === index && "opacity-60",
          )}
        >
          {editingIndex === index ? (
            <input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              ref={inputRef}
              value={editingValue}
              className="h-8 field-sizing-content min-w-10 max-w-32 border-0 bg-transparent px-2 text-ui-base text-foreground outline-none"
              data-model-reasoning-level-input="true"
              onChange={(event) => setEditingValue(event.target.value)}
              onBlur={commitEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitEdit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                }
              }}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-w-10 shrink cursor-grab rounded-lg border-0 bg-transparent px-2 active:cursor-grabbing hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0"
              onClick={() => beginEdit(index)}
              onKeyDown={(event) => handleChipKeyDown(event, index)}
            >
              {value}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mr-0.5 size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-0"
            aria-label={`${deleteLabel}: ${value}`}
            disabled={values.length <= 1}
            onClick={() => onChange(values.filter((_, valueIndex) => valueIndex !== index))}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ))}
      {editingIndex === values.length ? (
        <input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          ref={inputRef}
          value={editingValue}
          className={cn(
            "h-8 field-sizing-content min-w-10 max-w-32 rounded-lg border px-2 text-ui-base text-foreground",
            modelEditorControlStyle(false),
          )}
          data-model-reasoning-level-input="true"
          onChange={(event) => setEditingValue(event.target.value)}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitEdit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          data-model-reasoning-level-add="true"
          className={modelEditorControlStyle(false, false)}
          onClick={() => beginEdit(values.length)}
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{addLabel}</span>
        </Button>
      )}
    </div>
  );
}
