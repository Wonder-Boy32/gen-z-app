import { useSyncExternalStore } from 'react';
import { showLocalNotification } from './push';

/**
 * uploadManager — lets an upload outlive the screen that started it.
 *
 * WHY: posting used to hold the user on a spinner inside the create wizard until
 * every byte had landed. The work does not actually need the user's attention,
 * so it is moved off the screen: the wizard closes immediately, the user is back
 * on the feed, and this module reports progress in an ambient bar at the bottom
 * of the app plus a notification when the post is live.
 *
 * A module-level store is deliberate. The screen that calls startUploadJob() is
 * unmounted moments later, so the job cannot live in component state — and
 * anything rendered anywhere can subscribe.
 */

export type UploadStatus = 'running' | 'done' | 'error';

export type UploadJob = {
  id: string;
  label: string;
  /** short human line under the label, e.g. "Uploading 2 of 4" */
  detail: string;
  /** 0..1 */
  progress: number;
  status: UploadStatus;
  error?: string;
};

/** reporter passed to a job so it can publish progress */
export type UploadReport = (progress: number, detail?: string) => void;

let jobs: UploadJob[] = [];
const listeners = new Set<() => void>();

/** Replaces the array (never mutates) so useSyncExternalStore sees a new value. */
function emit() {
  jobs = [...jobs];
  for (const l of listeners) l();
}

export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUploads(): UploadJob[] {
  return jobs;
}

/** Subscribe to the upload queue from a component. */
export function useUploads(): UploadJob[] {
  return useSyncExternalStore(subscribeUploads, getUploads, getUploads);
}

function patch(id: string, next: Partial<UploadJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...next } : j));
  for (const l of listeners) l();
}

export function removeJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  for (const l of listeners) l();
}

let seq = 0;

/**
 * Run `work` in the background and track it.
 *
 * `work` receives a reporter; call it with 0..1 as the job advances. Throwing
 * from `work` marks the job failed — the message is shown in the bar, so work
 * implementations should throw something with a readable `.message`.
 */
export function startUploadJob(opts: {
  label: string;
  detail?: string;
  work: (report: UploadReport) => Promise<void>;
  /** notification text once it succeeds */
  doneTitle?: string;
  doneBody?: string;
}): string {
  const id = `up-${Date.now()}-${seq++}`;

  jobs = [
    ...jobs,
    {
      id,
      label: opts.label,
      detail: opts.detail ?? 'Starting…',
      progress: 0,
      status: 'running',
    },
  ];
  for (const l of listeners) l();

  const report: UploadReport = (progress, detail) => {
    const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    // Never let a late report drag the bar backwards — a bar that jumps back
    // reads as "something went wrong".
    const current = jobs.find((j) => j.id === id);
    if (!current || current.status !== 'running') return;
    patch(id, { progress: Math.max(current.progress, p), ...(detail ? { detail } : null) });
  };

  void (async () => {
    try {
      await opts.work(report);
      patch(id, { progress: 1, status: 'done', detail: 'Uploaded' });
      // The user is somewhere else in the app by now, so a real notification is
      // how they find out — the ambient bar alone is easy to miss.
      void showLocalNotification({
        type: 'upload',
        title: opts.doneTitle ?? 'Post successfully uploaded',
        body: opts.doneBody ?? 'Your drop is live. Go see it.',
      });
      setTimeout(() => removeJob(id), 6000);
    } catch (e: any) {
      const msg =
        typeof e?.message === 'string' && e.message.trim() ? e.message : 'Upload failed — try again.';
      patch(id, { status: 'error', error: msg, detail: 'Failed' });
      setTimeout(() => removeJob(id), 12000);
    }
  })();

  return id;
}
