# LIVE 模拟面试 · 0.13.0

> 本文记录 0.13.0 的历史实现。当前 0.13.3 已加入双方录音，免费额度试用限 5 或 10 分钟，详见 [当前录音说明](LIVE通话录音-0.13.3.md) 和 [免费额度试用说明](LIVE免费额度试用-0.13.1.md)。

本次在原有逐轮面试旁加入独立的 LIVE 实时面试。原有普通练习、AI 点评、逐轮面试草稿和密钥继续保留。

## 如何使用

1. 打开「模拟面试 → LIVE 实时面试」。上传或粘贴简历、岗位 JD，并检查识别文字。
2. 展开「LIVE 服务配置」，填写百炼的地域、业务空间 ID、支持的实时模型和该地域的 API Key。默认模型为 `qwen3.8-omni-flash-realtime`。
3. 保存后，Windows 使用系统加密保存实时密钥。再次打开无需重复输入；留空保存继续使用同一地域、同一业务空间的密钥。切换地域或业务空间需重新填写。
4. 选择 5、10、15 分钟上限及 1.2、2、3 秒思考停顿，阅读数据发送与计费说明后开始。建议使用耳机。
5. 直接回答问题。检测到用户开口时取消当前模型回复并停止其声音，也可点击「打断面试官」。静音不会断开会话或停止计费；「结束 / 暂停通话」会断开连接。
6. 断线后确认网络再点击重新连接，承接已收到的对话。本轮时长累计，不因重连重新计时。达到上限自动结束。
7. 通话结束后检查文字，未确认转写需要补充并确认；正常完成的转写无需重新编辑。点击「生成 AI 面试复盘」，调用原先配置的 Agnes 或其他兼容聊天服务。
8. 查看岗位匹配、回答结构、具体证据、问题回应等维度的建议。引用无法在回答中找到时不显示分数。可导出本轮文字并查看本机保存的 LIVE 复盘。

## 实现边界

- 语音使用 Qwen-Omni-Realtime WebRTC：本机服务代理 SDP 鉴权，密钥不下发到网页；音频通过 WebRTC 直接传给服务商，控制及转写走 DataChannel。
- 面试官规则要求每次只问一个问题，围绕本人行动、决策理由和真实结果追问；简历/JD/对话作为资料而非指令。
- LIVE 的密钥独立保存在 `live-service.json`，不替换 `ai-service.json`。保留固定 userData `KaikouPractice` 和 partition `persist:kaikou`。
- 逐轮与 LIVE 的资料、回答分别保存。仅首次填充资料可参考现有简历/JD，不提交逐轮回答。重新开始 LIVE 会明确提示清除当前未保存对话，历史复盘不变。
- 前端只保存已收到的文字，不保存 LIVE 原始音频。断线或直接结束时未完成的音频转写不能恢复；界面保留未确认状态，不自动评分。
- 不估算人民币费用或承诺免费。页面只展示服务实际返回的 token 用量；可能不包含所有费用，实际以账单为准。时长上限是应用控制，不是服务商账户的硬性消费上限。
- 首版不含数字人、摄像头分析或本地离线实时语音。默认音色来自实时模型，不使用原版系统朗读冒充实时模型声音。
- 服务异常时保留 AI 入口，不静默切换成基础反馈，不以测试结果冒充真实模型调用。

## 网页开发环境

服务端可设置 `LIVE_API_KEY`、`LIVE_WORKSPACE`、`LIVE_REGION`（`cn-beijing` 或 `ap-southeast-1`）、`LIVE_MODEL`。浏览器不会保存实时密钥；桌面版在应用内配置即可。

## 验证方法

单元测试：`npm test`。浏览器测试：`npx playwright test tests/e2e/live-interview.spec.ts tests/e2e/interview.spec.ts tests/e2e/ai-recovery.spec.ts`。设置 `KAIKOU_E2E_PORT` 可使用独立服务端口。

桌面：`node desktop/upgrade-test.mjs <旧版exe绝对路径> <新版exe绝对路径>`，以及 `node desktop/live-interview-smoke-test.mjs <新版exe绝对路径>`。均使用隔离 userData、虚构密钥和独立端口，不读取用户真实练习或调用付费服务。

浏览器测试使用浏览器原生 RTCPeerConnection 对接本机测试端，验证媒体通道、字幕事件、打断、重连、倒计时、失败重试、旧草稿隔离和取消连接后麦克风释放；AI 文本由测试夹具提供。**这不是千问/Agnes 的真实模型验收。**

仍需真实凭据完成一次实际通话：检查地域/工作空间/模型权限、服务端会话参数兼容性、中文转写、插话效果、延迟、弱网行为及账单，再验证 Agnes 的实际复盘质量。没有实时服务凭据时，这一项不能标记完成。

### 本地验证结果（2026-11-03）

- `npm test`：78 项通过。
- AI 恢复、原有逐轮面试和 LIVE 浏览器测试：16 项通过；最后调整语音打断后，4 项 LIVE 测试再次通过。
- `npm run build`：通过。Vite 仍提示主包超过 500 KB，不影响构建；本次未进行无关的代码拆包重构。
- 0.12.0 → 0.13.0 隔离升级测试：通过，加密点评配置、练习和新旧记录的 AI 入口均保留。
- 新版打包应用测试：通过，Windows 加密 LIVE 密钥重启后可读、留空保存保留密钥，原点评密钥的文件字节不变；打包后的 WebRTC 通道、字幕、结束通话和复盘入口通过本机测试端验证。
- 桌面截图使用 Electron 原生 `capturePage`，保持测试窗口隐藏；不使用用户真实数据。
- 构建位置：`release/live-interview-0.13.0/win-unpacked/开口练习.exe`；安装包：`release/live-interview-0.13.0/Kaikou-Setup-0.13.0.exe`。
- 修改前源码与快捷方式备份：`.reference-analysis/live-backup-20261103-072933/`。
- 未推送、未合并、未发布到 GitHub；没有发起真实付费模型调用。

## 官方接口依据

- [Qwen-Omni-Realtime 接入与 WebRTC](https://help.aliyun.com/zh/model-studio/realtime)
- [Realtime 客户端事件](https://help.aliyun.com/zh/model-studio/client-events)
- [协议选型](https://help.aliyun.com/zh/model-studio/realtime-api-overview)

核对日期：2026-11-03。地域、模型权限及收费规则以服务商控制台为准。
