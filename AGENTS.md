# codex-reasonix-bridge

本项目由 codex-dsh-bridge 0.2.0 派生，GPL-3.0-only，保留原版权声明。
默认后端是安装包内 Reasonix Studio host 的 HTTP/SSE；它没有 ACP stdio 命令。
不要从 Reasonix 1.x 文档推断 Studio 2.x 接口；核对安装版与官方 studio 分支源码。

- 保持先落盘后派发、未知结果不自动重放、历史路由快照与有界资源回收。
- 只回收桥自己启动的 host；不得接管 GUI 活跃会话或删除用户研究历史。
- 启动握手携带 token；不要把 token、Cookie 或模型凭据写入日志、配置或报告。
- provider/model/reasoningEffort 默认沿用 Studio 配置。Studio effort endpoint 会写全局配置，不能隐式调用它。
- studioRuntimeReuse 默认 false；下一条显式提示前恢复同一持久会话并核对路由，不自动重放失败轮次。
- 工具审批只映射 native ID 的一次允许/拒绝；不合成持久权限。
- 原生 ask 通过取消等待与普通提示续跑，不能声称使用了原 askID 的 /answer。
- 引用或代码围栏中的澄清标记不应触发澄清状态。
- 离线验证：npm run check、npm test、npm run test:unit、npm run smoke。
- probe 启动真实 host 但不发送模型提示。真实模型测试有费用且须在用户授权范围内，使用临时工作区与独立状态。
- 新测试应覆盖传输差异与重要状态不变量；不要为简单文档变更增加无意义测试。
- 不把 fake 或 Linux 验收声明成 Windows/macOS、CLI、GUI 会话共享实测。

本机配置 bridge.config.json、会话状态 .bridge-state/ 和原始证据 .verification/ 不纳入发布。
