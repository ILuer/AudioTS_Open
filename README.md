<p align="center">
  <img src="https://img.shields.io/github/license/ILuer/AudioTS_Open?style=flat" alt="License" />
  <img src="https://img.shields.io/github/last-commit/ILuer/AudioTS_Open" alt="Last Commit" />
  <img src="https://img.shields.io/github/stars/ILuer/AudioTS_Open" alt="Stars" />
  <img src="https://img.shields.io/github/issues/ILuer/AudioTS_Open" alt="Issues" />
  <img src="https://img.shields.io/github/languages/top/ILuer/AudioTS_Open" alt="Top Language" />
</p>

# AudioTS

**浏览器里的 AI 配音工作室 · 完全离线 · 隐私安全**

AudioTS 是一款完全在你的浏览器中运行的语音合成工具。无需服务器、无需上传数据，只要准备好模型文件，打开网页就能把文字变成自然流畅的语音。

## ✨ 核心功能

- **🌍 多语言语音合成**
  支持中文、英文、日语、韩语、法语、德语、西班牙语、葡萄牙语、意大利语、俄语等 10 种语言，一键将文字转为自然语音。

- **🎙️ AI 音色设计**
  用一句话描述你想要的声音，例如「温柔的女声」「沉稳的男声」「活泼的少年音」，系统自动生成匹配的音色，无需任何音频样本。

- **👤 自定义音色（参考音频）**
  上传一段参考音频，即可提取其声音特征，复刻出专属音色，用于后续任意文本的配音。

- **🎬 台词批量配音（配音台）**
  导入台词本（支持 `.txt` 文本或 `.xlsx` 表格），为每一行指定音色与情绪，一键批量生成全部配音，特别适合有声书、视频配音、游戏对白等场景。

- **🔒 完全离线 · 隐私保护**
  所有语音合成均在本地浏览器完成，文字与音频不经过任何服务器，充分保护你的内容隐私。

- **🎚️ 实时微调**
  可调节语速、随机种子等参数，轻松获得不同的发音风格与变体。

## 🚀 在线体验

立即在浏览器中试用：

👉 **[点此体验](https://open.ats.iluer.com)**

> 首次使用需准备模型文件（从 HuggingFace 下载后选择本地目录）。页面会引导你完成这一步。

## 📖 三步开始使用

1. **打开网页** —— 访问在线体验地址，或在本地打开 AudioTS。
2. **选择音色** —— 用文字描述理想声音，或上传参考音频创建专属音色。
3. **输入文字，生成语音** —— 粘贴文本，点击生成，即可试听与下载。

## 🛡️ 安全架构与已知控制台报错

AudioTS 的安全采用**两层架构**：

- **站内安全（由项目代码负责）**：应用逻辑、模型加载、音频处理全部在浏览器本地完成，文字与音频不出本机。通过严格的 CSP（Content-Security-Policy）约束浏览器端可执行脚本，缩小 XSS 等前端攻击面。
- **站外安全（由 Cloudflare Pages 负责）**：站点的边缘防护——包括 Cloudflare 机器人防护（Bot Management）与访问分析（Web Analytics）——完全依赖 Cloudflare 平台，不在项目代码内实现。

### 为什么控制台会出现 CSP 报错（且无需修复）

为在不弱化 CSP 的前提下保留 Cloudflare 的站点级防护，我们**刻意保持严格 CSP**（`script-src 'self' 'wasm-unsafe-eval'`）。而 Cloudflare 的部分 zone 级功能会在边缘向 HTML 注入**内联脚本**：

| 来源 | 注入内容 | 被 CSP 拦截的表现 | 性质 |
|------|---------|------------------|------|
| Bot Management → JavaScript Detections | 创建隐藏 iframe 并加载 `/cdn-cgi/challenge-platform/.../main.js`，设置 `window.__CF$cv$params` | `Executing inline script violates CSP` | 站外安全功能，非致命 |
| Web Analytics | 内联分析 loader + 外部 `beacon.min.js` | 内联脚本 CSP 报错；`beacon.min.js` 还可能被浏览器隐私防护/广告拦截器客户端拦截（`ERR_BLOCKED_BY_CLIENT`） | 访问统计，非安全 |

**这些报错是「安全设计」的预期副作用，不影响功能与安全：**

1. **机器人防护依然生效**。Bot Management 运行在 Cloudflare 边缘（zone 级），对请求的评分与拦截独立于本应用的 CSP。CSP 只决定「浏览器里哪些脚本能执行」，管不到 Cloudflare 边缘的防护。实测 `open.ats.iluer.com` 响应经 `Server: cloudflare` 代理、含 `CF-RAY` 边缘标识，且对可疑客户端会注入 `challenge-platform` 挑战脚本——证明防护在主动执行。
2. **报错仅出现在 Cloudflare 主动发起挑战时**（如流量被识别为可疑），对通过其它信号判定为正常的人类访客不会注入挑战、也无报错。
3. **应用本身照常运行**：项目自身的脚本均为同源外链（`'self'` 放行），不受内联脚本 CSP 影响。

### 如果你希望消除这些报错

- **机器人防护**：必须在 Cloudflare 控制台保留（站外安全核心）。若要彻底消除其内联挑战带来的 CSP 报错，可采用 Cloudflare Pages Function（`_worker.js`）以 per-request nonce 下发严格 CSP 的兼容方案——这属于部署架构变更，本项目当前选择「保持严格 CSP + 容忍边缘注入报错」的简洁路线。
- **Web Analytics**：该项为访问统计、非安全功能，可在 Cloudflare 控制台按需开关；开启时会带来上述分析类报错，属预期。

> 简言之：**严格 CSP 是我们的选择，Cloudflare 边缘注入是平台行为；两者冲突产生的控制台报错是已知且无害的，不代表应用或防护存在缺陷。**

## 📄 开源许可

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0）** 许可证发布。

- **你可以**：免费使用、复制、修改本软件，并将其用于个人与商业用途。
- **你必须**：在分发（含修改版本）时，以相同许可证（AGPL-3.0）开放全部源代码。
- **网络使用条款**：若你通过网络（如搭建网站、提供在线服务）向他人提供本软件，也必须向用户提供完整的对应源代码。
- **无担保**：本软件按「原样」提供，作者与贡献者不对使用后果提供担保。

完整许可条款请参阅 [LICENSE](LICENSE) 文件。

Copyright © 2026 AudioTS 项目贡献者

## 🔗 相关链接

- 项目仓库：[github.com/ILuer/AudioTS_Open](https://github.com/ILuer/AudioTS_Open)
- 在线演示：[点此体验](https://open.ats.iluer.com)
