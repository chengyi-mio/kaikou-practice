import { useEffect, useState } from "react";
import type { RealtimeConfig } from "./desktop-env";

export function RealtimeSettings({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<RealtimeConfig>({
    region: "cn-beijing",
    workspace: "",
    model: "qwen3.8-omni-flash-realtime",
    hasKey: false,
  });
  const [saved, setSaved] = useState<RealtimeConfig>();
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [remaining, setRemaining] = useState("");
  const [expires, setExpires] = useState("");
  useEffect(() => {
    let active = true;
    window.desktopApp
      ?.getRealtimeSettings?.()
      .then((result) => {
        if (!active) return;
        if (!result.success) {
          setNotice(result.message);
          return;
        }
        setConfig(result.value);
        setSaved(result.value);
      })
      .catch(() => {
        if (active) setNotice("读取 LIVE 配置失败，请重试。");
      });
    return () => {
      active = false;
    };
  }, []);
  const reusable =
    saved?.hasKey &&
    saved.region === config.region &&
    saved.workspace === config.workspace;
  async function save(clearKey = false) {
    if (!window.desktopApp?.saveRealtimeSettings) return;
    if (
      clearKey &&
      !window.confirm("清除实时语音密钥？原有 AI 点评密钥不受影响。")
    )
      return;
    setBusy(true);
    setNotice("");
    try {
      const result = await window.desktopApp.saveRealtimeSettings({
        ...config,
        trial: confirmed ? {
          freeTierOnly: true,
          remainingTokens: Number(remaining),
          expiresAt: expires ? new Date(expires).toISOString() : "",
          checkedAt: Date.now(),
        } : undefined,
        apiKey: key,
        clearKey,
      });
      if (!result.success) throw Error(result.message);
      setConfig(result.value);
      setSaved(result.value);
      setKey("");
      setConfirmed(false);
      onSaved();
      setNotice(
        clearKey
          ? "实时语音密钥已清除。"
          : "配置已加密保存在本机，下次无需重填。未发起模型调用；免费额度核对完成后才能试用。",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="live-settings">
      <summary>LIVE 服务配置 · 千问实时语音</summary>
      <p>
        本次仅试用免费额度，单轮最多 10 分钟。实时语音独立使用百炼密钥，Agnes 等点评服务保持原样。
      </p>
      {window.desktopApp?.saveRealtimeSettings ? (
        <>
          <div className="interview-columns">
            <label>
              服务地域
              <select
                value={config.region}
                onChange={(e) =>
                  { setConfig({ ...config, region: e.target.value }); setConfirmed(false); }
                }
              >
                <option value="cn-beijing">北京</option>
                <option value="ap-southeast-1">新加坡</option>
              </select>
            </label>
            <label>
              百炼业务空间 ID
              <input
                value={config.workspace}
                maxLength={100}
                onChange={(e) =>
                  { setConfig({ ...config, workspace: e.target.value.trim() }); setConfirmed(false); }
                }
                placeholder="控制台中的 Workspace ID"
              />
            </label>
          </div>
          <label>
            实时模型
            <input
              value={config.model}
              maxLength={150}
              onChange={(e) =>
                { setConfig({ ...config, model: e.target.value.trim() }); setConfirmed(false); }
              }
            />
          </label>
          <label>
            实时语音 API Key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => { setKey(e.target.value); setConfirmed(false); }}
              placeholder={
                reusable ? "已保存 · 留空继续使用" : "粘贴所选地域的百炼密钥"
              }
            />
          </label>
          <p>
            {reusable
              ? "密钥已保存，不回填显示。"
              : "地域和业务空间必须与密钥匹配。"}{" "}
            费用和免费额度以服务商控制台为准，保存配置不会开启通话。
          </p>
          <fieldset className="live-trial-check">
            <legend>免费额度检查</legend>
            <p>在北京地域核对上方同一个模型：免费额度未过期，并已开启“免费额度用完即停”，等待配置生效。这里记录你核对的结果，不会替你开通或修改云端计费。</p>
            <p><a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">打开百炼控制台</a> · <a href="https://help.aliyun.com/zh/model-studio/new-free-quota" target="_blank" rel="noreferrer">免费额度与用完即停说明</a></p>
            {saved?.trial && <p>上次人工核对：{new Date(saved.trial.checkedAt).toLocaleString("zh-CN")}。仅保存配置不会延长这次检查的有效时间。</p>}
            <div className="interview-columns">
              <label>控制台显示的剩余免费 tokens<input type="number" min={1} step={1} value={remaining} onChange={(e) => { setRemaining(e.target.value); setConfirmed(false); }} placeholder="按控制台实际数字填写" /></label>
              <label>免费额度到期时间<input type="datetime-local" value={expires} onChange={(e) => { setExpires(e.target.value); setConfirmed(false); }} /></label>
            </div>
            <label className="live-consent"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>我已核对当前地域、空间和模型的免费额度，并确认云端“免费额度用完即停”已开启且生效。</span></label>
            <small>不支持用完即停、没有免费额度或检查超过 12 小时，均不开始试用。应用无法仅凭 API Key 自动确认账单和剩余额度；此记录不等于云端扣费保障。</small>
          </fieldset>
          <div className="interview-controls">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void save()}
            >
              保存 LIVE 配置
            </button>
            {saved?.hasKey && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                清除实时密钥
              </button>
            )}
          </div>
        </>
      ) : (
        <p>
          当前网页版从服务端读取 LIVE_API_KEY、LIVE_WORKSPACE、LIVE_REGION 和
          LIVE_MODEL。Windows 桌面版可在此直接填写并加密保存。
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
