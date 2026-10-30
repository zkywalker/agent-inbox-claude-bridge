# Agent Inbox Claude Bridge

独立 Claude Code 适配器：将 Agent Inbox 的消息、项目、审批、文件和运行管理接入 Claude Agent SDK / 原生 Claude Code。网关不承担工具执行或模型推理。

## 旧签名发行通道已退休

此仓库的旧签名发行通道不再用于新安装或更新。`release-public-keys.json` 有意为空数组，撤销公钥 SPKI SHA-256 指纹为 `540115b70e46cabcf4d68b052ca4fb865b4b3f4f7f67e082a14fe77f6c39c073` 的旧发行密钥。

保存过旧根文件的管理员应通过原独立可信管理渠道核对并同步空数组 `[]`。使用空根运行 `scripts/verify-release.mjs` 会拒绝旧发行；不要从历史标签或待安装归档恢复旧公钥，也不要填入其他产品的公钥。仓库更新不会自动更改历史克隆或已下载副本中的信任配置。

此撤销针对新制品的接纳权限，不删除既有程序、状态或运行凭据。下文及发布文档保留历史运行和格式说明，不代表旧签名发行仍可启用。

## 运行前提

- Node.js 22.13 或更新版本；当前发布平台为 Linux x64、macOS ARM64、macOS x64。
- 在执行主机通过官方方式安装 Claude Code，并在私有配置中指定 `claudeBinary` 的绝对路径。发布包不重新分发 Claude 原生二进制。
- 支持 `kind: claude`、`/coding` 和 Claude runtime 扩展的 Agent Inbox 网关，独立 connector / management token。
- 可用的 Messages 上游，或本机官方原生认证。模型名和 token 必须对应真实上游能力。

## 源码运行

```sh
npm ci --ignore-scripts --omit=optional
npm run typecheck
npm test
npm run build
npm run validate -- /absolute/private/claude.json
npm start -- /absolute/private/claude.json
```

以下为示意配置；不要提交真实配置或凭证：

```json
{
  "gatewayUrl": "https://inbox.example",
  "token": "REPLACE_WITH_CONNECTOR_TOKEN",
  "managementToken": "REPLACE_WITH_MANAGEMENT_TOKEN",
  "stateDir": "/absolute/private/claude-state",
  "projectPath": "/absolute/projects/main",
  "claudeBinary": "/absolute/bin/claude",
  "codexProvider": {},
  "model": "claude-sonnet-4-6"
}
```

配置权限 0600，stateDir 权限 0700，不能与 Codex 或其他 Claude 联系人共用。生产须配置 Cloudflare Access service credentials。`codexProvider` 显式只读复用本机 Codex 的 API 提供商 base URL 和 API key；不会读取或复用 Codex/ChatGPT OAuth 订阅凭证。若不需要这个入口，可改用显式 `provider` 或主机原生认证。

原生 `anthropic_messages` 模式直接连接上游，不启动本地转换代理；额外兼容路径只有显式选择 `responses` / `chat_completions` 时才使用。不要同时配置 `codexProvider` 与 `provider`，不要自动切换模型来掩盖失败。

支持原生会话续聊、流式消息、停止、单次工具审批、结构化提问、项目绑定、受管 Skills/MCP、模型与话题默认配置、在线文件。权限模式不是操作系统沙箱。原生 CLI 更新需要主机显式 `allowNativeUpdate`；它与 bridge 自升级不是同一件事。

## 发布与边界

见 [RELEASE.md](RELEASE.md)、[HOST-DEPLOYMENT.md](HOST-DEPLOYMENT.md) 和 [SECURITY.md](SECURITY.md)。这是独立的 Claude 发布身份与签名域，不能用 Codex bridge 的安装器、公钥或 Canary 更新入口处理。

首版建立签名发布和手工安装路径，**不宣称已有 Claude Supervisor 自动切换/回滚或网关一键升级**。生产网关部署和常驻服务启用须单独验收；CI 中的 CLI fixture 验证不是 Anthropic 登录、真实模型或远端部署验收。
