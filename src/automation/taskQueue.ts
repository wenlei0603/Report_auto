import type { RequestTask } from "../domain/types.js";

interface Lease {
  accountId: string;
  task: RequestTask;
}

export class TaskQueue {
  private readonly pending: RequestTask[];
  private readonly inFlight = new Map<string, Lease>();
  private readonly completed = new Set<string>();

  constructor(tasks: RequestTask[]) {
    this.pending = [...tasks];
  }

  get remainingCount(): number {
    return this.pending.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  leaseNext(accountId: string): RequestTask | undefined {
    while (this.pending.length > 0) {
      const task = this.pending.shift()!;
      if (this.completed.has(task.taskId) || this.inFlight.has(task.taskId)) {
        continue;
      }
      this.inFlight.set(task.taskId, { accountId, task });
      return task;
    }
    return undefined;
  }

  complete(taskId: string): void {
    this.inFlight.delete(taskId);
    this.completed.add(taskId);
  }

  release(taskId: string): void {
    const lease = this.inFlight.get(taskId);
    if (!lease) {
      return;
    }
    this.inFlight.delete(taskId);
    this.pending.unshift(lease.task);
  }
}
