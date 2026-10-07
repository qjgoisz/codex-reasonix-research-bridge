# Codex → Reasonix Studio 桥：使用说明

本桥通过 MCP 将 Codex 的任务交给已安装的 Reasonix Studio。先配置桥，再注册 MCP；验证范围见 [兼容性记录](compatibility.md)。

## 1. 这是什么

- 用途：让 Codex 通过 MCP 把**一般任务**委派给 Reasonix Studio 执行。桥是「MCP ⇄ Studio HTTP/SSE」的适配层，不声明 Studio 讲 ACP。
- 桥只做一般任务咨询/委派，**不递归委派**（不会把委派出去的子任务再展开成新的委派链）。
- 默认后端 `backend=studio`：桥启动**随安装包提供的自有后端** `reasonix-studio-host`，而不是独立的 ACP CLI。
- 前端协议：HTTP，带 `Cookie: reasonix_token=<token>` 与 `Origin` 头，事件流为 SSE（`text/event-stream`）。

## 2. 运行前提与隔离性

- 需要 Node.js ≥ 24；仓库运行时**零外部依赖**。
- 需要一个 Reasonix Studio 安装目录；桥代码**不复制、不解析模型凭据**，登录与凭据始终由 Reasonix 管理。
- **相同 Reasonix home（`reasonixHome`）会沿用该 home 的登录与模型配置**；`reasonixHome=null` 时沿用环境变量与平台默认。
- 桥只操作**自己创建的会话**，不会接管 GUI 正在使用的会话：会话查找失败时报「找不到此桥拥有的会话」，新任务通过新建 runtime/session 建立。

## 3. 路由与默认值语义

- `provider` 与 `model` **必须同时指定或同时为 `null`**；两者同时为 `null` 时沿用 Studio 当前默认。
- `model` 只填**模型 id 本身**，例如 `deepseek-flash`，不要写成 `provider/model`。
- `reasoningEffort=null`（或空串）表示**沿用现有档位 / provider 默认**，桥不主动改档。
- Studio 的 effort 端点会**写全局配置**，因此桥拒绝通过它实际更改档位：需要改档请在 Studio 内操作，桥只核对/沿用当前值。
- 模型目录可先用 `node src/cli.mjs models --refresh` 读取该 worker 实际公布的 provider/model 与推理档位；该命令只读取、不发送提示，因此不消耗模型调用。

## 4. 安装与配置

配置脚本优先只读 Reasonix 的 `config.toml`，先选择配置目录，再按提供商名称列出其模型。
菜单提供 `0`（provider/model 同时设为 null，沿用 Studio 默认）、编号选择和 `m` 手工输入。
如果新提供商有配置默认模型，模型菜单默认采用它；否则必须选择模型。
提供商名称来自配置的 `name`，模型名称来自该提供商的 `models`；服务地址与名称没有固定映射，请以目录输出为准。

```sh
# 只列出提供商、服务地址、模型与默认值，不保存
node scripts/configure-bridge.mjs --list-providers
# 从本地配置交互选择提供商与模型
node scripts/configure-bridge.mjs
# 指定另一个只读配置文件
node scripts/configure-bridge.mjs --reasonix-config /path/to/config.toml
```

配置路径遵循桥的 `reasonixHome`、环境变量 `REASONIX_HOME`、平台默认目录的顺序。
仅配置读取辅助功能使用 Python ≥3.11 的标准库 `tomllib`；桥运行时仍只有 Node.js 依赖。
读取失败、没有可选模型或 Python 不可用时，交互模式退回 `.bridge-state/models.json` 缓存，再退回手工填写。
读取白名单不输出密钥或 `api_key_env`，服务 URL 不输出用户名、密码、查询参数和 fragment。
菜单只证明配置声明，不能证明服务或凭据可用；不启动 host、不调用模型、不修改 Reasonix 配置。
`--reasonix-config` 仅控制菜单读取来源，实际 worker 使用的配置目录仍由 `reasonixHome` 决定。


1. 交互式配置桥（只改桥自己的 `bridge.config.json`，不启动 Reasonix、不调用模型）：
   ```
   node scripts/configure-bridge.mjs --desktop-root '/opt/Reasonix Studio'
   ```
   `--desktop-root` 指向 Studio 安装根目录（Linux 常为 `/opt/Reasonix Studio`；macOS 可为 `.app` 或 `Resources`；也接受 resources 目录）。该目录下应含 `resources/bin/reasonix-studio-host`（Windows 为 `.exe`）。
2. 仅预览校验、不写文件：`node scripts/configure-bridge.mjs --check`；`npm run configure` 则启动交互配置。
3. 检查后端入口是否就绪：
   ```
   node src/cli.mjs preflight
   ```
   输出 JSON 报告与解析后的路由，退出码 `0/1`。
4. 无模型协议探针（会启动真实后端）：
   ```
   npm run probe
   ```
   运行 `scripts/probe.mjs`。**probe 不调用模型，但会创建一个新的临时工作区会话**。Studio 不保存未执行过提示的空会话，空会话的恢复会标为未验证。
5. 其他检查脚本：`npm run check` → `node scripts/check.mjs`。

## 5. 以 MCP 方式接入 Codex（stdio）

桥通过 stdio 提供 MCP 服务：

```
node src/cli.mjs serve
```


Codex 配置示例（按实际克隆目录替换绝对路径后合并）：

```toml
# 将 /absolute/path/codex-reasonix-bridge 替换为实际克隆目录。
[mcp_servers.reasonix_bridge]
command = "node"
args = ["/absolute/path/codex-reasonix-bridge/src/cli.mjs", "serve", "--config", "/absolute/path/codex-reasonix-bridge/bridge.config.json", "--state-root", "/absolute/path/codex-reasonix-bridge/.bridge-state"]
startup_timeout_sec = 30
tool_timeout_sec = 150
```

## 6. MCP 工具

- `reasonix_delegate`：提交一般任务。
- `reasonix_status`、`reasonix_result`：查询状态、取回结果。
- `reasonix_reply`：回答 worker 的澄清问题。
- `reasonix_resolve`：对 `unknown` 做一次显式人工裁定并落盘。
- `reasonix_retry`：重放一个已裁定为 `retry` 的任务（每条记录只能重放一次）。
- `reasonix_cancel`：取消任务。
- `reasonix_approvals`、`reasonix_approve`：查看与处理工具审批。
- 当 `exposeModelChoice=true` 时，额外暴露 `reasonix_models`，并允许契约覆盖模型。

任务最少包含 id、objective、workspace、phase、plan、acceptance。支持在工具 schema 中查看完整参数。

## 7. 澄清、完成与恢复语义

- 澄清会统一进入任务状态 `needs_clarification`，来源有两种：
  - 代码围栏外正文行首的文本标记 `<<BRIDGE_CLARIFY>>`；引用与代码样例不触发；
  - Studio 原生 `ask` 事件。
  两者都会转换成桥既有的澄清流。
- 对 Studio 原生 `ask`，桥会**停止原生等待（`POST /cancel`）**，把问题抛成澄清；用户回答后，**下一次普通提示**继续执行，**不是**保留原 `askID` 去调 `/answer`。
- `completed` 只表示 worker 报告完成，**不等于验收通过**；需要人工判断结果是否满足要求。
- `unknown`（结果不可确认）**不会自动重放**；必须显式裁定/重放：`node src/cli.mjs resolve --id <任务id> --verdict <retry|keep_failed|abandoned|keep_completed> --reason <理由>`，再用 `node src/cli.mjs retry --id <任务id> --reason <理由>`。
- 默认 `studioRuntimeReuse=false`：后续提示从同一持久会话重建 runtime 并核对模型与档位，避免模型服务不支持 `previous_response_id` 的错误；支持响应链时可配置为 `true`。这是新提示前的准备，不会自动重放 `unknown` 轮次。
- 离线语义（见 §4）：`probe` 建会话但不调模型；`models` 只读目录。

## 8. 测试命令与离线声明

- `npm test` → `node test/run.mjs`。
- `npm run test:unit` → `node --test test/refactor.test.mjs test/config-platform-reasonix.test.mjs test/configure-bridge.test.mjs test/studio.test.mjs`。
- `npm run check`、`npm run probe`、`npm run smoke`。
- 以上 `test` / `test:unit` / `check` / `smoke` **均离线**，不调用模型。
- `smoke --allow-model`：只有在**显式指定配置文件**、且只运行**用户已授权模型**的验收场景下才使用；默认不要放开模型调用。
- 各项验证结果与限制见兼容性记录。

## 9. 未验证与边界

- 原生 Windows / macOS **未测试**；当前实现与验证以 Linux 为准。
- CLI ACP 后端（`backend=acp`）**未实测**。
- 本机 Studio 的测试结果见兼容性记录；没有对活跃 GUI 聊天共享作出承诺。

## 10. 未决问题与下一步

- 若你的 Studio 安装目录不是 `/opt/Reasonix Studio`，请据实替换 `--desktop-root`，并在 `preflight` 输出中确认解析到的入口。
- 原生 Windows/macOS 与独立 ACP 后端仍需各自验收。
- 需要澄清时，桥会返回 `needs_clarification`；请用 `reasonix_reply`（MCP）或 `node src/cli.mjs reply`（CLI）回答。
