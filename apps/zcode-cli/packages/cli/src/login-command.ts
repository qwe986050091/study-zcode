// `zcode login` / `zcode logout` 子命令实现：负责参数校验、`.env` 加载、浏览器授权引导与结果输出。
// 真正的凭据落盘由 @zcode/bootstrap 负责，本层只做编排与用户可见呈现。
import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

// 执行登录命令。
// 输入：args[0] 为 provider（缺省 zai）；noBrowser 表示只打印授权链接不拉起浏览器。
// 输出：进程退出码 —— 0 成功，1 参数/环境/登录失败。
// 副作用：写配置、写凭据文件（由 bootstrap 完成）；向 stdout/stderr 输出；可能拉起系统浏览器。
// 失败语义：异常统一在入口转换为 `Error: ...` 并返回 1；--verbose 时额外输出调用栈。
// 输出口径：--json 时只向 stdout 写一份结构化结果，人类可读文案全部走 stderr 以外路径。
export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  noBrowser: boolean,
  args: readonly string[] = [],
): Promise<number> {
  try {
    const providerId = args[0] ?? "zai";
    // provider 只允许白名单两个值且不接受多余参数，避免把任意字符串透传给凭据写入流程。
    if (args.length > 1 || (providerId !== "zai" && providerId !== "bigmodel")) {
      throw new Error("Usage: zcode login [zai|bigmodel] [--no-browser]");
    }
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    // `.env` 解析失败说明用户环境配置坏了，此时继续登录会得到难以理解的错误，直接终止更清晰。
    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
    const result = await login({
      env,
      noBrowser,
      providerId,
      // 授权链接可能在校验完成前就需要展示（如无浏览器场景），因此以回调方式即时输出。
      onAuthorizeUrl: (data) => {
        writeAuthorizeUrl(ctx, options, data.authorize_url, noBrowser, providerId);
      },
      onBrowserOpen: (browser) => {
        // 浏览器打开失败不致命：授权链接已给出，用户可手动复制；--json 下不污染结构化输出。
        if (!options.json && !browser.opened) {
          ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
        }
      },
    });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "ready",
          provider: result.providerId,
          user: {
            user_id: result.user.user_id,
            ...(result.user.email ? { email: result.user.email } : {}),
            ...(result.user.name ? { name: result.user.name } : {}),
            ...(result.user.avatar ? { avatar: result.user.avatar } : {}),
          },
          model: result.model,
          credentialsPath: result.credentialsPath,
          configPath: result.configPath,
          browserOpened: result.browser?.opened ?? false,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Login successful${formatUserLabel(result.user)}.`,
        `Model: ${result.model}`,
        `Credentials: ${result.credentialsPath}`,
        `Model selection: ${result.configPath}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

// 执行登出命令：清空 Coding Plan 账户凭据。
// 输入：无额外参数；options.json 决定输出形态。
// 输出：0 成功，1 失败（含 `.env` 加载失败与登出异常）。
// 副作用：删除/改写本地凭据文件（由 bootstrap 负责），并向 stdout/stderr 输出结果。
// 降级语义：未登录时登出仍视为成功，result.credentialsPath 保持为所述的凭据位置。
export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          provider: "zai",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

// 输出授权链接与相应指引。
// 输入：authorizeUrl 为 OAuth 授权页；noBrowser 决定文案形态；providerId 只影响品牌名。
// 输出：无返回值，直接写流。
// 输出口径：--json 下写 stderr（避免与 JSON 结果混在同一行），否则写 stdout。
function writeAuthorizeUrl(
  ctx: RunContext,
  options: GlobalOptions,
  authorizeUrl: string,
  noBrowser: boolean,
  providerId: "zai" | "bigmodel",
): void {
  const target = options.json ? ctx.stderr : ctx.stdout;
  if (noBrowser) {
    target.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
    return;
  }

  target.write(
    `Opening browser for ${providerId === "bigmodel" ? "BigModel" : "Z.AI"} authorization.\nFallback URL:\n${authorizeUrl}\n`,
  );
}

// 生成 "as <身份>" 后缀；优先级 name > email > user_id，三者都缺失时返回空串。
function formatUserLabel(user: { email?: string; name?: string; user_id: string }): string {
  const label = user.name || user.email || user.user_id;
  return label ? ` as ${label}` : "";
}
