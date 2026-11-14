// 远程项目缓存的 zod schema：这里是 host 与客户端共享的唯一校验口径。
// 所有对象一律 .strict()：多余字段直接拒绝，避免旧客户端把未知字段写进缓存后被新版本误读。
// 路径与凭据键统一走 text（trim 后非空）：空串在持久层等同于未设置，会掩盖配置错误。
// 本文件只有 schema 与派生类型，不包含任何 IO，改动不会影响运行时行为。
import { z } from "zod";
import { REMOTE_ASSET_INSTALL_MODES } from "@zcode/shared";

// 复用型基础串：trim 后必须非空；所有用户可见的标识（host、container、path）都基于它。
// 单独导出是为了让上层与这里使用同一份校验，避免两处规则漂移。
export const text = z.string().trim().min(1);
// 目标按 kind 判别为四种连接方式；discriminatedUnion 保证 kind 与字段组合一一对应。
// ssh 分支允许三种认证方式并存（密码/私钥/ssh config 别名），由上层决定优先级。
// docker/server 分支保持最小字段集，新增字段必须先加到这里，否则会被 .strict() 拒绝。
export const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
// port 只接受 1~65535 的整数；不传表示使用 ssh 默认端口，而不是 0。
// assetInstallMode 复用共享枚举，禁止在本地再定义一套字符串字面量。
      kind: z.literal("ssh"),
      host: text,
      username: text,
      port: z.number().int().min(1).max(65535).optional(),
      sshConfigAlias: z.string().optional(),
      privateKeyPath: z.string().optional(),
      passwordCredentialKey: text.optional(),
      privateKeyPassphraseCredentialKey: text.optional(),
      assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
      resourcePackages: z
        .object({ selectedPackageIds: z.array(z.string()).optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("wsl"), distro: text.optional(), user: text.optional() }).strict(),
  z.object({ kind: z.literal("docker"), container: text }).strict(),
  z
    .object({
      kind: z.literal("server"),
      url: z.url(),
      name: text.optional(),
      workspacePath: text.optional(),
      serverId: text.optional(),
      tokenCredentialKey: text.optional(),
    })
    .strict(),
]);
// 单根目录：position 参与排序，isPrimary 用于标记主根；两者都在 cacheSchema 里再做跨条目约束。
// rootPath 不在此处做规范化，保留用户输入原文，规范化由上层在落盘前完成。
export const rootSchema = z
  .object({ rootPath: text, position: z.number().int().nonnegative(), isPrimary: z.boolean() })
  .strict();
export const cacheSchema = z
  .object({ projectId: text, name: text, roots: z.array(rootSchema) })
  .strict()
// 跨条目约束：同一 path 不可重复，且 roots 非空时必须有且仅有一个主根。
  .refine(
    ({ roots }) =>
      new Set(roots.map((root) => root.rootPath)).size === roots.length &&
      (roots.length === 0 || roots.filter((root) => root.isPrimary).length === 1),
    "remote-project.invalid-roots",
  );
