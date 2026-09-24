# 发布契约

仓库固定为 `zkywalker/agent-inbox-claude-bridge`。稳定标签 `vMAJOR.MINOR.PATCH` 触发三平台构建，所有平台均须通过类型检查、离线测试、编译、生产依赖安装和打包后 CLI 配置验收。

Actions 均固定完整提交 SHA。PR/普通 CI 无签名权限；build job 只有用于产物来源证明的 OIDC 权限。签名发布 job 进入受保护 `release` environment，由 Owner 审批；标签限制为 `v*`，不绕过审批。签名私钥只存放于 environment secret `BRIDGE_MANIFEST_SIGNING_KEY`，与 Codex 完全独立。

## 产物

- `claude-bridge-VERSION-linux-x64.tar.gz`
- `claude-bridge-VERSION-darwin-arm64.tar.gz`
- `claude-bridge-VERSION-darwin-x64.tar.gz`
- 每包 SHA-256、合并 `checksums.txt`、`manifest.json`、`manifest.sig.json`
- GitHub Actions build provenance（包和清单）

清单包含固定仓库、版本、三平台文件名/大小/SHA-256、签发时间和七天有效期。签名算法 Ed25519，key ID 是公钥 SPKI DER 的 SHA-256，签名域为 `agent-inbox-claude-bridge-manifest:v1\n`。它有意区别于 Codex 签名域，旧 Codex 验证器不能接受这个产品。

Owner 应通过独立可信渠道核对并预先分发 `release-public-keys.json`，不能在每次安装时信任与待安装包一起下载的新公钥。GitHub Release 的 provenance 是额外证据，不替代固定公钥验签。

工作流先创建 draft 上传完整签名产物，再发布；不使用 `--clobber` 或修改已有标签。失败重跑如果遇到已有 draft，需 Owner 审核已有产物与签名后处理，不自动删除或替换。

## 安装前验收

用可信源码中的验证脚本校验下载的三个包和签名清单：

```sh
node scripts/verify-release.mjs /absolute/downloads /absolute/downloads /absolute/trusted-public-keys.json 0.1.0
```

验证成功之前不要执行或解包待安装产物。过期、错误产品、错误版本、非预置信任密钥、缺少任一平台、摘要/长度不一致时均拒绝。需要更新签名时发布新版本，不修改原清单。

源码中 `adapters/codex` 是抽取的共享通信/存储/项目/文件基础设施，不包含 Codex 原生执行器或 Codex 自升级器。导出来源和每个源文件摘要见 `SOURCE.json`。

Node、官方 Claude Code 安装及其许可由执行主机管理员管理。发布包通过 `npm ci --omit=dev --omit=optional --ignore-scripts --no-bin-links` 打包锁定的 JS 依赖，不捆绑 Node 或原生 Claude 二进制。
