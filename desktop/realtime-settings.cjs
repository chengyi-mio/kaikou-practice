const fs = require("node:fs");
const { persistRecord } = require("./service-settings.cjs");
const { validateTrial } = require("../server/live-trial.cjs");

const defaults = {
  region: "cn-beijing",
  workspace: "",
  model: "qwen3.8-omni-flash-realtime",
};
function validateRealtime(input) {
  if (!input || !["cn-beijing", "ap-southeast-1"].includes(input.region))
    throw Error("请选择北京或新加坡地域。");
  if (
    typeof input.workspace !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{1,99}$/.test(input.workspace)
  )
    throw Error("请填写百炼业务空间 ID（字母、数字或连字符）。");
  if (
    typeof input.model !== "string" ||
    !/^qwen[a-zA-Z0-9.-]*realtime[a-zA-Z0-9.-]*$/.test(input.model) ||
    input.model.length > 150
  )
    throw Error("请填写支持实时语音的千问模型名称。");
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== "string" ||
      input.apiKey.length > 4096 ||
      /[\r\n\0]/.test(input.apiKey))
  )
    throw Error("密钥格式不正确。");
  return {
    region: input.region,
    workspace: input.workspace,
    model: input.model,
  };
}
function createRealtimeSettings({ env, file, encrypt, decrypt }) {
  let current = { ...defaults, key: "" };
  const assign = () =>
    Object.assign(env, {
      LIVE_REGION: current.region,
      LIVE_WORKSPACE: current.workspace,
      LIVE_MODEL: current.model,
      LIVE_API_KEY: current.key,
      LIVE_TRIAL: JSON.stringify(current.trial || null),
    });
  function reload() {
    const candidate = fs.existsSync(file) ? file : `${file}.tmp`;
    if (fs.existsSync(candidate)) {
      const saved = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const config = validateRealtime(saved);
      const key = saved.key ? decrypt(Buffer.from(saved.key, "base64")) : "";
      if (candidate !== file) persistRecord(file, saved);
      current = { ...config, key, trial: saved.trial };
    }
    assign();
  }
  function read() {
    reload();
    return {
      region: current.region,
      workspace: current.workspace,
      model: current.model,
      hasKey: Boolean(current.key),
      trial: current.trial,
    };
  }
  function save(input) {
    // Read failures must not silently replace an existing encrypted key.
    reload();
    const config = validateRealtime(input);
    const sameAccount =
      current.region === config.region &&
      current.workspace === config.workspace;
    const key =
      input.clearKey === true
        ? ""
        : input.apiKey?.trim() || (sameAccount ? current.key : "");
    if (!key && input.clearKey !== true)
      throw Error("请填写实时语音 API Key；切换地域或业务空间后需重新填写。");
    const sameConfiguration = sameAccount && current.model === config.model && key === current.key;
    const trial = input.clearKey ? undefined : input.trial
      ? validateTrial(input.trial)
      : sameConfiguration ? current.trial : undefined;
    if (trial && config.region !== "cn-beijing")
      throw Error("免费试用仅限北京地域，请先核对地域。");
    persistRecord(file, {
      ...config,
      trial,
      key: key ? encrypt(key).toString("base64") : "",
    });
    current = { ...config, key, trial };
    assign();
    return { ...config, hasKey: Boolean(key), trial };
  }
  // A damaged LIVE config must not prevent the desktop or existing reviews from opening.
  try {
    reload();
  } catch {
    /* read/start will report the error without overwriting */
  }
  return { read, save, reload };
}
module.exports = { createRealtimeSettings, validateRealtime };
