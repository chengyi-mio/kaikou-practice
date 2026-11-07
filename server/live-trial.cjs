// A manual console check is a preflight record, not a billing API or a quota guarantee.
const CHECK_MAX_AGE = 12 * 60 * 60 * 1000;
function validateTrial(value, now = Date.now()) {
  if (!value || value.freeTierOnly !== true || !Number.isSafeInteger(value.remainingTokens) || value.remainingTokens <= 0)
    throw Error("请先确认目标模型仍有免费额度，且控制台的“免费额度用完即停”已开启并生效。");
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now)
    throw Error("免费额度已过期或有效期未填写，请核对控制台。");
  return { freeTierOnly: true, remainingTokens: value.remainingTokens, expiresAt: new Date(expiry).toISOString(), checkedAt: now };
}
function trialStatus(env, now = Date.now()) {
  const blocked = (message) => ({ ready: false, message, maxSeconds: 600 });
  if ((env.LIVE_REGION || "cn-beijing") !== "cn-beijing")
    return blocked("免费试用仅限北京地域，本次不启用付费通话。");
  let trial;
  try {
    trial = JSON.parse(env.LIVE_TRIAL || "null");
    validateTrial(trial, now + 10 * 60 * 1000);
  } catch {
    return blocked("尚未核实免费额度或有效期不足 10 分钟。请在控制台确认额度和“用完即停”后记录检查结果。");
  }
  if (!Number.isFinite(trial.checkedAt) || trial.checkedAt > now || now - trial.checkedAt > CHECK_MAX_AGE)
    return blocked("免费额度检查已超过 12 小时，请重新核对控制台后再开始。");
  return { ready: true, message: "已记录人工额度检查；以控制台实际额度及用完即停状态为准。", maxSeconds: 600, ...trial };
}
module.exports = { validateTrial, trialStatus };
