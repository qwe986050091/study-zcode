// INV-01 分类总数由父级算好：守住位置 props.categories；改错故障 组件内重复求和，两处数字不一致。
// INV-02 可清理需双条件：守住位置 cleanability 与 bytes 的与运算；改错故障 零字节分类仍出现清理按钮。
// INV-03 清理中按 id 匹配：守住位置 cleaningCategory 等值判断；改错故障 点一行让所有行都转圈。
// INV-04 打开入口有两个：守住位置 整行按钮与箭头按钮；改错故障 只有点箭头才进详情。
// INV-05 标题与描述 id 统一生成：守住位置 storageCategoryTitleId；改错故障 新增分类没有翻译键。
// INV-06 图标表集中一处：守住位置 STORAGE_CATEGORY_ICONS；改错故障 同类图标在不同页面不一致。
// INV-07 字节只经 formatBytes：守住位置 尺寸文本；改错故障 各分类单位换算规则不同。
// INV-08 测试 id 以分类 id 为后缀：守住位置 testId 调用；改错故障 自动化无法定位具体分类行。
// INV-09 禁用只作用于清理：守住位置 Button 的 disabled；改错故障 清理进行中连详情都打不开。
// INV-10 清理文案随状态切换：守住位置 cleaning 三元；改错故障 转圈同时仍写「清理」。
// INV-11 首行不吃上边框：守住位置 first:border-t-0；改错故障 列表顶端多出一条分隔线。
// INV-12 装饰图标对读屏隐藏：守住位置 两处 aria-hidden；改错故障 读屏重复念出图标名。
// INV-13 箭头按钮补 aria-label：守住位置 标题文案复用；改错故障 无可见文字的按钮没有名称。
// INV-14 组件完全受控：守住位置 无本地 state；改错故障 父级刷新后行内状态残留。
//
// 模块职责：渲染存储分类列表，负责打开详情与触发清理两个动作。
// 阅读顺序：先看可清理判定，再看行内两处入口，最后看清理按钮的加载与禁用。
import { ChevronRight, Loader2 } from "lucide-react";
import { type StorageCategoryId } from "@zcode/shared";
import {
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN,
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW,
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import {
  STORAGE_CATEGORY_ICONS,
  storageCategoryDescriptionId,
  storageCategoryTitleId,
  type StorageCategoryTotal,
} from "./storageCategoryPresentation.js";

// 分类数据与回调全部来自父级，这里不持有状态。
export function StorageCategoryList({
  categories,
  cleaningCategory,
  disabled,
  onOpen,
  onClean,
}: {
  categories: StorageCategoryTotal[];
  cleaningCategory: StorageCategoryId | null;
  disabled: boolean;
  onOpen: (id: StorageCategoryId) => void;
  onClean: (id: StorageCategoryId) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-card">
      {categories.map((category) => {
        // 图标按分类 id 查表，只作视觉标识。
        const Icon = STORAGE_CATEGORY_ICONS[category.id];
        // cleanable 必须同时满足 cleanability !== "none" 且 bytes > 0，缺一条就不能清。
        const cleanable = category.cleanability !== "none" && category.bytes > 0;
        // 只有正在清理的那一行显示进度。
        const cleaning = cleaningCategory === category.id;
        return (
          <div
            // 用分类 id 作 key，顺序变化不会复用错行。
            key={category.id}
            className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
          >
            <button
              type="button"
              // 整行 button 是打开详情的入口，data-testid 由 TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW 拼上分类 id。
              data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW, category.id)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => onOpen(category.id)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: storageCategoryTitleId(category.id) })}
                </span>
                <span
                  data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE, category.id)}
                  // 尺寸用 tabular-nums 等宽数字，刷新时宽度不会跳动。
                  className="block text-ui-caption tabular-nums text-foreground-subtle"
                  title={intl.formatMessage({ id: storageCategoryDescriptionId(category.id) })}
                >
                  {formatBytes(category.bytes)}
                </span>
              </span>
            </button>
            {cleanable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, category.id)}
                disabled={disabled}
                onClick={() => onClean(category.id)}
              >
                {cleaning ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                {intl.formatMessage({
                  // 按钮文案随清理状态切换。
                  id: cleaning
                    ? "resourceManager.storage.cleaning"
                    : "resourceManager.storage.clean",
                })}
              </Button>
            ) : null}
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtlest hover:bg-surface-hover"
              // 箭头按钮没有可见文字，aria-label 必须用分类标题补上名称，否则读屏无法定位。
              aria-label={intl.formatMessage({ id: storageCategoryTitleId(category.id) })}
              onClick={() => onOpen(category.id)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
