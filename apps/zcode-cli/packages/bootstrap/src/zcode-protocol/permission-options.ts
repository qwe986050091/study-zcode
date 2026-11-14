// 权限选项门面：把 session 权限策略投影成协议 option 形状，并统一"用户拒绝"的文案。
// 具体构造/迁移逻辑在 ../permission-options.js，这里只 re-export，保持协议层导入面稳定。
export {
  buildProtocolPermissionOptions,
  buildPermissionDeniedContent,
  buildSessionPermissionUpdates,
  PERMISSION_DENIED_BY_USER_CONTENT,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  toLegacyPermissionOptionsPolicy,
} from "../permission-options.js";
