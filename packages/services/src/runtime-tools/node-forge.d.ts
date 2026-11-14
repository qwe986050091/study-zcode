// node-forge 类型补丁：node-forge 1.4.0 不带 .d.ts，也未安装 @types，这里手写最小声明。
// 边界：只覆盖 appCaCert.ts 用到的 pki（rsa / createCertificate / 证书与私钥 PEM）与 md.sha256；
// 其余 API 一律不声明，避免声明与运行时不一致后被误用。
// 不变量（INV）：本文件的签名是「对运行时形状的承诺」。字段名或参数名写错不会产生类型错误，
// 只会在运行期静默变成 undefined 或抛 TypeError；因此每次升级 node-forge 都必须复核本文件。
// node-forge 1.4.0 没有自带类型，也未安装 @types/node-forge。
// 这里只声明 appCaCert.ts 用到的最小 pki/md 子集，避免引入额外依赖。
// 模块名必须与 import / require 的裸说明符完全一致，否则类型不会挂到 import "node-forge" 上；
// 它同时限定模块解析范围，写成路径形式会让下游引用失配。
declare module "node-forge" {
  interface ForgeKey {
    n?: unknown;
  }
  interface ForgeKeyPair {
    publicKey: ForgeKey;
    privateKey: ForgeKey;
  }
  interface ForgeCertAttr {
    name?: string;
    shortName?: string;
    type?: string;
    value?: string;
  }
  interface ForgeCertExtension {
    name: string;
    cA?: boolean;
    critical?: boolean;
    keyCertSign?: boolean;
    cRLSign?: boolean;
    digitalSignature?: boolean;
    keyEncipherment?: boolean;
    serverAuth?: boolean;
    clientAuth?: boolean;
  }
  interface ForgeMessageDigest {
    update(msg: string): ForgeMessageDigest;
  }
// 证书对象只声明本仓库实际调用的方法；sign() 是原地写入签名的副作用入口，
// 返回值被忽略，因此声明为 void 而不是链式返回，防止调用方误以为可以继续串接。
  interface ForgeCertificate {
    publicKey: ForgeKey;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: ForgeCertAttr[]): void;
    setIssuer(attrs: ForgeCertAttr[]): void;
    setExtensions(exts: ForgeCertExtension[]): void;
    sign(key: ForgeKey, md?: ForgeMessageDigest): void;
  }
// pki.createCertificate() 返回可变对象，调用顺序固定为 setSubject → setIssuer →
// setExtensions → sign；顺序颠倒会得到无扩展或未签名的证书，运行期不会报错。
  interface ForgeStatic {
    pki: {
      rsa: { generateKeyPair(bits: number): ForgeKeyPair };
      createCertificate(): ForgeCertificate;
      certificateToPem(cert: ForgeCertificate): string;
      privateKeyToPem(key: ForgeKey): string;
    };
    md: { sha256: { create(): ForgeMessageDigest } };
  }
// export = 与 CommonJS 的 module.exports 一一对应，保证 esModuleInterop 下的默认导入
// 与 require() 拿到同一个对象；改成 export default 会破坏其中一种导入方式。
  const forge: ForgeStatic;
  export = forge;
}
