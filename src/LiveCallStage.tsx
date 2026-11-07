import { Headset, Microphone, MicrophoneSlash, UserCircle } from '@phosphor-icons/react';
import type { LiveState } from './useLiveInterview';
export function LiveCallStage({state,label,muted,elapsed,limit,role,question}:{state:LiveState;label:string;muted:boolean;elapsed:string;limit:string;role:string;question:string}) {
  const listening=state==='listening', speaking=state==='speaking';
  return <div className="live-call-room" aria-label="LIVE 语音面试现场">
    <div className="live-room-top"><span><i className={listening||speaking||state==='thinking'?'is-connected':''}/>{label}</span><span className="live-clock">{elapsed}<small> / {limit}</small></span></div>
    <div className="live-room-people">
      <div className={`live-interviewer-seat ${speaking?'is-speaking':''}`}>
        <div className="live-interviewer-avatar"><Headset size={70} weight="duotone" aria-hidden="true"/></div>
        <h3>AI 面试官</h3><p>千问实时语音 · {role || '岗位模拟面试'}</p>
        <span className="live-speaking-status">{speaking?'正在提问，请听完后回答':state==='thinking'?'正在整理你的回答，准备追问':listening?'正在认真听你的回答':state==='ended'?'本轮通话已结束':state==='error'?'连接中断，已收到的文字保留':state==='connecting'?'正在接通面试官':'准备好后，面试官会先开口'}</span>
      </div>
      <div className={`live-candidate-seat ${listening&&!muted?'is-listening':''}`}>
        <UserCircle size={50} weight="duotone" aria-hidden="true"/><h3>你</h3>
        <p>{muted?<MicrophoneSlash size={20} aria-hidden="true"/>:<Microphone size={20} aria-hidden="true"/>}{muted?'麦克风已静音；通话仍在计时':listening?'轮到你了，自然地说就好':'仅语音 · 不启用摄像头'}</p>
        <small>可以停下来思考，也可以请面试官再说一遍。</small>
      </div>
    </div>
    <div className="live-current-question"><strong>当前问题</strong><p>{question ? `面试官：${question}` : '接通后，面试官会结合你的简历和岗位要求提问。'}</p></div>
  </div>;
}
