// Command Center 单一出口：把 TUI 提交的原始输入翻译成 slash 命令分派或普通对话提交。
// 处理链固定为 normalize -> parseSlashCommand -> 内置命令 IIFE 分发 -> 写历史 -> 返回响应。
// 所有失败都以 response 文本回传给输入循环，不向上抛出，避免单条命令异常终止整个 TUI。
// createCommandCenter 是无状态工厂：不缓存 app、不改模块级变量，重复建处理器互不影响。
// 边界：TTY 判定、进程退出码与 SIGINT 收敛都在上层宿主，本文件只返回结构化结果。
//
// INV-01 输入必须先经 normalizeTuiPromptInput 归一化，后续分支只读 text 与 attachments；守住位置：async (input, options) 首两步；改错故障：带前导空白或全角的斜杠未被识别，用户只收到 Unknown command
// INV-02 非 slash 文本在任何情况下都不进命令表，只走 submitPrompt；守住位置：!command 分支；改错故障：普通对话被误判成命令，正文被截断
// INV-03 登录闸门先于取 app，未登录时直接返回 loginRequired；守住位置：!command 分支的 isLoginRequired 判定；改错故障：未登录请求打到模型侧，用户看到鉴权错误而非登录引导
// INV-04 附件语义只存在于普通 prompt，slash 命令遇附件必须显式拒绝；守住位置：hasAttachments 分支；改错故障：图片被静默丢弃，用户误以为命令带图生效
// INV-05 unknown 命令先交给自定义命令处理，未命中才回落帮助文案；守住位置：command.type === "unknown" 分支；改错故障：项目级自定义命令被内置表遮蔽，用户无法调用
// INV-06 已知命令的全部认领逻辑收敛在唯一 IIFE 内，出口只有一处；守住位置：const result 的立即执行函数；改错故障：新增分支绕开统一收尾，历史与返回结构不一致
// INV-07 历史记录必须在结果产出之后执行且只执行一次；守住位置：IIFE 之后的 recordSlashCommandInHistory；改错故障：失败命令也进历史，或连按上箭头重复同一条
// INV-08 每个返回对象的 mode 都要现场调用 deps.getMode 取最新值；守住位置：全部 return 字面量；改错故障：/mode 切换后提示行仍显示旧模式
// INV-09 可选依赖缺失时必须以不可用文案降级，不得抛错；守住位置：deps.login、deps.loginBigmodel、deps.configureApiKey 的判空分支；改错故障：精简客户端点 /login 直接让输入循环崩掉
// INV-10 OAuth 的 authorize_url 必须在登录完成前回显给用户；守住位置：onAuthorizeUrl 回调；改错故障：用户拿不到授权链接，登录永久停在等待态
// INV-11 abortSignal 必须原样透传给登录实现；守住位置：deps.login 与 deps.loginBigmodel 的入参；改错故障：用户取消后后台继续轮询，残留监听与网络请求
// INV-12 /logout 带参数按用法错误处理，且发生在调用 deps.logout 之前；守住位置：command.args.length > 0 分支；改错故障：误触带参 logout 直接清凭证，用户被迫重新登录
// INV-13 /new 成功响应必须携带 sessionId 与 resetSessionProjection；守住位置：command.name === "new" 的返回对象；改错故障：TUI 继续渲染旧会话，新消息写进旧 transcript
// INV-14 裸 /resume 且客户端提供 listSessions 才弹选择器，带参调用保持直接恢复；守住位置：末尾 resume 选择器条件；改错故障：脚本化 /resume 指定 id 被换成交互选择，自动化挂起
// INV-15 IIFE 末段必须覆盖所有未特判命令；守住位置：resumeApp 兜底分支；改错故障：不带会话列表的宿主执行未知命令时拿到 undefined 崩溃
// INV-16 workflow-mode 关闭时 /workflow 必须本地拦截，不创建 app；守住位置：isWorkflowModeEnabled 判定；改错故障：字面量 /workflow 被当普通文本发给模型，产生幻觉输出
// INV-17 /init 与 /workflow 必须把原文交给 submitPrompt，由 bootstrap resolver 展开；守住位置：两处 app.submitPrompt 调用；改错故障：命令绕过 builtin resolver，与 --stdio 行为分叉
// INV-18 会话类命令的返回值必须经 attachCurrentSessionMetadata 补齐元数据；守住位置：compact、rewind、fork、skill 的返回；改错故障：TUI 丢失 sessionId 或 traceId，后续消息落错会话
// INV-19 isLoginRequired 探测异常按不要求登录处理；守住位置：isLoginRequired 的 catch 分支；改错故障：模型目录一次抖动就把已登录用户挡在登录页
// INV-20 parseForkTarget 把空参数与 latest 归一到 undefined；守住位置：parseForkTarget 尾部；改错故障：/fork latest 被当成 checkpointId，恢复时报找不到
import type { TuiSubmitPrompt } from "@zcode/tui";
import {
  formatAvailableCommandNames,
  listCustomCommandsForHelp,
} from "../command-center-custom.js";
import { formatNewSessionResult, formatResumeResult } from "./formatters.js";
import { handleCustomCommand } from "./handlers/custom.js";
import { handleDwfCommand } from "./handlers/dwf.js";
import { handleEffortCommand } from "./handlers/effort.js";
import { handleExpertCommand } from "./handlers/expert.js";
import { handleLocaleCommand } from "./handlers/locale.js";
import { handleMcpCommand } from "./handlers/mcp.js";
import { handleModeCommand } from "./handlers/mode.js";
import { handleModelCommand } from "./handlers/model.js";
import { handlePluginsCommand } from "./handlers/plugins.js";
import { handleSkillListCommand } from "./handlers/skill.js";
import { handleTargetCommand } from "./handlers/goal.js";
import { recordSlashCommandInHistory } from "./history.js";
import { attachCurrentSessionMetadata, normalizeTuiPromptInput } from "./metadata.js";
import { buildCheckpointSelection, buildSessionSelection } from "./selections.js";
import {
  buildManualSkillPrompt,
  formatSlashCommandHelp,
  listAvailableCommandNames,
  parseSlashCommand,
} from "./slash-commands.js";
import { isWorkflowModeEnabled, WORKFLOW_DISABLED_NOTICE } from "../workflow-mode.js";
import {
  buildLoginSelection,
  emitLoginAuthorizeMessage,
  formatLoginResult,
  formatProviderSetupResult,
  loginSetupResponse,
  parseApiKeyLoginArgs,
} from "./login-flow.js";
import { loginRequiredResponse } from "../tui-login-state.js";
import type { CommandCenterDeps } from "./types.js";

// 构造 TUI 的 slash 命令处理器（TuiSubmitPrompt）：解析输入 -> 命中内置/自定义命令 -> 返回提示结果。
// 非命令文本交给 app.submitPrompt 并补齐 session 元数据；登录态缺失时先返回 loginRequired，不触达 app。
// 副作用：读取 app facade、写输入历史、可能触发登录/模式切换/会话恢复；命令类失败以 response 文本
// 返回而非抛出，保证 TUI 输入循环不被单个命令异常打断。
export function createCommandCenter(deps: CommandCenterDeps): TuiSubmitPrompt {
  return async (input, options) => {
    // 归一化只做一次：后续所有分支读 promptInput.text 与 attachments，不再回看原始 input
    // 原始 input 可能是字符串或富对象，提前归一可避免每个分支重复做类型判断
    // attachments 在归一化后固定为数组语义，缺省按空数组处理（length ?? 0）
    // [失败路径] 归一化本身不校验内容，非法结构留给 parseSlashCommand 与下游各自兜底
    const promptInput = normalizeTuiPromptInput(input);
    const command = parseSlashCommand(promptInput.text);
    const hasAttachments = (promptInput.attachments?.length ?? 0) > 0;

    // 非 slash 文本不是错误，而是最常用路径：先过登录闸门，再原样转交 app
    // 登录判定放在取 app 之前，避免未登录时也触发会话初始化等重副作用
    // [权衡] 未登录不抛错而是返回 loginRequired 结果，让 TUI 自行决定弹登录页还是保留输入
    if (!command) {
      // 非 slash 文本：未登录先拦截并提示，登录后原样交给 app，普通对话与命令共用同一入口。
      if (await isLoginRequired(deps)) {
        return {
          loginRequired: true,
          mode: deps.getMode?.(),
          response: loginRequiredResponse(deps.getLocale?.()),
        };
      }
      const app = await deps.getApp();
      // 普通对话也补齐 session 元数据，保证与命令路径返回结构一致
      // 此处传原始 input 而非 promptInput.text，保留宿主可能依赖的富字段
      return attachCurrentSessionMetadata(await app.submitPrompt(input, options), deps, app);
    }

    // slash 命令没有附件语义，静默丢弃会让用户以为图片随命令生效
    // 因此选择显式失败并给出可操作的英文提示，代价是这一轮输入需要用户重发
    // [失败路径] 该分支在命令解析之后、任何 app 调用之前，确保不产生半截副作用
    if (hasAttachments) {
      // slash 命令没有附件语义；静默丢弃会误导用户，因此显式拒绝而非忽略附件。
      return {
        mode: deps.getMode?.(),
        response: "Image attachments are only supported for normal prompts.",
      };
    }

    // 未识别命令先给用户自定义命令一次认领机会，再决定是否报未知
    // 自定义命令可能来自项目配置，优先级高于内置帮助文案
    // [资源] 此处不创建 app，未知命令的代价只有一次自定义命令目录读取
    if (command.type === "unknown") {
      const customResult = await handleCustomCommand(command.rawName, command.args, deps, options);
      if (customResult) {
        await recordSlashCommandInHistory(deps, promptInput.text, command);
        return customResult;
      }
      // 帮助文案需要同时列出内置与自定义命令，重复读取是有意为之
      // 自定义目录可能随插件热更新变化，不复用缓存以免展示过期列表
      const customCommands = await listCustomCommandsForHelp(deps);
      return {
        mode: deps.getMode?.(),
        response: `Unknown command: /${command.rawName}. Available commands: ${formatAvailableCommandNames(listAvailableCommandNames(deps), customCommands)}.`,
      };
    }

    // [权衡] 用 IIFE 收拢分派：所有 return 都会汇合到同一处收尾，避免新增分支漏记历史
    // 每个 if 都是独立 return，不写 switch 是为了让类型收窄按命令名逐段生效
    // [失败路径] 任一分支抛出都会跳过后续历史记录，异常原样冒泡给 TUI 外层
    const result = await (async () => {
      // 用 IIFE 集中分发已知命令，便于在出口统一记录历史，任何分支都不会漏记。
      if (command.name === "help") {
        const customCommands = await listCustomCommandsForHelp(deps);
        return {
          mode: deps.getMode?.(),
          response: formatSlashCommandHelp(command.args, customCommands, deps),
        };
      }

      // /login 的分支顺序即帮助文案的优先级：无参、两种 Coding Plan、两种 API key、最后用法提示
      // 每种子形态都先检查对应依赖是否存在，再决定调用还是返回不可用文案
      // [权衡] 分支多但不合并：不同登录方式错误文案与返回字段不同，合并会让用户看不出缺什么
      if (command.name === "login") {
        // 无参登录不直接发起流程，而是返回登录面板选择项，让用户先选登录方式
        // loginRequired 取实时值，已有可用模型时面板不再渲染成必选登录
        if (command.args.length === 0) {
          return {
            loginRequired: await isLoginRequired(deps),
            mode: deps.getMode?.(),
            response: loginSetupResponse(deps.getLocale?.()),
            selection: buildLoginSelection(deps.getLocale?.()),
          };
        }
        // [资源] 登录实现内部持有 OAuth 轮询与网络连接，abortSignal 必须原样透传以便取消时释放
        // onAuthorizeUrl 在拿到链接的瞬间回显，先于登录结果返回，用户才能及时在浏览器授权
        // 回调里再次取 app 用于渲染消息，说明消息通道与登录流程的生命周期相互独立
        if (command.args === "zai-coding-plan") {
          if (!deps.login) {
            return {
              mode: deps.getMode?.(),
              response: "Z.AI Coding Plan login is not available in this client.",
            };
          }

          return {
            loginRequired: false,
            mode: deps.getMode?.(),
            response: formatLoginResult(
              await deps.login({
                abortSignal: options.abortSignal,
                onAuthorizeUrl: async (data) => {
                  await emitLoginAuthorizeMessage(
                    options,
                    data.authorize_url,
                    "Z.AI",
                    await deps.getApp(),
                  );
                },
              }),
            ),
          };
        }
        // BigModel 与 Z.AI 流程同构但结果格式化不同，单独分支避免格式化函数里再分支
        // [失败路径] 依赖缺失时只返回文案，不触碰登录实现，避免部分实现留下未关闭的轮询
        if (command.args === "bigmodel-coding-plan") {
          if (!deps.loginBigmodel) {
            return {
              mode: deps.getMode?.(),
              response: "BigModel Coding Plan login is not available in this client.",
            };
          }

          return {
            loginRequired: false,
            mode: deps.getMode?.(),
            response: formatProviderSetupResult(
              await deps.loginBigmodel({
                abortSignal: options.abortSignal,
                onAuthorizeUrl: async (data) => {
                  await emitLoginAuthorizeMessage(
                    options,
                    data.authorize_url,
                    "BigModel",
                    await deps.getApp(),
                  );
                },
              }),
            ),
          };
        }

        // 手工 API key 属于另一类认证：不走 OAuth，不需要授权链接与 abortSignal
        // 解析失败返回空值表示参数不是 API key 形态，交由最后的用法提示兜底
        // [失败路径] 只有 kind 没有 key 时先校验再提示用法，避免把空串写进凭证存储
        const apiKeyCommand = parseApiKeyLoginArgs(command.args);
        if (apiKeyCommand) {
          if (!deps.configureApiKey) {
            return {
              mode: deps.getMode?.(),
              response: "Manual API key setup is not available in this client.",
            };
          }
          if (!apiKeyCommand.apiKey) {
            return {
              loginRequired: await isLoginRequired(deps),
              mode: deps.getMode?.(),
              response: `Usage: /login ${apiKeyCommand.kind} <api-key>`,
            };
          }
          return {
            loginRequired: false,
            mode: deps.getMode?.(),
            response: formatProviderSetupResult(
              await deps.configureApiKey({
                apiKey: apiKeyCommand.apiKey,
                providerId: apiKeyCommand.providerId,
              }),
            ),
          };
        }

        return {
          mode: deps.getMode?.(),
          response:
            "Usage: /login [zai-coding-plan|bigmodel-coding-plan|zai-coding-plan-api-key <api-key>|bigmodel-coding-plan-api-key <api-key>]",
        };
      }

      // 登出是不可逆副作用，先做参数校验与依赖检查，两条都通过才执行
      // 带参视为误用而非忽略参数，防止用户以为可以按账号选择性登出
      // [失败路径] deps.logout 本身抛错不捕获，凭据清理失败必须让用户看见
      if (command.name === "logout") {
        if (command.args.length > 0) {
          return {
            mode: deps.getMode?.(),
            response: "Usage: /logout",
          };
        }
        if (!deps.logout) {
          return {
            mode: deps.getMode?.(),
            response: "Logout is not available in this client.",
          };
        }

        const result = await deps.logout();
        return {
          mode: deps.getMode?.(),
          response: `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}`,
        };
      }

      if (command.name === "compact") {
        const app = await deps.getApp();
        const prompt = command.args ? `/compact ${command.args}` : "/compact";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      // /init 是普通 prompt 命令：原样交给 submitPrompt，由 bootstrap resolver 决定展开内容
      // 如果在这里自己拼提示词，会与 app --stdio 路径产生两套语义
      // [权衡] 保留 command.args 透传，让用户附加的初始化说明继续生效
      if (command.name === "init") {
        const app = await deps.getApp();
        const prompt = command.args ? `/init ${command.args}` : "/init";
        // TUI 已知 slash command 若没有显式分支，会落到文件末尾的
        // resume 兜底。/init 是普通 prompt command，必须交给 app.submitPrompt
        // 进入 bootstrap resolver，才能和 app --stdio 复用同一套展开逻辑。
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      // workflow-mode 关闭时 builtin resolver 不展开该命令，原文会被当成普通文本发给模型
      // 因此在本地提前拦截，连 app 都不创建，避免一次无效会话初始化
      // [失败路径] 拦截返回固定提示，用户能立刻知道需要开启对应模式而不是等模型跑偏
      if (command.name === "workflow") {
        // disabled 下 builtin resolver 不展开 `/workflow`，照常提交会把原文当普通文本发给模型；
        // 在本地拦下，不建 app、不发模型（launch.md「The standalone CLI: `--workflow-mode`」）。
        if (!isWorkflowModeEnabled(deps.workflowMode)) {
          return { mode: deps.getMode?.(), response: WORKFLOW_DISABLED_NOTICE };
        }
        const app = await deps.getApp();
        const prompt = command.args ? `/workflow ${command.args}` : "/workflow";
        // 与 /init 同款：原文交给 app.submitPrompt，由 bootstrap 的 builtin resolver 展开成
        // 「先加载 dynamic-workflows 技能，再写脚本调 CreateWorkflow」的提示词。
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "expert") {
        return handleExpertCommand(command.args, deps, options);
      }

      if (command.name === "effort") {
        return handleEffortCommand(command.args, deps);
      }

      if (command.name === "dwf") {
        return handleDwfCommand(command.args, deps);
      }

      // 无参且有检查点能力时给选择器，参数存在则视为直接回退到指定检查点
      // 选择器只取最近 50 条，限制列表长度以免长会话下渲染开销失控
      if (command.name === "rewind") {
        const app = await deps.getApp();
        if (command.args.length === 0 && app.listCheckpoints) {
          return {
            mode: deps.getMode?.(),
            response: "Select a checkpoint to rewind.",
            selection: buildCheckpointSelection("rewind", await app.listCheckpoints({ limit: 50 })),
          };
        }
        const prompt = command.args ? `/rewind ${command.args}` : "/rewind";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "fork") {
        if (command.args.length === 0) {
          const app = await deps.getApp();
          if (app.listCheckpoints) {
            return {
              mode: deps.getMode?.(),
              response: "Select a checkpoint to fork.",
              selection: buildCheckpointSelection("fork", await app.listCheckpoints({ limit: 50 })),
            };
          }
        }
        // 先尝试解析目标，再决定走宿主分叉还是提示词路径，避免两条路径解析规则不一致
        // [失败路径] 解析只是归一化空值与 latest，不做 id 合法性校验，非法 id 由下层报错
        const targetCheckpointId = parseForkTarget(command.args);
        if (deps.forkApp) {
          const result = await deps.forkApp(targetCheckpointId);
          return {
            mode: deps.getMode?.(),
            response: result.response,
            traceId: undefined,
          };
        }

        const app = await deps.getApp();
        const prompt = targetCheckpointId ? `/fork ${targetCheckpointId}` : "/fork latest";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "mode") {
        return handleModeCommand(command.args, deps);
      }

      if (command.name === "locale") {
        return handleLocaleCommand(command.args, deps);
      }

      if (command.name === "mcp") {
        return handleMcpCommand(command.args, deps);
      }

      if (command.name === "plugins") {
        return handlePluginsCommand(command.args, deps);
      }

      if (command.name === "model") {
        return handleModelCommand(command.args, deps, promptInput.modelSelection);
      }

      if (command.name === "goal") {
        return handleTargetCommand(command.args, deps, options);
      }

      // /new 不改写任何已有会话，只切换投影：返回新 sessionId 并标记需要重绘
      // locale、model、theme 一并回传，宿主据此重建状态栏而无需再查一次
      // [权衡] 参数非空直接拒绝而不是忽略，避免用户以为可以给新会话命名或继承上下文
      if (command.name === "new") {
        if (command.args.length > 0) {
          return {
            mode: deps.getMode?.(),
            response: "Usage: /new",
          };
        }
        // 创建新会话是可选能力，精简客户端只读会话时不应看到失败堆栈
        // [失败路径] 依赖缺失在任何状态修改之前返回，保证旧会话引用仍然有效
        if (!deps.newApp) {
          return {
            mode: deps.getMode?.(),
            response: "Creating a new session is not available in this client.",
          };
        }

        const app = await deps.newApp();
        return {
          mode: deps.getMode?.(),
          locale: app.getLocale?.(),
          model: app.getModel?.(),
          theme: app.getTheme?.(),
          resetSessionProjection: true,
          response: formatNewSessionResult(app.sessionId),
          sessionId: app.sessionId,
          thoughtLevel: app.getThoughtLevel?.(),
          traceId: app.traceId,
        };
      }

      // 无技能名等价于列技能，有技能名则拼成手动调用提示词交给 submitPrompt
      // 技能正文由 resolver 侧注入，这里只负责把名字与任务描述拼成稳定的提示结构
      if (command.name === "skill") {
        if (!command.skillName) {
          return handleSkillListCommand(deps);
        }
        const app = await deps.getApp();
        return attachCurrentSessionMetadata(
          await app.submitPrompt(buildManualSkillPrompt(command.skillName, command.task), options),
          deps,
          app,
        );
      }

      if (
        // 选择器成立需要三个条件同时满足：命令名、零参数、客户端提供会话列表
        // rawName 也参与比较，避免别名调用被误判成裸 /resume 而弹出交互选择
        // [权衡] 带参时保持直接恢复，牺牲一点易用性换取脚本与自动化可用
        command.name === "resume" &&
        command.args.length === 0 &&
        command.rawName === "resume" &&
        deps.listSessions
      ) {
        // 仅「裸 /resume」且客户端提供会话列表时才弹选择器；带参数保持直接恢复，兼容脚本化调用。
        return {
          mode: deps.getMode?.(),
          response: "Select a session to resume.",
          selection: buildSessionSelection(await deps.listSessions()),
        };
      }

      // 兜底承担两类输入：带参 resume，以及未来新增但未特判的命令名
      // resumeApp 负责会话定位与恢复，命令参数为空表示继续当前会话
      // [失败路径] resumeApp 缺失不是可选依赖，宿主必须提供，否则这里会直接抛错
      // 兜底分支：带参 resume 与其余未特判语义都走 resumeApp；它同时承担「继续会话」语义。
      const app = await deps.resumeApp(command.args || undefined);
      const result = await app.resume({
        onEvent: options.onEvent,
      });
      const restoredMessages = app.loadSessionTranscript
        ? await app.loadSessionTranscript()
        : undefined;

      return {
        mode: deps.getMode?.(),
        locale: app.getLocale?.(),
        model: app.getModel?.(),
        theme: app.getTheme?.(),
        ...(restoredMessages !== undefined
          ? {
              resetSessionProjection: true,
              restoredMessages,
            }
          : {}),
        response: formatResumeResult(app.sessionId, result),
        thoughtLevel: app.getThoughtLevel?.(),
        traceId: result.traceId ?? app.traceId,
      };
    })();

    // [并发] 历史写入放在分派之后：同一输入循环内串行执行，不会与其他命令交错
    // 只有成功产出结果才记录，未知命令被自定义命令认领时也会走到这里
    // [失败路径] 写历史失败不影响已经得到的 result，用户至少能拿到本次响应
    await recordSlashCommandInHistory(deps, promptInput.text, command);
    return result;
  };
}

// 解析 /fork 目标：空参数与 "latest" 都表示「最新检查点」，统一返回 undefined；其余原样作为 checkpointId。
// 分叉目标解析刻意保持极简：只区分「最新」与显式 id 两种语义
// 把 latest 归一成 undefined，让下游只需判断有没有目标，减少一次字符串比较
function parseForkTarget(args: string): string | undefined {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "latest") return undefined;
  return trimmed;
}

// 登录态判定：客户端未提供 hasSelectableModels 时视为不要求登录；探测抛错也按不要求登录处理，
// 避免一次模型目录读取失败就把用户挡在登录页。返回 true 表示需要登录。
// 登录判定被抽成函数，是因为普通对话与登录面板两处都要用同一口径
// [权衡] 探测失败按不需登录处理：宁可让请求撞一次鉴权错误，也不误锁用户
async function isLoginRequired(deps: CommandCenterDeps): Promise<boolean> {
  if (!deps.hasSelectableModels) return false;
  try {
    return !(await deps.hasSelectableModels());
  // 捕获范围只包住一次模型目录探测，不掩盖调用方自身逻辑错误
  // [失败路径] 这里吞掉异常属于有意兜底，错误细节丢失换取入口永远可用
  } catch {
    return false;
  }
}
