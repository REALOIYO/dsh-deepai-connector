# dsh-deepai-connector

[![npm](https://img.shields.io/npm/v/dsh-deepai-connector?style=flat-square)](https://www.npmjs.com/package/dsh-deepai-connector)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE?style=flat-square)](https://github.com/topics/dsh-plugin)

把 DeepAI Code 的上游模型接入 DeepSeek Harness。浏览器授权一次即可，不需要安装 DeepAI Code 桌面客户端，也不需要额外的网关进程。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

## 安装

在 DSH 的「设置 → 插件」里按包名 `dsh-deepai-connector` 安装，或用插件管理器：

```sh
dsh plugin add dsh-deepai-connector
```

装完重启 DSH。包内已含预构建产物，安装过程不执行构建。

## 首次使用

1. 打开「设置 → DeepAI Code」，点「登录」
2. 把授权链接复制到浏览器，用 **Google 或 Apple** 账号完成授权
3. 授权成功后模型自动出现在模型选择器里

## 功能

- 浏览器 OAuth 取 Key（RFC 8252 本机回调），与桌面端同款流程
- 复刻上游请求头形状：`Api-Key` 鉴权、车道版本、进程实例号、机器指纹、`User-Agent: node`
- 推理前自动完成签到（`/theos` 拉 nonce 再回传）
- 自建请求体与 SSE 解析，不依赖任何 LLM SDK
- 上游以 `400 This request is not one DeepAI Code sends.` 拒绝异形请求体时报错后，按桌面端字段白名单重排一次
- 模型目录由上游下发，本地只做缓存；免费模型在选择器里带「· 免费」标记

## 已知限制

**账号要求**：上游自 0.3.19 起只允许 Google/Apple 登录的账号推理。邮箱密码注册的账号会拿到 `403 social_login_required`，重试或更换网络都无效。

**不提供 prompt 缓存**：实测同一段 1028 token 前缀连发三次，`prompt_tokens_details.cached_tokens` 恒为 0，`cache_write_tokens` 亦为 0。DSH 用量面板因此始终显示 0% 命中，属上游行为，非配置问题。

**额度按出口 IP 发放**：同网络下免费额度为共享池，领完后需等待上游给出的刷新时间（`403 network_bound` 携带 `refresh_at`）。

**签到为有限资源**：当日重启签到次数用尽后返回 `403 check_in_refused`，推理仍可用，但可能落到替身后端。

**可能落到替身后端**：即使协议全部对齐，上游仍可能把请求转到另一条后端。判据是响应中 `usage.cost_details.upstream_inference_cost` 是否大于 0；状态码恒为 200，无法从状态码分辨。

**协议可能变更**：上游每次抬升车道版本即将旧值一律回 `426`。插件内置车道探测，较大改动仍需跟进。

## 与上游账号的关系

插件使用本机真实机器指纹（Windows 取 `Win32_ComputerSystemProduct.UUID`，回落到 `MachineGuid`），仅上传其 sha256 值，不上传原始标识；可用 `DEEPAI_MACHINE_ID` 覆盖。签到按上游要求的最小间隔节流，命中 `check_in_refused` 后静默锁 6 小时。

插件只服务单个自用账号，不含账号池、批量注册或额度绕行逻辑。上述措施降低被判定为非客户端的概率，不构成账号安全的保证。

## 许可与致谢

以 MIT 许可发布，见 [LICENSE](LICENSE)。

协议实现参考 [2951461586/DeepAICode2API](https://github.com/2951461586/DeepAICode2API)（MIT）。该项目的 `docs/recon.md` 记录了上游端点、请求头、签到与错误语义的逆向结果；本插件按其结论重新实现，未使用其代码。

插件形态与服务组织方式参考本人另一项目 [REALOIYO/dsh-qwenwork-connector](https://github.com/REALOIYO/dsh-qwenwork-connector)（MIT）。

## 开发

```sh
# 构建（esbuild 为构建期依赖，不写入 package.json）
DEEPAI_ESBUILD=<esbuild 目录> node build.mjs

# 测试
node --test "test/*.test.ts"
```

产物为 `lib/index.js`（Host，ESM）与 `lib/client.js`（浏览器，CJS，套 `window.__ModuleLoader__.load` 外壳）。测试直接运行 `src/` 下的 TypeScript，依赖 Node 22.18+ 的原生类型擦除。
