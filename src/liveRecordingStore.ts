import { fixWebmDuration } from '@fix-webm-duration/fix';
export type LiveRecording = {
  id: string;
  roundId: string;
  role: string;
  createdAt: string;
  mimeType: string;
  duration: number;
  bytes: number;
  status: 'recording' | 'saved' | 'interrupted';
};
type Chunk = { recordingId: string; index: number; blob: Blob };
let pending: Promise<IDBDatabase> | undefined;
function database() {
  if (!pending) pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('kaikou-live-recordings', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('recordings', { keyPath: 'id' });
      request.result.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); pending = undefined; };
      resolve(db);
    };
    request.onerror = () => { pending = undefined; reject(Error('无法打开本机录音存储，请检查存储空间和权限。')); };
    request.onblocked = () => { pending = undefined; reject(Error('录音存储被其他窗口占用，请关闭其他窗口后重试。')); };
  }).catch(error => { pending = undefined; throw error; });
  return pending;
}
const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
async function write(run: (tx: IDBTransaction) => void) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['recordings', 'chunks'], 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(Error('录音保存失败，请检查本机存储空间；当前页面仍保留临时副本。'));
    try { run(tx); } catch (error) { tx.abort(); reject(error); }
  });
}
export async function saveRecordingMetadata(record: LiveRecording) {
  await write(tx => { tx.objectStore('recordings').put(record); });
}
export async function appendRecordingChunk(record: LiveRecording, index: number, blob: Blob) {
  await write(tx => {
    tx.objectStore('chunks').put({ recordingId: record.id, index, blob });
    tx.objectStore('recordings').put(record);
  });
}
// Retrying replaces only this recording, atomically, including its first container chunk.
export async function restoreRecording(record: LiveRecording, blobs: Blob[]) {
  await write(tx => {
    tx.objectStore('chunks').delete(range(record.id));
    blobs.forEach((blob, index) => tx.objectStore('chunks').put({ recordingId: record.id, index, blob }));
    tx.objectStore('recordings').put(record);
  });
  window.dispatchEvent(new Event('kaikou-live-recordings-changed'));
}
export async function deleteRecording(id: string) {
  await write(tx => {
    tx.objectStore('chunks').delete(range(id));
    tx.objectStore('recordings').delete(id);
  });
  window.dispatchEvent(new Event('kaikou-live-recordings-changed'));
}
export async function listRecordings(): Promise<LiveRecording[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('recordings').objectStore('recordings').getAll();
    request.onsuccess = () => resolve((request.result as LiveRecording[]).filter(r => r.bytes > 0).sort((a,b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(Error('无法读取本机录音，请重试。'));
  });
}
export async function recordingBlob(record: LiveRecording): Promise<Blob> {
  const db = await database();
  const blob = await new Promise<Blob>((resolve, reject) => {
    const request = db.transaction('chunks').objectStore('chunks').getAll(range(record.id));
    request.onsuccess = () => {
      const chunks = request.result as Chunk[];
      if (!chunks.length || chunks[0].index !== 0 || chunks.some((c,i) => c.index !== i)) { reject(Error('录音片段不完整，无法回放。')); return; }
      resolve(new Blob(chunks.map(c => c.blob), { type: record.mimeType }));
    };
    request.onerror = () => reject(Error('录音读取失败，请重试。'));
  });
  return playableRecordingBlob(blob, record);
}
export async function playableRecordingBlob(blob: Blob, record: LiveRecording) {
  return record.mimeType.includes('webm') && record.duration > 0
    ? await fixWebmDuration(blob, record.duration * 1000, {logger: false}) : blob;
}
export function recordingFilename(record: LiveRecording) {
  const role = record.role.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0,40) || '模拟面试';
  return `LIVE-${role}-${record.createdAt.replace(/[:.]/g,'-')}-${record.id.slice(0,8)}.${record.mimeType.includes('mp4') ? 'm4a' : 'webm'}`;
}
