export type LiveHealth = { kind: 'network' | 'response' | 'transcription' | 'channel'; level: 'warning' | 'stalled'; message: string; recoverable: boolean };
export const LIVE_HEALTH_LIMITS: Readonly<Record<'responseWarning'|'responsePause'|'transcriptionWarning'|'transcriptionPause'|'unacknowledgedWarning'|'unacknowledgedPause', number>>;
export class LiveHealthMonitor {
  responseRequested(now: number): void;
  responseProgress(now: number): void;
  responseEnded(): void;
  speechStarted(id: string | undefined, now: number): void;
  speechStopped(id: string | undefined, now: number): void;
  transcriptionCompleted(id: string | undefined): void;
  transcriptionProgress(id: string | undefined, now: number): void;
  transcriptionFailed(id: string | undefined, now: number): void;
  microphoneMuted(): void;
  observeStats(report: RTCStatsReport, now: number, microphoneEnabled: boolean): void;
  check(now: number, silence?: number): (LiveHealth & {pause: boolean}) | null;
}
