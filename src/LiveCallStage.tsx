import { MicrophoneSlash, SpeakerHigh, SpeakerSlash, Waveform } from '@phosphor-icons/react';
import type { LiveState } from './useLiveInterview';
export function LiveCallStage({state,label,muted,question,playbackVolume,healthMessage}:{state:LiveState;label:string;muted:boolean;question:string;playbackVolume:number;healthMessage?:string}) {
  const listening = state === 'listening', speaking = state === 'speaking';
  const animated = !healthMessage && (speaking || (listening && !muted));
  const status = healthMessage || (muted ? '麦克风已静音；通话仍在计时'
    : speaking ? '正在提问，请听完后回答'
    : state === 'thinking' ? '正在整理你的回答，准备追问'
    : listening ? '正在聆听你的回答'
    : state === 'ended' ? '本轮通话已结束'
    : state === 'error' ? '连接中断，已收到的文字保留'
    : state === 'connecting' ? '正在接通面试官'
    : '准备好后，面试官会先开口');
  return <div className={`live-call-room live-focus-stage ${animated ? 'is-voice-active' : ''}`} data-state={state} aria-label="LIVE 语音面试现场">
    <div className="live-focus-heading">
      <h3><Waveform size={24} aria-hidden="true"/>AI 面试官</h3>
      <span aria-label={playbackVolume === 0 ? '面试官播放已静音' : '面试官播放声音开启'} title={playbackVolume === 0 ? '面试官播放已静音，通话录音不受影响' : '通过下方声音按钮调整播放音量'}>
        {playbackVolume === 0 ? <SpeakerSlash size={23} aria-hidden="true"/> : <SpeakerHigh size={23} aria-hidden="true"/>}
      </span>
    </div>
    <div className="live-focus-content">
      <div className="live-state-wave" aria-hidden="true">
        {[8, 12, 18, 25, 18, 34, 45, 34, 57, 73, 49, 92, 72, 56, 68, 42, 52, 29, 37, 23, 17, 10, 7].map((height, index) => <span key={index} style={{height: `${height}px`, animationDelay: `${index * -0.09}s`}}/>)}
      </div>
      <div className="live-current-question"><p>{question || '接通后，面试官会结合你的简历和岗位要求提问。'}</p></div>
      <p className="live-focus-status" role="status" aria-label={healthMessage || label}>
        {muted ? <MicrophoneSlash size={19} aria-hidden="true"/> : <Waveform size={19} aria-hidden="true"/>}{status}
      </p>
    </div>
  </div>;
}
