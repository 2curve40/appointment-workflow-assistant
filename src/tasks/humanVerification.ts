class HumanVerificationRegistry {
  private readonly waiters = new Map<string, () => void>();
  private readonly pendingResumes = new Set<string>();

  async wait(taskId: string, signal?: AbortSignal): Promise<void> {
    if (this.pendingResumes.delete(taskId)) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (this.waiters.get(taskId) === wrappedResolve) {
          this.waiters.delete(taskId);
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const wrappedResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", cleanup);
        resolve();
      };
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", cleanup, { once: true });
      this.waiters.set(taskId, wrappedResolve);
    });
  }

  resume(taskId: string): boolean {
    const resolve = this.waiters.get(taskId);
    if (!resolve) {
      this.pendingResumes.add(taskId);
      return false;
    }

    this.waiters.delete(taskId);
    resolve();
    return true;
  }

  isWaiting(taskId: string): boolean {
    return this.waiters.has(taskId);
  }

  clearPending(taskId: string): void {
    this.pendingResumes.delete(taskId);
  }
}

export const humanVerificationRegistry = new HumanVerificationRegistry();
