# codex-reasonix-bridge

Codex → Reasonix Studio 的持久协作桥，由 codex-dsh-bridge 0.2.0 派生。
Codex 规划与验收；Reasonix 执行；桥保存任务、会话、审批、结果及交付文件指纹。
默认 `serve` 连接共享后台：多个 Codex 聊天共用一个状态所有者，避免 MCP 启动时争抢写锁。
`completed` 仅表示执行轮次结束。

默认连接安装包里的 `reasonix-studio-host`，通过受认证的 loopback HTTP + SSE 工作。
桥启动自己管理的后端实例，沿用 Studio 的 Reasonix home、登录及模型配置；不会接管 GUI 的活跃聊天。
安装包无需包含 `reasonix` CLI。Node.js ≥24，零外部依赖。

```sh
node scripts/configure-bridge.mjs --desktop-root '/opt/Reasonix Studio'
node src/cli.mjs preflight
node scripts/probe.mjs
node src/cli.mjs serve
```

配置脚本可直接读取本地 Reasonix 提供商与模型菜单；`--list-providers` 只读列出目录。
此辅助读取使用 Python ≥3.11；不可用时退回缓存或手工输入，桥运行时仍只需 Node.js。

默认 provider/model/reasoningEffort 为 null，沿用 Studio 设置。工具审批默认 ask，使用
`reasonix_approvals` / `reasonix_approve`；不依赖手工工具表。原生提问与文本澄清通过 `reasonix_reply` 续跑。
Studio 的 effort HTTP 接口会改写全局配置，桥仅核对或保持当前档位；改档请在 Studio 内进行。

支持任务幂等、工作区排队、会话复用与恢复、未知结果人工裁定、显式重试、取消和有界退出。
默认 `studioRuntimeReuse=false`：每次后续提示从同一持久会话重建 runtime，兼容不支持
`previous_response_id` 的模型服务。确认服务支持链式响应后可设置为 true。失败请求不会自动重放。
状态目录与原 DSH 桥分开；不要把 DSH 的状态或配置直接复制过来。
可选 `backend=acp` 使用独立 Reasonix CLI，但尚未完成真实 CLI 验收。

```sh
npm run check
npm test
npm run test:unit
npm run smoke
```

以上检查离线且不调用模型。`probe` 启动真实 Studio 并创建临时工作区会话，不发模型提示。
真实模型验收需显式运行 `node scripts/smoke.mjs --allow-model --config bridge.config.json`。

- [使用与 MCP 接入](docs/usage.md)
- [架构与限制](docs/architecture.md)
- [兼容性与验证记录](docs/compatibility.md)
- [来源与版权](NOTICE.md)
- [GPL-3.0-only](LICENSE)

克隆仓库后运行配置脚本，再按使用说明注册 Codex MCP。
本机配置、会话状态、原始验收报告和配置备份不纳入公开源码。
