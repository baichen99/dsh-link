# DSH Link

**把电脑上的 DeepSeek Harness 带到 AgentLink Web。**

在 DSH 中安装插件、绑定 AgentLink 账号，就能从另一台电脑或手机的浏览器打开 DSH 原生界面，查看会话、继续任务和处理交互。模型调用、工具执行和会话保存仍由本机 DSH 负责。

[打开 AgentLink Web](https://link.harmopath.com/) · [安装插件](#安装) · [使用方法](#使用) · [常见问题](#常见问题)

本项目独立开源，不依赖 T3 Code 的前端、daemon 或会话协议。当前为预览版，适配 **DSH `0.1.6-alpha.2`**；npm 包名为 `dsh-agentlink`，暂未发布到 npm，请按下面的源码安装方式使用。

## 安装

### 1. 准备环境

在运行 DSH 的电脑上安装 **Node.js 22.19 或更高版本**、Git 和 pnpm。插件随 DSH 进程运行，电脑需要保持联网且不休眠。

如果还没有 DSH 和 pnpm：

```sh
npm install -g @deepseek-ai/dsh@0.1.6-alpha.2 pnpm@10.17.1
```

已有 DSH 的用户请先运行 `dsh --version` 核对版本。其他 DSH 版本尚未验证，不建议直接覆盖已有安装。

### 2. 下载并构建插件

```sh
git clone https://github.com/baichen99/dsh-link.git
cd dsh-link
npm ci
npm pack
```

`npm ci` 会自动构建插件；`npm pack` 生成 `dsh-agentlink-0.1.0.tgz`，包含原生界面和运行时所需文件。

### 3. 安装到 DSH

先关闭当前运行的 DSH，然后在刚才的 `dsh-link` 目录执行：

**macOS / Linux：**

```sh
dsh plugin --profile web add "$(pwd)/dsh-agentlink-0.1.0.tgz"
dsh web
```

**Windows PowerShell：**

```powershell
dsh plugin --profile web add "$((Get-Location).Path)/dsh-agentlink-0.1.0.tgz"
dsh web
```

使用自定义 profile 时，将 `web` 替换为该 profile 名，启动时使用 `dsh --profile 你的名称`。插件必须安装到你实际启动的 profile 中。

## 使用

### 从本机 DSH 绑定账号

1. 打开本机 DSH 网页，进入 **设置 → AgentLink**。
2. 点击 **登录 AgentLink**，再打开 **前往 AgentLink 授权**。
3. 在 AgentLink 页面登录账号，核对账号和 DSH 实例名称，点击 **确认绑定此实例**。
4. 回到 DSH 设置页，看到 **已连接** 即可。授权链接有效期为十分钟，也可以点击 **取消登录** 后重新开始。

账号登录与绑定在 AgentLink 页面完成。不要把授权链接分享给其他人。

### 从电脑或手机访问

1. 打开 [AgentLink Web](https://link.harmopath.com/)，登录刚才绑定的同一账号。
2. 在机器列表中找到标记为 **DSH** 的在线实例，点击 **进入机器**。
3. 在 DSH 原生界面中选择工作区和会话。模型、工具和权限配置沿用该 DSH 实例。

手机使用浏览器即可，无需安装 CLI。关闭远程网页不会停止本机 DSH；关闭本机 DSH 或电脑休眠会使远程访问离线。

### 重连与解绑

- 网络中断后，插件会尝试重连；远程页面可点击 **重新连接**。
- 在本机 **设置 → AgentLink → 解绑此实例**，会停止远程访问并移除账号中的绑定。
- 也可以在 AgentLink Web 的机器列表移除实例。
- 解绑遇到网络错误时，插件会保留本地凭证供重试；请在恢复网络后再次解绑。

## 更新与卸载

更新源码并重新打包，关闭 DSH 后按安装步骤安装新生成的文件，再重启：

```sh
git pull --ff-only
npm ci
npm pack
```

卸载前先在设置页解绑，然后关闭 DSH，执行：

```sh
dsh plugin --profile web remove dsh-agentlink
```

## 常见问题

**设置里找不到 AgentLink？** 先确认安装和启动使用同一个 profile，并已重启 DSH；同时核对 DSH 版本。插件的绑定设置只在本机界面显示。

**机器列表里没有实例，或者一直离线？** 确认两边登录同一 AgentLink 账号、本机 DSH 正在运行，设置页显示「已连接」。点击重新连接；如果提示绑定已撤销，重新登录绑定。

**需要自己搭服务器吗？** 默认连接 `https://link.harmopath.com`，普通用户无需部署中继。实例数量和中继流量遵循 AgentLink 账号套餐。

**可以自托管吗？** 可以连接具备 DSH 支持的 AgentLink multi 模式 Web/Hub。新建 `agentlink.patch.yml`：

```yaml
- id: agentlink
  config:
    hubUrl: https://your-agentlink.example.com
    name: 我的 DSH
```

```sh
dsh --profile web --patch ./agentlink.patch.yml
```

仅本机测试允许 HTTP loopback 地址。更换服务前先在原服务解绑。本仓库不提供独立 Hub 安装包。

## 预览版范围

- 支持账号绑定、统一实例入口、原生界面、RPC、事件流、插件模块加载、加密文件传输、重连与解绑。
- 单次上传与单条事件上限为 **16 MiB**；每个浏览器最多 32 个并发请求，每个实例最多 16 个浏览器通道。下载先通过加密通道读取到浏览器内存。
- 界面版本与 DSH `0.1.6-alpha.2` 固定匹配。升级 DSH 时，需要同步适配并复测。
- 原生界面运行在隔离沙箱中。依赖直接访问外网、独立 Worker 或弹出窗口的第三方插件，可能需要额外适配；浏览器显示偏好在刷新后重置。
- 已用真实 DSH 验证绑定、原生页面、工作区事件同步、重启恢复、解绑和手机宽度布局。真实模型对话、工具审批、浏览器文件选择器收发和第三方插件尚未完成全面验收。

## 安全与数据

DSH 负责模型、工具、审批、项目和会话；插件负责连接与传输。绑定保存在 DSH Credentials 服务中。Web 的原生界面沙箱拿不到 AgentLink 账号 Cookie 或机器密钥，也不能通过远程通道调用插件绑定管理接口。

传输使用 AgentLink 的 AES-GCM 加密信封，并校验通道随机标识和消息序号。Hub 数据面转发密文；**托管账号控制面保存用于跨设备访问的机器密钥，仍在信任边界内**。这不等于云端完全无法取得密钥。

## 开发

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

`src/account.js` 管理绑定，`src/host-tunnel.js` 和 `src/browser.js` 负责加密通道，`src/viewer.js` 承载原生界面。Web/Hub 配套代码维护在 [AgentLink 主仓库](https://github.com/baichen99/agentlink)，本仓库独立管理版本与 Issues。

## 许可证

本项目使用 [MIT](LICENSE) 许可证。构建产物包含 DeepSeek Harness 原生 Web（MIT），许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
