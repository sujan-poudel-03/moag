// ─── Dynamic task queue for uninterrupted playlist execution ───
// Replaces the static index-walk with a live dequeue model.
// Callers can inject repair/follow-up tasks mid-run via injectNext().

import { Task } from '../models/types';
import type { Playlist } from '../models/types';

export interface QueueEntry {
  task: Task;
  playlist: Playlist;
  /** true = synthetically injected at runtime (auto-repair, follow-up) */
  synthetic: boolean;
  /** How many times this task (or its original) has been through the repair cycle */
  repairCycle: number;
}

export class TaskQueue {
  private _items: QueueEntry[] = [];

  enqueueAll(tasks: Task[], playlist: Playlist): void {
    for (const task of tasks) {
      this._items.push({ task, playlist, synthetic: false, repairCycle: 0 });
    }
  }

  dequeue(): QueueEntry | undefined {
    return this._items.shift();
  }

  peek(): QueueEntry | undefined {
    return this._items[0];
  }

  /** Insert a task to run immediately after the currently-running one. */
  injectNext(task: Task, playlist: Playlist, repairCycle: number): void {
    this._items.unshift({ task, playlist, synthetic: true, repairCycle });
  }

  get isEmpty(): boolean {
    return this._items.length === 0;
  }

  get size(): number {
    return this._items.length;
  }

  clear(): void {
    this._items = [];
  }
}
