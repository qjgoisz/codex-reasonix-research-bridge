# 架构

```text
Codex 聊天 → MCP stdio 客户端 → 本机 IPC → 共享 Bridge → StudioClient → 自有 Studio host
                         ↓               HTTP + SSE
                  独立 JSON 状态目录
```

`src/orchestration.mjs` 沿用参考桥的任务、会话与工作区队列；`src/studio-client.mjs` 将 Studio HTTP 表面转换为内部会话接口。
这不是 Studio 的 ACP 实现；worker 快照的 protocolVersion=null、agentInfo.name=reasonix-studio-http 可区分两者。
可选独立 CLI 走原 ACP 客户端。

## 多客户端与状态所有权

默认 `serve` 只转发协议，不持状态锁。它发现或启动独立后台；后台通过原有 `bridge.lock` 独占选举并持有 Store、Bridge、任务队列与审批状态。
并发启动的候选进程只有一个能取得锁，其余退出，客户端连接胜出的后台。
每条 IPC 连接有自己的 MCP 初始化状态和请求 ID 空间；客户端不自动重放任何已转发请求。
配置指纹不匹配时拒绝连接，不允许某个聊天偷偷改变其他聊天的模型或策略。

Linux/macOS 使用临时 0700 目录中的 0600 Unix socket，发现文件 `daemon.json` 为 0600，核对当前用户、状态锁 PID、协议与配置指纹。
Windows 使用带 256 位随机名称的本机命名管道，并核对状态锁 PID、协议与配置指纹；不依赖 Unix socket 或文件 chmod。Windows 的状态目录隐私由文件系统 ACL 保护，请放在当前用户的私有目录中。
不监听 TCP，不保存 Reasonix 握手 token。原有锁由后台持有，活动锁、损坏锁和残留锁均不由客户端删除。
旧版独占服务还在运行时，共享客户端明确报错，需让旧服务正常退出再切换。

客户端 EOF 或信号只断开自己；任务与审批由后台继续持有。所有客户端断开且没有执行中任务时，后台在约一秒空闲后有界回收自己的 worker、socket 和锁。
执行中任务保留到结算；待审批任务仍受原审批与提示超时约束，可通过重连处理。
后台异常退出时客户端收到连接错误，不会自动重发；重新连接后应核对任务状态。

`serve --private-stdio` 保留独占模式，用于隔离诊断与专用生命周期测试，必须使用独立状态目录。
三平台使用同一后台选举与转发逻辑。macOS 临时目录路径过长时使用 /tmp 下的私有短目录。
IPC 协议已升级为 2；升级时让全部旧客户端正常退出，再重新加载。真实 Windows/macOS Studio 尚未原生验收。
CLI 的一次性写操作不会绕过后台锁；后台活动时请通过 MCP 工具执行写操作。

## Studio 接口

启动安装包 `resources/bin/reasonix-studio-host`，从 stdout 接收 `{version:1,origin,token}`。
只接受 loopback HTTP；token 不入日志或状态，以 `reasonix_token` Cookie 传递，所有请求携带 Origin 且不跟随重定向。
stdin 作为父进程租约；EOF/信号退出时只回收桥自己启动的进程树。

新建 runtime：POST /runtimes；新会话：POST /rt/{id}/new；模型/档位观测：GET /models 与 /status。
持久 sessionPath 是会话 ID。恢复时 POST /runtimes 携带 sessionPath；重新核对任务路由并更新本轮快照。
默认 studioRuntimeReuse=false；同一客户端的后续提示先关闭自己的 runtime，再按相同 sessionPath 和模型恢复。
恢复后核对模型与档位，变化则在提交前失败。逻辑会话复用不要求 runtime 复用。
这处理已实测的 Responses 服务 previous_response_id 501；仅影响新的显式提示，不重放失败轮次。
支持响应链的服务可显式设置 studioRuntimeReuse=true。
空会话没有持久 transcript，关闭后无法恢复，probe 如实标为未验证。

提交前先开启 GET /rt/{id}/events，再 POST /submit；SSE turn_done 才结算。
Studio 可能丢弃 text delta，因此桥只收集可靠的完整 message，避免重复或缺字。
编号事件或水位显示遗漏、断流、超时均保留 unknown，不自动重新提交。
执行预算暂停的 outcome 不映射成正常 completed。科学结论仍需验收。

工具审批把 Studio 的 approval ID 映射为一次允许/拒绝，结果通过 /approve 回传；永远 session=false、persist=false。
问题通过明确的桥澄清标记上送。原生 ask 停止等待后，回答以普通提示续跑，不保留原 askID 的 /answer 状态。
URL 型交互不由桥自动打开或完成。
文本标记只在代码围栏外的行首识别；正文引用或代码样例不会触发澄清。

## 不变量与边界

先落盘派发意图，再启动 worker；同 ID 同契约幂等，同 ID 异契约冲突。
同会话串行；重叠工作区排队。输入版本/分支变化由主控更新 contextRevision。
unknown 需核对副作用并显式 resolve；retry 是另一步，不自动发生。
历史任务保留任务级模型与档位快照；共享配置改变不改写历史结果。
产物指纹只证明字节，不证明科学正确性。

Studio HTTP 当前不是公开稳定 SDK。适配依据官方 studio 分支源码与本机 2.29.0；升级后先 probe 再运行隔离模型验收。
不宣称能共享 GUI 活跃聊天，不监控升级，不提供独立 Codex 反向咨询实例。
