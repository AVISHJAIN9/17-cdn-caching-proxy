import net from 'node:net';

export interface RawResponse {
  raw: Buffer;
  text: string;
  socketClosed: boolean;
  statusCode?: number;
  statusLine?: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export interface RawRequestOptions {
  host?: string;
  timeoutMs?: number;
  waitForCloseMs?: number;
}

function parseHttpRaw(raw: Buffer): {
  statusCode?: number;
  statusLine?: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
} {
  const headerEndIndex = raw.indexOf('\r\n\r\n');
  const lfEndIndex = raw.indexOf('\n\n');
  let splitIndex = -1;
  let delimLen = 4;

  if (headerEndIndex !== -1 && (lfEndIndex === -1 || headerEndIndex <= lfEndIndex)) {
    splitIndex = headerEndIndex;
    delimLen = 4;
  } else if (lfEndIndex !== -1) {
    splitIndex = lfEndIndex;
    delimLen = 2;
  }

  if (splitIndex === -1) {
    // No headers delimiter found (could be non-HTTP or incomplete)
    return {
      headers: {},
      body: raw,
    };
  }

  const headerPart = raw.subarray(0, splitIndex).toString('utf-8');
  const body = raw.subarray(splitIndex + delimLen);
  const lines = headerPart.split(/\r?\n/);
  const statusLine = lines[0] ?? '';

  let statusCode: number | undefined;
  const statusMatch = statusLine.match(/HTTP\/[0-9.]+\s+([0-9]{3})/i);
  if (statusMatch) {
    statusCode = parseInt(statusMatch[1], 10);
  }

  const headers: Record<string, string | string[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const name = line.substring(0, colonIdx).trim().toLowerCase();
    const val = line.substring(colonIdx + 1).trim();

    if (name === 'set-cookie') {
      const existing = headers[name];
      if (Array.isArray(existing)) {
        existing.push(val);
      } else if (typeof existing === 'string') {
        headers[name] = [existing, val];
      } else {
        headers[name] = [val];
      }
    } else {
      const existing = headers[name];
      if (existing !== undefined) {
        if (Array.isArray(existing)) {
          existing.push(val);
        } else {
          headers[name] = `${existing}, ${val}`;
        }
      } else {
        headers[name] = val;
      }
    }
  }

  return {
    statusCode,
    statusLine,
    headers,
    body,
  };
}

/**
 * Opens a plain TCP socket, writes exact bytes (for malformed or pipelined requests),
 * and returns the raw bytes received plus whether the socket was closed by the server.
 */
export function rawRequest(
  port: number,
  bytes: Buffer | string,
  options: RawRequestOptions = {}
): Promise<RawResponse> {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 3000;
  const waitForCloseMs = options.waitForCloseMs ?? 150;

  return new Promise<RawResponse>((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let socketClosed = false;
    let timer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
    };

    const finish = () => {
      cleanup();
      if (!socket.destroyed) {
        socket.destroy();
      }
      const raw = Buffer.concat(chunks);
      const parsed = parseHttpRaw(raw);
      resolve({
        raw,
        text: raw.toString('utf-8'),
        socketClosed,
        statusCode: parsed.statusCode,
        statusLine: parsed.statusLine,
        headers: parsed.headers,
        body: parsed.body,
      });
    };

    timer = setTimeout(() => {
      finish();
    }, timeoutMs);

    socket.connect(port, host, () => {
      socket.write(bytes);
    });

    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

      // Reset idle timer after receiving data:
      // If the server doesn't close the socket (e.g. keep-alive or HTTP/1.1 response complete),
      // we finish after waitForCloseMs of silence following data.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish();
      }, waitForCloseMs);
    });

    socket.on('close', () => {
      socketClosed = true;
      finish();
    });

    socket.on('end', () => {
      socketClosed = true;
      finish();
    });

    socket.on('error', (_err) => {
      // In tests sending malformed bytes or expecting immediate reset,
      // connection resets or errors are treated as socket closure
      socketClosed = true;
      finish();
    });
  });
}
