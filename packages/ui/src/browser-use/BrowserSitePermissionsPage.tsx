// INV-01 仅本次不展示：守住位置 数据源；改错故障 临时授权被写入列表。
// INV-02 不支持平台给说明：守住位置 支持判断；改错故障 空白页无解释。
// INV-03 保存中禁用全部控件：守住位置 忙碌判断；改错故障 并发写入互相覆盖。
// INV-04 缺状态时禁用重置：守住位置 空值判断；改错故障 未加载就允许重置。
// INV-05 三态映射固定：守住位置 映射链；改错故障 未知值被当允许。
// INV-06 能力清单驱动渲染：守住位置 常量遍历；改错故障 新增权限漏渲染。
// INV-07 窄栏名称保宽：守住位置 最小宽；改错故障 下拉框挤成逐字断行。
// INV-08 下拉触发器有可访问名：守住位置 标签属性；改错故障 读屏只念当前值。
// INV-09 选项文案走国际化：守住位置 格式化；改错故障 出现硬编码枚举。
// INV-10 保存成功给状态提示：守住位置 成功分支；改错故障 用户不知是否生效。
// INV-11 重置成功区别于保存：守住位置 操作类型；改错故障 两种结果同一文案。
// INV-12 写入失败给重试：守住位置 失败分支；改错故障 只能重开页面。
// INV-13 读取失败给重试：守住位置 错误分支；改错故障 列表空白无出口。
// INV-14 重试期间禁用：守住位置 忙碌条件；改错故障 连续点击重复写入。
// INV-15 测试标识按能力编码：守住位置 编码调用；改错故障 特殊字符破坏选择器。
// INV-16 标题展示完整来源：守住位置 断词规则；改错故障 长来源溢出。
// INV-17 页面自身可滚动：守住位置 高度类；改错故障 内容被裁掉。
// INV-18 文案前缀统一：守住位置 局部格式化器；改错故障 键名散落各处。
//
// 模块职责：浏览器站点权限设置标签页。
// 状态所有权：权限状态与写入动作归专用钩子，本页只渲染。
// 阅读顺序：先看钩子返回值，再看忙碌与提示，最后看渲染分支。
import { BrowserPermissionIcon } from "@/browser-use/BrowserPermissionIcon.js";
import { BROWSER_PERMISSION_CAPABILITIES } from "@/browser-use/browserPermissionCapabilities.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useBrowserSitePermissions } from "@/hooks/useBrowserSitePermissions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 站点权限设置标签页：数据源为 main 站点权限 store，「仅本次」临时态不展示。 */
// 数据来自 useBrowserSitePermissions，页面不直接读 store。
// session 级临时授权不在此展示，避免与持久态混淆。
// supported 为假时渲染说明文案，不给出可操作控件。
// 页面自身承担滚动，外层布局不再套 overflow 容器。
// 内容限宽 max-w-3xl 并居中，宽屏下不拉满整行。
export function BrowserSitePermissionsPage({
  origin,
  isVisible,
}: {
  origin: string;
  isVisible: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `browser.permission.${id}` });
  // states 与 readError 分开返回，读取失败仍可展示已缓存项。
  // write 动作内置重试，retryWrite 只在用户点击时触发。
  // reset 与 setPermission 分开调用，重置不经过单项写入队列。
  // isVisible 为假时 hook 不读取，隐藏标签页不产生请求。
  // 查询作用域锁定 origin，切换站点会重新订阅。
  const { states, error: readError, refresh, supported, write, setPermission, reset, retryWrite } =
    useBrowserSitePermissions(origin, isVisible);
  // write.status 为 pending 时置 busy，所有控件同时禁用。
  // busy 时禁用 reset，避免重建过程中再发重置请求。
  // busy 时禁用 Select，防止写入未完成又改下一项。
  // busy 时禁用重试按钮，重试请求不会叠加。
  // notice 区分 resetDone 与 saved，两种成功文案不同。
  const busy = write.status === "pending";
  // 只有 write.status 为 succeeded 才提示，失败走告警分支。
  // resetDone 文案单独一条，重置与保存不共用措辞。
  // saved 文案单独一条，用户能确认保存的是当前项。
  // 失败不进 notice，改由 error 分支渲染警告色。
  const notice = write.status === "succeeded" ? (write.operation.kind === "reset" ? "resetDone" : "saved") : null;
  return (
    <div
      className="h-full min-h-0 overflow-auto bg-background text-foreground"
      data-testid="browser-site-permissions"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        <h1 className="break-all text-ui-xl font-medium">{origin}</h1>
        {!supported ? (
          <p>{t("unsupported")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-ui-lg font-medium">{t("settings")}</h2>
              <Button
                variant="outline"
                disabled={busy || !states}
                data-testid="browser-permission-reset"
                onClick={() => void reset()}
              >
                {t("reset")}
              </Button>
            </div>
            <div className="flex flex-col gap-4" aria-busy={busy}>
              {BROWSER_PERMISSION_CAPABILITIES.map((capability) => {
                const persisted = states?.[capability.key];
                const setting = persisted === "allow" ? "allow" : persisted === "deny" ? "block" : "ask";
                return (
                  <div
                    key={capability.key}
                    className="flex flex-wrap items-center justify-between gap-3"
                    data-permission-key={capability.key}
                  >
                    {/* 窄栏给名称保留可读宽度，让控件换行，避免下拉框把英文挤成逐字断行。 */}
                    <div className="flex min-w-40 max-w-full flex-1 items-center gap-3">
                      <BrowserPermissionIcon capability={capability.iconKey} />
                      <div className="min-w-0 text-ui-base break-words">
                        {intl.formatMessage({ id: capability.labelId })}
                      </div>
                    </div>
                    <Select
                      value={setting}
                      disabled={busy}
                      onValueChange={(next) =>
                        void setPermission(capability.key, next as "ask" | "allow" | "block")
                      }
                    >
                      <SelectTrigger
                        className="w-44 max-w-full shrink-0"
                        aria-label={intl.formatMessage({ id: capability.labelId })}
                        data-testid={`site-permission-setting-${encodeURIComponent(capability.key)}`}
                        data-permission-setting={setting}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          [
                            ["ask", "stateAsk"],
                            ["allow", "stateAllow"],
                            ["block", "stateDeny"],
                          ] as const
                        ).map(([option, labelId]) => (
                          <SelectItem
                            key={option}
                            value={option}
                            data-testid={`site-permission-option-${option}`}
                          >
                            {t(labelId)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
            {notice && (
              <p
                role="status"
                className="text-ui-sm text-foreground-subtle"
                data-testid={
                  notice === "resetDone" ? "browser-permission-reset-done" : "browser-permission-saved"
                }
              >
                {t(notice)}
              </p>
            )}
            {write.status === "failed" && (
              <div role="alert" className="text-ui-sm text-destructive">
                {t(write.operation.kind === "reset" ? "resetError" : "saveError")}{" "}
                <Button variant="ghost" onClick={() => void retryWrite()}>
                  {t("retry")}
                </Button>
              </div>
            )}
            {readError && (
              <div role="alert" className="text-ui-sm text-destructive">
                {t("readError")}{" "}
                <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
                  {t("retry")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
