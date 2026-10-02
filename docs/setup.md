# 部署与配置

[← 返回 README](../README.md)

## 获取密钥

Deepgram 和 Claude 的密钥只保存在你手机浏览器的 localStorage 里，不会上传到任何服务器（只会直接发给对应厂商）。**Soniox 例外：它的密钥不放在手机上**，只放在 Cloudflare Worker 的环境变量里（见下文「自建中转层」），手机只保存一个访问口令。

**Soniox（默认识别 + 翻译）**
1. 注册 <https://console.soniox.com>，创建项目后在 API Keys 里生成并复制 API Key。
2. 在控制台的账单（Billing）里充值（Soniox 按用量计费，先充一点即可，余额用完识别会被拒绝，页面会提示「余额不足」并自动切到备用引擎）。具体单价和是否有免费额度以 Soniox 官网为准。
3. 到 Cloudflare Workers 里把它设成环境变量（Secret）`SONIOX_API_KEY`，步骤见「自建中转层」。页面里不需要、也不能填这个密钥。

**Deepgram（备用识别引擎）**
1. 注册 <https://console.deepgram.com>（新用户有免费额度）。
2. 进入 API Keys 创建密钥（权限选 Member 或 Usage 即可），复制。
3. 在本页「设置 → 语音识别 → Deepgram API 密钥」粘贴（走自建中转时改在 Worker 里配 `DEEPGRAM_API_KEY`）。

**Claude**
1. 注册 <https://console.anthropic.com>，充值后在 API Keys 创建密钥（以 `sk-ant-` 开头）。
2. 在「设置 → 大语言模型 → Claude API 密钥」（连接方式选「直连」时出现）粘贴（走自建中转时改在 Worker 里配 `ANTHROPIC_API_KEY`）。

## 费用参考（以官网当前价格为准）

- **Soniox**：按流的时长计费（识别和翻译的单价以 Soniox 官网为准）。注意：连接开着就计费，哪怕没人说话；所以页面在你点「停止」或锁屏中断时会立刻关闭连接，不会用保活消息挂着。
- **Deepgram nova-3 流式**（备用）：按音频时长计费，约 0.0077 美元/分钟（约 0.46 美元/小时）。只有开着麦克风、连接 Deepgram 时才计费，停止后会关闭连接和麦克风。
- **Claude**：Haiku 每句翻译/精修只有几十到一百多个 token，一小时的演讲通常仅几美分；摘要用 Sonnet 更准但更贵。关掉「翻译精修」可以省掉这部分。
- 状态栏的时长 × 单价即可估算识别费用。

## 自建中转层（可选，Cloudflare Workers）

不想在手机上保存各家密钥，或想随意切换 Claude / DeepSeek / OpenAI 时，可以部署 `worker/worker.js`。密钥全部存在 Worker 里，手机只保存一个访问口令；Deepgram 由 Worker 签发短期令牌。Workers 免费额度每天 10 万次请求，个人使用基本免费。

**部署（网页方式，不用装工具）**
1. 注册 <https://dash.cloudflare.com>，进入 Workers & Pages → Create → Create Worker，随便起个名字部署。
2. 点 Edit code，把 `worker/worker.js` 的内容整个粘贴进去覆盖，Deploy。
3. 在 Worker 的 Settings → Variables and Secrets 里添加 Secret：
   - `ACCESS_TOKEN`：自己编一串足够长的随机口令（必填）
   - `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`：用到哪家填哪家
   - `DEEPGRAM_API_KEY`：需要 Member 及以上权限（签发临时令牌用）
   - 可选变量 `ALLOWED_ORIGIN`，例如 `https://ruqinga.github.io`，限制只有你的页面能调用
4. 复制 Worker 网址（`https://xxx.workers.dev`）。

**Soniox 需要的环境变量**：在同一个位置再添加 Secret `SONIOX_API_KEY`（Soniox 控制台里的 API Key），添加后重新部署 Worker。页面向 Worker 的 `/soniox-token` 要一个 60 秒内有效、只能用于实时 WebSocket 的临时 key，再用它连接 Soniox（**真正的 API Key 不会下发到浏览器**）。没有配置时 Worker 会返回明确的中文提示，页面也会提示并自动切到备用引擎。

也可用命令行：`cd worker && npx wrangler deploy`，再用 `npx wrangler secret put ACCESS_TOKEN` 等命令设置密钥。

**在页面里使用**：设置 → 大语言模型 → 连接方式选「自建中转」，填入中转地址和访问口令，再选服务商和模型即可；点「测试连接」会发一个极短请求，成功显示绿色对勾和响应时间，失败显示原因。此时不需要再填 Claude / Deepgram 密钥。

**接口**（新版增加了 `/summary`，已部署过旧版 Worker 的需要更新代码并重新部署，否则摘要会提示「中转层还不支持摘要」；用 Cloudflare 的 Git 集成部署的话，合并到 main 后会自动更新）
- `POST /summary`：同 `/translate`，但允许更长的输入（约 20 万字符）和输出（4096 tokens），并支持 `claude-opus-5-5`。
- `POST /translate`：body 为 `{provider, model, system, user}`，返回统一的流式格式 `data: {"t":"文本"}`，结束为 `data: [DONE]`。
- `GET /deepgram-token`：返回 `{access_token, expires_in}`，页面用 `new WebSocket(url, ["bearer", access_token])` 连接。
- `POST /onedrive/login-ticket`、`GET /onedrive/login`、`GET /onedrive/callback`、`GET /onedrive/token`、`GET /onedrive/status`、`POST /onedrive/logout`（新，OneDrive 同步用，见 [OneDrive 同步](onedrive.md#onedrive-的-azure-应用注册和-worker-配置)）：除 `login`（凭一次性登录码）和 `callback`（凭一次性 state）这两个浏览器跳转地址外都要带访问口令；未配置 `MS_CLIENT_ID` / `MS_CLIENT_SECRET` 或没有绑定 `ONEDRIVE_KV` 时返回明确的中文提示。
- `GET /soniox-token`（新）：用 `SONIOX_API_KEY` 向 Soniox 换取临时 API key（有效期 60 秒，用途限定为实时 WebSocket），返回 `{token, expires_in_seconds}`；页面把它放进 WebSocket 第一条配置消息的 `api_key` 里。未配置 `SONIOX_API_KEY` 时返回 500 和中文提示。已部署过旧版 Worker 的需要更新代码并重新部署，否则页面会提示「中转层还不支持 Soniox」。
- 所有请求都要带 `Authorization: Bearer <ACCESS_TOKEN>`。服务商和模型有白名单，想加新模型改 `worker.js` 顶部的 `PROVIDERS`，同时在 `index.html` 的 `MODELS` 里加上。

**排错**：页面提示「中转访问口令无效」（401）时，先到 Worker 的 Settings → Variables and Secrets 确认 `ACCESS_TOKEN` 还在，并且和页面设置里的「访问口令」完全一致。Git 集成部署时，后台添加的普通变量（Text 类型）可能在重新部署后被清掉；添加密钥请选 **Secret** 类型，`wrangler.toml` 里也已加了 `keep_vars = true`。可以用下面的命令验证（应返回 200 和译文，而不是 401）：

```
curl -i -X POST https://你的Worker网址/translate -H "Authorization: Bearer 你的ACCESS_TOKEN" -H "Content-Type: application/json" -d '{"provider":"deepseek","system":"翻译成中文","user":"hello"}'
```

**注意**：访问口令一旦泄露，别人就能消耗你的额度，请定期更换，并建议设置 `ALLOWED_ORIGIN`。

OneDrive 同步需要的 Azure 应用注册、KV 和 Secret 配置，见 [OneDrive 同步](onedrive.md#onedrive-的-azure-应用注册和-worker-配置)。

## 部署

把 `index.html` 放在仓库根目录，在 GitHub 仓库 Settings → Pages 选择分支即可。

## 使用注意

**通用**
- 必须用 **https** 网址打开（GitHub Pages 默认就是），否则浏览器不给麦克风。
- 第一次点麦克风时允许麦克风权限；被拒绝后需在浏览器/系统设置里重新允许并刷新页面。
- 建议靠近说话人、环境安静。

**iPhone**
- 请用 **Safari**（iOS 14.5 及以上）；从主屏幕添加的网页同样可用。
- 音频采集使用 AudioWorklet 输出 16kHz PCM，而不是 MediaRecorder（Safari 录出 mp4，不适合流式识别）。
- 收听时请保持屏幕亮着、页面在前台；锁屏或切到后台，系统会暂停麦克风。
- 「浏览器自带」引擎在 iPhone 上受系统听写限制，效果不如 Soniox / Deepgram。

**安卓**
- 请用 **Chrome**。收听时保持页面在前台，省电模式可能会中断后台音频。
- 用蓝牙耳机时，麦克风可能被切换到耳机，建议使用手机自带麦克风。
