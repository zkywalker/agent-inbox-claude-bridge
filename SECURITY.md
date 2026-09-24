# 安全边界

不要提交 token、私钥、主机私有配置、数据库、上传文件或日志。报告敏感问题时不要在公开 Issue 中附带凭证、真实项目内容或完整认证日志；先联系仓库所有者安排私密沟通。

通信 token 与 management token 分离，生产使用经过验证的 Cloudflare Access 和 scoped connector credentials。原生 session ID 与 Inbox conversation ID 分离。审批只针对明确的一次工具调用，不自动提升到整轮或全局授权。

Claude 发布使用独立 Ed25519 信任根与产品签名域。不得从 Codex 仓库获取替代产物，不跨产品接受公钥、清单或更新回执，不把 GitHub artifact 构建成功当作已签名 release。

原生 Claude 程序单独安装；本仓库不修改或重新分发该二进制，不提供绕过许可或订阅认证的实现。使用原生登录或第三方模型服务须遵守相应服务条款。
