# DSH AgentLink

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 提供远程访问能力的开源插件，独立于 AgentLink 主仓库维护。

> 当前状态：项目初始化。插件、登录绑定和远程访问尚未实现，暂未发布安装包。

## 计划中的使用流程

1. 在 DSH 中安装插件，打开 AgentLink 页面。
2. 登录 AgentLink 账号并绑定当前 DSH 实例，查看连接状态和管理绑定。
3. 在另一台电脑或手机打开 AgentLink Web，登录同一账号，选择已绑定的 DSH 实例。
4. 通过适配过的 DSH 原生界面继续会话、查看执行过程和处理审批。

## 项目边界

- DSH 负责模型调用、工具执行、会话持久化、审批和原生交互界面。
- 本项目负责插件页面、登录绑定、远程连接，以及浏览器端与 DSH 端的传输适配。
- 远程连接计划复用 AgentLink 的中继与加密协议；具体实现需验证 DSH 的消息流、文件传输和前端资源加载。
- 托管入口接入现有 AgentLink Web；对应的 Web/Hub 支持在 AgentLink 主仓库中维护。
- 计划支持配置自托管中继地址。独立中继的发布方式后续确定。
- 本仓库不包含或依赖 T3 Code 的前端、daemon 或会话协议，也不复制 AgentLink 主仓库。

## 开发与维护

本项目独立管理 Issues、版本和发布。首个可用版本完成前，README 中的使用流程均为设计目标。

代码、测试和构建流程会随首个实现引入。请勿提交账号凭证、设备密钥、环境配置或用户会话数据。

## 许可证

[MIT](LICENSE)
