/**
 * Revalidation Locking per-key mechanism.
 * Ensures only one revalidation (synchronous or background) runs at a time for a given cache key.
 */

export interface LockOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LockHandle {
  readonly key: string;
  release: () => void;
}

interface ActiveLock {
  key: string;
  timeoutId?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
  release: () => void;
}

export class RevalidationLockManager {
  private locks = new Map<string, ActiveLock>();

  get activeLocksCount(): number {
    return this.locks.size;
  }

  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /**
   * Attempts to acquire a lock for the given cache key.
   * Returns a LockHandle if acquired, or null if already locked.
   */
  tryAcquire(key: string, options: LockOptions = {}): LockHandle | null {
    if (this.locks.has(key)) {
      return null;
    }

    let released = false;

    const release = () => {
      if (released) return;
      released = true;

      const active = this.locks.get(key);
      if (active) {
        if (active.timeoutId) {
          clearTimeout(active.timeoutId);
        }
        if (active.signal && active.abortListener) {
          active.signal.removeEventListener('abort', active.abortListener);
        }
        this.locks.delete(key);
      }
    };

    const activeLock: ActiveLock = {
      key,
      release,
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      activeLock.timeoutId = setTimeout(() => {
        release();
      }, options.timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        return null;
      }
      activeLock.signal = options.signal;
      activeLock.abortListener = () => {
        release();
      };
      options.signal.addEventListener('abort', activeLock.abortListener, { once: true });
    }

    this.locks.set(key, activeLock);

    return {
      key,
      release,
    };
  }

  /**
   * Executes a task under a per-key lock.
   * Throws if lock cannot be acquired or if fn throws.
   * Lock is guaranteed to be released on success or failure.
   */
  async withLock<T>(key: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
    const handle = this.tryAcquire(key, options);
    if (!handle) {
      throw new Error(`Revalidation lock already held for key ${key}`);
    }

    try {
      return await fn();
    } finally {
      handle.release();
    }
  }

  clear(): void {
    for (const lock of this.locks.values()) {
      if (lock.timeoutId) clearTimeout(lock.timeoutId);
      if (lock.signal && lock.abortListener) {
        lock.signal.removeEventListener('abort', lock.abortListener);
      }
    }
    this.locks.clear();
  }
}
