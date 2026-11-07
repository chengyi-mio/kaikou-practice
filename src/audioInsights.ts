export type Pause = { start: number; duration: number };

/** Approximate low-volume gaps between speech regions. No audio leaves this device. */
export async function findPauses(blob: Blob): Promise<Pause[]> {
  const AudioContextType = window.AudioContext;
  if (!AudioContextType) return [];
  const context = new AudioContextType();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const step = Math.max(1, Math.round(buffer.sampleRate * 0.05));
    const levels: number[] = [];
    for (let offset = 0; offset < samples.length; offset += step) {
      let power = 0;
      const end = Math.min(samples.length, offset + step);
      for (let i = offset; i < end; i++) power += samples[i] * samples[i];
      levels.push(Math.sqrt(power / (end - offset)));
    }
    const peak = Math.max(...levels, 0);
    if (peak < 0.008) return [];
    const threshold = Math.max(0.008, peak * 0.13);
    const speaking = levels.map((level) => level >= threshold);
    const first = speaking.indexOf(true);
    const last = speaking.lastIndexOf(true);
    const gaps: Pause[] = [];
    let start = -1;
    for (let i = first + 1; i <= last; i++) {
      if (!speaking[i] && start < 0) start = i;
      if (speaking[i] && start >= 0) {
        const duration = (i - start) * 0.05;
        if (duration >= 0.8) gaps.push({ start: Math.round(start * 0.05 * 10) / 10, duration: Math.round(duration * 10) / 10 });
        start = -1;
      }
    }
    return gaps.slice(0, 12);
  } finally {
    await context.close();
  }
}
