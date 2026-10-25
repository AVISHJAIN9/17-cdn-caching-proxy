import fs from 'node:fs';
import path from 'node:path';

export interface CertWatcherOptions {
  debounceMs?: number;
  onError?: (err: Error) => void;
  onReload?: () => void | Promise<void>;
}

/**
 * Robust, leak-free file watcher for certificate and key files.
 * Watches parent directories and files with debouncing to handle
 * atomic file replacements (write-temp-and-rename) as well as direct writes.
 */
export class CertificateFileWatcher {
  private closed = false;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer?: NodeJS.Timeout;
  private readonly filePaths: string[] = [];

  constructor(
    paths: (string | undefined | null)[],
    private readonly options: CertWatcherOptions = {}
  ) {
    for (const p of paths) {
      if (p && typeof p === 'string') {
        const resolved = path.resolve(p);
        if (!this.filePaths.includes(resolved)) {
          this.filePaths.push(resolved);
        }
      }
    }

    this.start();
  }

  private start(): void {
    if (this.filePaths.length === 0 || this.closed) return;

    const dirs = new Set<string>();
    const fileBasenames = new Set<string>();

    for (const filePath of this.filePaths) {
      dirs.add(path.dirname(filePath));
      fileBasenames.add(path.basename(filePath));
    }

    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;

        const watcher = fs.watch(dir, (eventType, filename) => {
          if (this.closed) return;
          // If filename is missing (some OSes) or matches any watched file basename
          if (!filename || fileBasenames.has(filename)) {
            this.scheduleReload();
          }
        });

        if (typeof (watcher as any).unref === 'function') {
          (watcher as any).unref();
        }

        this.watchers.push(watcher);
      } catch (err: any) {
        if (this.options.onError) {
          this.options.onError(err);
        }
      }
    }
  }

  private scheduleReload(): void {
    if (this.closed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    const debounceMs = this.options.debounceMs ?? 100;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.closed) return;
      void this.triggerReload();
    }, debounceMs);

    if (this.debounceTimer.unref) {
      this.debounceTimer.unref();
    }
  }

  public async triggerReload(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.options.onReload) {
        await this.options.onReload();
      }
    } catch (err: any) {
      if (this.options.onError) {
        this.options.onError(err);
      }
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore errors during cleanup
      }
    }
    this.watchers = [];
  }
}
