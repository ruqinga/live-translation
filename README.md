# 同声字幕（英译中实时字幕）

手机网页版工具：听英文，实时显示中文字幕。纯 HTML/CSS/JS，单文件 `index.html`，无构建步骤，可直接用 GitHub Pages 部署。

## 功能

- **语音识别**：默认使用 Deepgram 流式识别（nova-3），可在设置里切换为「浏览器自带」（Web Speech API，免费，作为备用）。
- **翻译**：Claude API 流式翻译，带前 3 句上下文；也可通过自建 Worker 中转切换 DeepSeek / OpenAI。
- 中英对照 / 只看中文、字号调节、复制全文、导出文本、屏幕常亮、打字输入。
- **场景与术语**：里面的英文单词/短语会自动作为 Deepgram 的 keyterm，提高专业词汇识别率；整段文字同时交给 Claude 作翻译参考。
- **口音**：美式 / 英式 / 澳式 / 印度英语，同时决定 Deepgram 的识别语言。
- Deepgram 模式下顶部状态栏显示已收听时长（mm:ss，累计），方便估算费用。
- 连接意外断开会自动重连（最多 3 次，间隔 1/2/4 秒），状态栏会提示。

## 获取密钥

密钥只保存在你手机浏览器的 localStorage 里，不会上传到任何服务器（只会直接发给 Deepgram / Anthropic）。

**Deepgram**
1. 注册 <https://console.deepgram.com>（新用户有免费额度）。
2. 进入 API Keys 创建密钥（权限选 Member 或 Usage 即可），复制。
3. 在本页「设置 → Deepgram API 密钥」粘贴。

**Claude**
1. 注册 <https://console.anthropic.com>，充值后在 API Keys 创建密钥（以 `sk-ant-` 开头）。
2. 在「设置 → Claude API 密钥」粘贴。

## 费用参考（以官网当前价格为准）

- **Deepgram nova-3 流式**：按音频时长计费，约 0.0077 美元/分钟（约 0.46 美元/小时）。只有开着麦克风、连接 Deepgram 时才计费，停止后会关闭连接和麦克风。
- **Claude**：Haiku 每句翻译只有几十到一百多个 token，一小时的演讲通常仅几美分；Sonnet 更准但更贵。
- 状态栏的时长 × 单价即可估算 Deepgram 费用。

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

也可用命令行：`cd worker && npx wrangler deploy`，再用 `npx wrangler secret put ACCESS_TOKEN` 等命令设置密钥。

**在页面里使用**：设置 → 翻译通道选「自建中转」，填入中转地址和访问口令，再选翻译服务商和模型即可。此时不需要再填 Claude / Deepgram 密钥。

**接口**
- `POST /translate`：body 为 `{provider, model, system, user}`，返回统一的流式格式 `data: {"t":"文本"}`，结束为 `data: [DONE]`。
- `GET /deepgram-token`：返回 `{access_token, expires_in}`，页面用 `new WebSocket(url, ["bearer", access_token])` 连接。
- 所有请求都要带 `Authorization: Bearer <ACCESS_TOKEN>`。服务商和模型有白名单，想加新模型改 `worker.js` 顶部的 `PROVIDERS`，同时在 `index.html` 的 `MODELS` 里加上。

**注意**：访问口令一旦泄露，别人就能消耗你的额度，请定期更换，并建议设置 `ALLOWED_ORIGIN`。

## 使用注意

**通用**
- 必须用 **https** 网址打开（GitHub Pages 默认就是），否则浏览器不给麦克风。
- 第一次点麦克风时允许麦克风权限；被拒绝后需在浏览器/系统设置里重新允许并刷新页面。
- 建议靠近说话人、环境安静。

**iPhone**
- 请用 **Safari**（iOS 14.5 及以上）；从主屏幕添加的网页同样可用。
- 音频采集使用 AudioWorklet 输出 16kHz PCM，而不是 MediaRecorder（Safari 录出 mp4，不适合流式识别）。
- 收听时请保持屏幕亮着、页面在前台；锁屏或切到后台，系统会暂停麦克风。
- 「浏览器自带」引擎在 iPhone 上受系统听写限制，效果不如 Deepgram。

**安卓**
- 请用 **Chrome**。收听时保持页面在前台，省电模式可能会中断后台音频。
- 用蓝牙耳机时，麦克风可能被切换到耳机，建议使用手机自带麦克风。

## 部署

把 `index.html` 放在仓库根目录，在 GitHub 仓库 Settings → Pages 选择分支即可。
