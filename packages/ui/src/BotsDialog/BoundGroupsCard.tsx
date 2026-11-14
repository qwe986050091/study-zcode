// INV-01 列表以会话标识作键：守住位置 键属性；改错故障 保存后行状态串位。
// INV-02 名称超长截断并保留悬停：守住位置 截断类与标题；改错故障 长群名撑破布局。
// INV-03 单复数走不同消息键：守住位置 三元标识；改错故障 英文出现复数错乱。
// INV-04 禁用条件合并三种来源：守住位置 或运算；改错故障 机器人关闭仍可切换。
// INV-05 保存中整列不可切换：守住位置 空值判断；改错故障 并发保存互相覆盖。
// INV-06 正在保存的行带忙碌标记：守住位置 忙碌属性；改错故障 读屏不知道哪行在处理。
// INV-07 开关带含群名的无障碍名：守住位置 标签参数；改错故障 读屏只念开关。
// INV-08 加载态独占一屏：守住位置 三元首支；改错故障 加载时先闪空列表。
// INV-09 有数据才渲染列表：守住位置 长度判断；改错故障 空数组渲染空容器。
// INV-10 空态不覆盖错误：守住位置 错误与运算；改错故障 失败同时显示未绑定。
// INV-11 机器人关闭时补充说明：守住位置 条件渲染；改错故障 用户不知道为何不能开。
// INV-12 错误区以警示角色播报：守住位置 角色属性；改错故障 加载失败读屏无感知。
// INV-13 错误文案按来源区分：守住位置 三元标识；改错故障 保存失败被说成加载失败。
// INV-14 错误旁给重试入口：守住位置 幽灵按钮；改错故障 失败后只能关闭弹窗。
// INV-15 卡片标题与分区标签同文案：守住位置 两处消息键；改错故障 标题与读屏名不一致。
// INV-16 区块以标题作无障碍名：守住位置 标签属性；改错故障 分区在读屏里无名。
// INV-17 列表带测试标识：守住位置 数据属性；改错故障 端到端测试定位不到列表。
// INV-18 卡片只组合查询结果：守住位置 组件职责；改错故障 组件内自行发起请求。
//
// 模块职责：机器人设置里已绑定群聊的列表与开关。
// 状态所有权：无状态；行数据、加载与保存状态全部来自专用 hook。
// 阅读顺序：先看单行结构，再看三种主体状态，最后看错误区。
import type { BotConfig } from "@zcode/shared";
import { useBotBoundGroups, type BoundGroupRow } from "@/hooks/useBotBoundGroups.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

// 每行以 row.sessionId 作 key。
// 名称经 CSS 截断，title 保留全文供悬停查看。
// Switch 的 checked 完全由 row 数据决定。
// saving 为真时整列 Switch 都 disabled。
export function BoundGroupsList({
  rows,
  disabled,
  saving,
  onToggle,
}: {
  rows: BoundGroupRow[];
  disabled: boolean;
  saving: string | null;
  onToggle: (chatId: string, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="divide-y divide-border" data-testid="bot-bound-groups">
      {rows.map((row) => (
        <div
          key={row.chatId}
          className="flex min-w-0 items-center gap-3 px-4 py-3"
          data-group-id={row.chatId}
        >
          <span
            className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            title={row.name}
          >
            {row.name}
          </span>
          <span className="shrink-0 whitespace-nowrap text-ui-sm text-foreground-subtle">
            {/* 当前格式化器只替换简单占位符，单复数通过文案 key 选择。 */}
            {intl.formatMessage(
              { id: row.topicCount === 1 ? "bots.boundGroups.countOne" : "bots.boundGroups.count" },
              { count: row.topicCount },
            )}
          </span>
          <Switch
            checked={row.enabled}
            disabled={disabled || saving !== null}
            aria-busy={saving === row.chatId}
            aria-label={intl.formatMessage({ id: "bots.boundGroups.toggle" }, { name: row.name })}
            onCheckedChange={(enabled) => onToggle(row.chatId, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

// loading 为真时不再渲染空态，error 优先于空态。
// 空态不覆盖 error，error 优先渲染。
// bot.enabled 为假时补一句说明。
// error 旁提供 reload 重试入口。
export function BoundGroupsCard({ bot }: { bot: BotConfig }) {
  const { intl } = useZCodeIntl();
  // 查询结果全部来自专用 hook。
  // 组件不自行 fetch，全部经 useBotBoundGroups。
  // 保存状态以群标识表示。
  const { rows, loading, error, saving, reload, toggle, supported } = useBotBoundGroups(bot);
  return (
    <SettingsGroupCard>
      <section
        className="min-w-0"
        aria-label={intl.formatMessage({ id: "bots.boundGroups.title" })}
      >
        <h3 className="border-b border-border px-4 py-3 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "bots.boundGroups.title" })}
        </h3>
        {loading ? (
          <p className="px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "bots.boundGroups.loading" })}
          </p>
        ) : rows.length ? (
          <BoundGroupsList
            rows={rows}
            disabled={!bot.enabled || !supported}
            saving={saving}
            onToggle={(chatId, enabled) => void toggle(chatId, enabled)}
          />
        ) : (
          !error && (
            <p className="px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "bots.boundGroups.empty" })}
            </p>
          )
        )}
        {!bot.enabled && (
          <p className="px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "bots.boundGroups.botOff" })}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 px-4 py-3 text-ui-sm text-destructive"
          >
            <span>
              {intl.formatMessage({
                id:
                  error === "load" ? "bots.boundGroups.loadFailed" : "bots.boundGroups.saveFailed",
              })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {intl.formatMessage({ id: "bots.boundGroups.refresh" })}
            </Button>
          </div>
        )}
      </section>
    </SettingsGroupCard>
  );
}
