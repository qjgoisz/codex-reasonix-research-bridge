# 兼容性与验证记录

验证日期：2026-10-07。本机为 Linux x64、Node.js 24.21.0、Reasonix Studio 2.29.0。
默认连接 `/opt/Reasonix Studio/resources/bin/reasonix-studio-host`，沿用验收环境的已配置模型。

## 实测范围

| 检查 | 结果与范围 |
| --- | --- |
| 离线回归 | 188 项通过；涵盖任务幂等、持久化、队列、审批、取消、澄清、未知结果与 MCP |
| 单元测试 | 59 项通过；包含 Studio HTTP/SSE 适配与恢复 runtime 后路由核对 |
| 语法与假后端 smoke | 通过；不调用模型 |
| 真实 Studio 生命周期 | 握手、鉴权、模型目录、新建、列出桥持有会话、关闭通过 |
| 真实持久恢复 | 同一 sessionPath 在独立后端中恢复、关闭、再次恢复通过；无模型调用 |
| 真实文件任务 | 返回结果、工具一次审批、energy.json 产物及 SHA-256 核对通过；输入保持原样 |
| 真实文本任务 | 初始返回 BRIDGE_OK；恢复同一会话后的独立新提示返回 RESUME_OK |
| 活跃 runtime 连续提示 | 初始测试第二轮失败：模型服务返回 previous_response_id 不支持的 HTTP 501 |
| 兼容处理 | 默认每次后续提示恢复同一持久会话，重新创建 runtime；离线验证提交次数与路由保持，真实恢复后新提示通过 |
| 原 DSH 桥 | 委派测试夹具、再委派文档，复用相同会话；澄清回复后完成 |

真实完整 smoke **没有全部通过**：第一轮文件任务成功，第二轮未知，后续场景未执行。保留失败记录；未自动重放。
运行兼容修复后的完整多轮模型 smoke 尚未重新验收。恢复新提示的真实验收与离线多轮测试分别验证了恢复链路和默认重建行为。
部分真实退出测试需要有界 SIGKILL，确认退出并保留这一事实；其他生命周期测试正常 EOF 退出。
文件任务中的模型 prose 有算术表述错误（将 7.0 描述为 15/2），因此只验收输入、产物数值与桥协议，未采信全部模型结论。

默认 `studioRuntimeReuse=false`；支持响应链的服务可设置 true。该选项不会自动重试失败轮次，也不会修改 Reasonix 的全局模型、档位或服务凭据。

## DSH 协作测试

DSH 编写了 `test/fake-studio.mjs` 初稿和 `docs/usage.md` 初稿，主控随后审查、修正并测试。
两次委派实际复用同一 DSH 会话。文档任务最终回复引用了澄清标记，原桥误判为 `needs_clarification`；显式回复后完成。
新 Reasonix 桥已修正解析：仅代码围栏外行首标记触发澄清，正文引用与代码例子有回归覆盖。原 DSH 桥源码未修改。

## 尚未实测

Windows/macOS 原生安装、独立 CLI ACP、GUI 活跃聊天共享均未验证。
Studio 原生 ask/取消的真实模型交互仅做离线协议测试；不能将这些测试描述成真实端到端验收。
空会话没有持久 transcript，不能据空会话 probe 声称恢复通过。

## 证据与上游依据

此文保留验收摘要；含本机目录、会话标识和模型服务信息的原始报告不随公开源码发布。
复现时可运行仓库内的检查脚本，并把报告保存到忽略版本控制的 `.verification/`。

配置目录读取也经过本机只读检查与离线测试：本地目录优先、提供商对应模型、home 路径选择、缓存回退、嵌套 TOML、失败诊断脱敏及保存确认。
读取辅助功能使用 Python ≥3.11 标准库，不启动 Studio 或请求模型。

Studio HTTP 是当前源码中的内部前端接口，并非公开稳定 SDK。升级后先运行 probe，再在隔离工作区验收。
适配依据官方 [studio 分支 README](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/README.md)、
[host 入口](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/cmd/reasonix-studio-host/main.go)、
[HTTP 路由](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/internal/frontend/serve/routes.go) 与
[事件定义](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/internal/eventwire/wire.go)。
版权与参考桥来源见 [NOTICE](../NOTICE.md)。
