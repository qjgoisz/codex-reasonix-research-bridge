# CI 与发布

`.github/workflows/ci.yml` 在 push、pull request 和手动触发时运行。
目前验证 Linux、Node.js 24 与 Python 3.13；这不代表 Windows/macOS 原生验收。

检查顺序：语法、188 项回归、单元与多客户端进程测试、离线 smoke、源码打包。
仓库没有外部运行时/测试依赖，不执行 npm install，也不需要 lockfile。
CI 不启动真实 Reasonix、不调用模型、不使用模型密钥。
Actions 固定到完整 commit SHA，普通检查只有 contents:read 权限。
成功后可在该次 Actions 运行页面下载 source-package，保留 14 天。

本地生成相同格式的源码包：

```sh
npm run package:release
```

产物为 `dist/codex-reasonix-bridge-<version>.tgz` 与 `dist/SHA256SUMS`，dist 不进入版本控制。
打包前后均检查文件目录：本机配置、会话状态、凭据目录和原始报告不得进入源码包。
测试夹具保留在包中，使检查和离线 smoke 可复现。

发布步骤：

1. 确认 `package.json` 的 version 与 `src/version.mjs` 的 BRIDGE_VERSION 一致，提交到 GitHub。
2. 创建并推送同版本标签，例如当前版本为 0.1.0 时使用 `v0.1.0`。
3. CI 全部通过后，release job 使用内置 GITHUB_TOKEN 创建草稿 Release，附源码包与 SHA-256 校验文件。
4. 在 GitHub 核对草稿与附件，再点击发布。

标签必须严格等于 `v<package.json version>`；不一致会阻止发布。
发布任务仅在推送 v 开头标签时执行，PR 不会获得发布写权限。
相同标签已有 Release 时，创建会报错，不覆盖现有附件。
版本标签的运行不因后续 push 被自动取消。项目保持 private:true，此流程不向 npm registry 发布。
GitHub 上的 Actions 实际执行结果需在推送这些文件后查看；本地检查不能替代托管 runner 验收。
