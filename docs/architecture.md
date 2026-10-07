# 架构

```text
Codex → MCP stdio → Bridge → StudioClient → 自有 Studio host → Reasonix 引擎
                         ↓               HTTP + SSE
                  独立 JSON 状态目录
```

`src/orchestration.mjs` 沿用参考桥的任务、会话与工作区队列；`src/studio-client.mjs` 将 Studio HTTP 表面转换为内部会话接口。
这不是 Studio 的 ACP 实现；worker 快照的 protocolVersion=null、agentInfo.name=reasonix-studio-http 可区分两者。
可选独立 CLI 走原 ACP 客户端。

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
