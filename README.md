# DSH AgentLink

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 提供远程访问的独立开源插件。从 DSH 绑定账号，再从 AgentLink Web 的机器列表进入 DSH 原生界面。

当前为源码首版，适配 **DSH 0.1.6-alpha.2 / Node.js 22.19+**。尚未发布 npm，也未部署配套 Web/Hub；现有线上服务不能直接使用本版插件。

## 安装与使用

先安装匹配版本的 DSH，再在本仓库构建插件：

```sh
npm install -g @deepseek-ai/dsh@0.1.6-alpha.2
npm ci
dsh plugin --profile web add /absolute/path/to/dsh-agentlink
dsh web
```

`npm ci` 自动构建插件设置页、浏览器传输及固定版本的 DSH 原生界面。也可运行 `npm pack` 生成安装包，然后通过 `dsh plugin --profile web add /absolute/path/to/dsh-agentlink-0.1.0.tgz` 安装。

1. 本机打开 DSH，在「设置 → AgentLink」点击「登录 AgentLink」。
2. 打开授权链接，在 AgentLink 登录账号，核对账号和实例名称后确认绑定。链接十分钟有效，可在 DSH 取消。
3. 保持 DSH 运行。电脑或手机打开同一 AgentLink Web，登录同一账号，在机器列表选择标记为 DSH 的实例。
4. 「重新连接」重新建立通道；「解绑此实例」撤销机器凭证并断开访问。Web 移除实例也会撤销连接。

默认服务地址为 `https://link.harmopath.com`。开发或自托管需要包含 DSH 支持的 AgentLink **multi 模式** Web/Hub，可通过 DSH patch 修改：

```yaml
- id: agentlink
  config:
    hubUrl: https://your-agentlink.example.com
    name: 我的 DSH
```

```sh
dsh --profile web --patch ./agentlink.patch.yml
```

仅本机测试允许 HTTP loopback 地址。更换服务前先在原服务解绑。此仓库不发布独立 Hub。

## 实现与边界

- 本仓库不依赖 T3 Code 前端、daemon 或会话协议。DSH 继续负责模型、工具、会话、权限和审批。
- `src/account.js` 使用一次性设备配对，绑定保存在 DSH Credentials 服务；授权 URL 和设置页不包含机器凭证或加密密钥。保存失败会尝试撤销绑定，解绑失败保留凭证以便重试。
- `src/host-tunnel.js` / `src/browser.js` 适配 DSH Fetch、Typert 事件流与插件模块。复用 AgentLink AES-GCM 信封，额外绑定通道随机挑战与递增序号；每块 64 KiB，逐块确认、支持取消。每连接最多 32 个请求、每实例最多 16 个浏览器通道；上传与单条流事件上限 16 MiB。下载通过加密 Fetch 读取为 Blob，再交给浏览器保存。
- Web 父页面持有密钥，原生界面运行在无同源权限的 sandbox 中，只能通过 MessagePort 请求限定的 DSH 路径。远程通道拒绝 `/api/agentlink/*` 绑定管理接口。沙箱禁止直连网络，因此依赖任意外网、独立 Worker 或另开窗口的第三方插件需单独适配。
- 隧道数据面转发密文；托管账号目录保存用于跨设备访问的机器密钥，**托管控制面仍在信任边界内**。不要将其描述为云端完全无法取得密钥。
- 原生界面随插件固定版本构建；升级 DSH 时须同步版本并复测。浏览器展示状态仅在当前页面保存，刷新会重置；文件上传经 DSH 的自定义上传接口转发。

## 开发与验证

```sh
npm test
npm run build
npm pack --dry-run
```

测试覆盖加密互通、错误密钥、重放拒绝、管理路径限制、大文件分块、流式取消、绑定保存顺序与失败解绑重试。AgentLink 主仓库负责实例目录、授权页、沙箱入口、Web 路由与账号隔离测试。

本地已验证真实 DSH 插件加载、Web 确认绑定、实例在线、原生界面、工作区事件同步、重启恢复、解绑撤销与 390px 页面。模型请求、真实工具审批、浏览器文件选择器上传/下载、第三方插件和生产登录提供商仍需发布前验收；本地合成数据检查不代表这些场景已通过。

## 许可证

本项目 [MIT](LICENSE)。构建产物包含 DeepSeek Harness 原生 Web（MIT），其许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。其他依赖许可保留在构建产物中。
