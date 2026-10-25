import http from 'node:http';
import net from 'node:net';

export interface ControllableOriginConfig {
  latencyMs?: number;
  failureRate?: number; // 0.0 to 1.0 (500 Internal Server Error)
  flappingIntervalMs?: number;
}

export class ControllableOrigin {
  private server?: http.Server;
  public requestCount: number = 0;
  public config: ControllableOriginConfig;
  private isUp = true;

  constructor(config: ControllableOriginConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 0,
      failureRate: config.failureRate ?? 0,
      flappingIntervalMs: config.flappingIntervalMs ?? 0,
    };
  }

  public async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.requestCount++;

      // Flapping simulation
      if (!this.isUp) {
        req.socket.destroy();
        return;
      }

      // Failure injection
      if (this.config.failureRate && Math.random() < this.config.failureRate) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Origin injected fault');
        return;
      }

      const finish = () => {
        if (req.url === '/large') {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'public, max-age=60',
          });
          // Stream 100 chunks without buffering in memory
          for (let i = 0; i < 50; i++) {
            res.write(Buffer.alloc(1024, 0x41));
          }
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=60',
          ETag: '"v1"',
        });
        res.end('origin-payload');
      };

      if (this.config.latencyMs && this.config.latencyMs > 0) {
        setTimeout(finish, this.config.latencyMs);
      } else {
        finish();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = this.server.address() as net.AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  public setFlapping(isUp: boolean): void {
    this.isUp = isUp;
  }

  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}
