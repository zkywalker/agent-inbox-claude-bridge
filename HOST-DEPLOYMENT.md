# 主机安装与恢复

先完成 RELEASE.md 的独立公钥验签，检查归档顶层只能是 `claude-bridge-VERSION-PLATFORM/`；在新的、非特权、空版本目录解包，不覆盖正在运行的版本。用该目录的固定入口启动：

```sh
node /absolute/releases/claude-bridge-VERSION-PLATFORM/dist/adapters/claude/main.js --validate /absolute/private/claude.json
node /absolute/releases/claude-bridge-VERSION-PLATFORM/dist/adapters/claude/main.js /absolute/private/claude.json
```

先前台检查 profile、项目、管理认证、首条消息、审批、停止、文件、同一 session 续聊；再用主机现有 launchd/systemd 托管上述固定命令。不要让服务启动脚本动态获取 latest 或自动拉取源码。私有配置/状态/凭证不放进版本目录，不以 root 执行模型工具。

`SIGINT` / `SIGTERM` 请求安全停止；主机管理器应留出退出时间，确认原生子进程全部结束后再启动另一版本。异常退出留下的 state lock 必须人工确认没有活进程后再处理，不能启动时自动删除。状态数据库升级/降级兼容性需逐版本评审。

第一版不提供自动更新 Supervisor，也不接入 Codex 的签名更新协调器。手工更新需要停机、备份私有 stateDir、保留旧版本和原生配置、验证新包；失败后先确认没有残余进程，再按已验证的数据库兼容策略恢复。不能以重新指向旧路径就宣称数据库已回滚。

## 接入与原生权限

- 网关须已部署 Claude kind、`/coding`、对应 runtime report/request schema，否则不能用本包冒充 Codex 绕过严格校验。
- `claudeBinary` 必须为官方安装的绝对路径；`--version` 需能确认 Claude Code。
- 配置 `codexProvider` 只支持选定 API provider 的常规 TOML 字符串字段；配置异常或 env_key 缺失时拒绝启动，改用显式 provider。
- API 直连模式由 Claude 子进程持有认证 token；主机及工具执行必须可信。与原生订阅登录模式分开，避免混用认证或费用归属。
- 本地 CLI fixture 只证明发布包可启动和读取配置，不等于真实推理或跨平台主机验收。
