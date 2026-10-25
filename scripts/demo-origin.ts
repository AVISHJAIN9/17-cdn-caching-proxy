import http from 'node:http';
import crypto from 'node:crypto';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 9090;

let totalRequests = 0;
const perPath: Record<string, number> = {};
let conditionalRequests = 0;
let counter = 0;

export interface RequestLogEntry {
  method: string;
  path: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  range?: string;
  timestamp: number;
}

export interface RevalState {
  version: number;
  cc: string;
  cc304: string;
  status: number;
  lm: string;
  etagMode: 'strong' | 'weak' | 'none';
  expires?: string;
  servedCount: number;
  delayMs?: number;
}

const requestLogs: RequestLogEntry[] = [];
const revalStates: Map<string, RevalState> = new Map();

export function getRevalState(id: string): RevalState {
  let state = revalStates.get(id);
  if (!state) {
    state = {
      version: 1,
      cc: 'max-age=60',
      cc304: 'max-age=60',
      status: 200,
      lm: 'Sat, 01 Jan 2000 00:00:00 GMT',
      etagMode: 'strong',
      servedCount: 0,
    };
    revalStates.set(id, state);
  }
  return state;
}

function matchesWeakEtag(reqInm: string, etag: string): boolean {
  if (reqInm.trim() === '*') return true;
  let ourOpaque = etag.trim();
  if (ourOpaque.startsWith('W/')) ourOpaque = ourOpaque.slice(2);
  if (ourOpaque.startsWith('"') && ourOpaque.endsWith('"')) {
    ourOpaque = ourOpaque.slice(1, -1);
  }

  const tags: string[] = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < reqInm.length; i++) {
    const ch = reqInm[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      if (cur.trim()) tags.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) tags.push(cur.trim());

  for (let tag of tags) {
    if (tag === '*') return true;
    if (tag.startsWith('W/')) tag = tag.slice(2);
    if (tag.startsWith('"') && tag.endsWith('"')) {
      tag = tag.slice(1, -1);
    }
    if (tag === ourOpaque) return true;
  }
  return false;
}

function matchesLastModified(reqIms: string, lm: string): boolean {
  const reqTime = Date.parse(reqIms);
  const lmTime = Date.parse(lm);
  if (isNaN(reqTime) || isNaN(lmTime)) return false;
  return lmTime <= reqTime;
}

export function resetStats(): void {
  totalRequests = 0;
  conditionalRequests = 0;
  for (const k of Object.keys(perPath)) {
    delete perPath[k];
  }
  counter = 0;
  requestLogs.length = 0;
  revalStates.clear();
}

export const originServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  console.log(`[origin] ${req.method} ${req.url}`);

  // GET /__stats returning JSON {totalRequests, perPath:{...}, conditionalRequests}
  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalRequests, perPath, conditionalRequests }));
    return;
  }

  // GET /__log: JSON array of all requests received since reset
  if (url.pathname === '/__log' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requestLogs));
    return;
  }

  // POST /__reset: zeroes all counters and logs
  if (url.pathname === '/__reset' && req.method === 'POST') {
    resetStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Record incoming upstream proxy request in log
  requestLogs.push({
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    ifNoneMatch: req.headers['if-none-match'] ? String(req.headers['if-none-match']) : undefined,
    ifModifiedSince: req.headers['if-modified-since'] ? String(req.headers['if-modified-since']) : undefined,
    range: req.headers['range'] ? String(req.headers['range']) : undefined,
    timestamp: Date.now(),
  });

  // Count incoming origin requests
  totalRequests++;
  perPath[url.pathname] = (perPath[url.pathname] || 0) + 1;
  if (req.headers['if-none-match'] !== undefined || req.headers['if-modified-since'] !== undefined) {
    conditionalRequests++;
  }

  // POST /__bump/:id
  const bumpMatch = url.pathname.match(/^\/__bump\/([^/]+)$/);
  if (bumpMatch && req.method === 'POST') {
    const id = bumpMatch[1];
    const state = getRevalState(id);
    state.version++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id, version: state.version }));
    return;
  }

  // POST /__config/:id
  const configMatch = url.pathname.match(/^\/__config\/([^/]+)$/);
  if (configMatch && req.method === 'POST') {
    const id = configMatch[1];
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const state = getRevalState(id);
        if (parsed.cc !== undefined) state.cc = parsed.cc;
        if (parsed.cc304 !== undefined) state.cc304 = parsed.cc304;
        else if (parsed.cc !== undefined) state.cc304 = parsed.cc;
        if (parsed.status !== undefined) state.status = parsed.status;
        if (parsed.lm !== undefined) state.lm = parsed.lm;
        if (parsed.etagMode !== undefined) state.etagMode = parsed.etagMode;
        if (parsed.expires !== undefined) state.expires = parsed.expires;
        if (parsed.delayMs !== undefined) state.delayMs = parsed.delayMs;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /reval-always-304
  if (url.pathname === '/reval-always-304' && req.method === 'GET') {
    res.writeHead(304, {
      'Date': new Date().toUTCString(),
      'Cache-Control': 'max-age=60',
      'ETag': '"always-304"',
    });
    res.end();
    return;
  }

  // GET /reval/:id or GET /reval-mismatch/:id
  const revalMatch = url.pathname.match(/^\/(reval|reval-mismatch)\/([^/]+)$/);
  if (revalMatch && req.method === 'GET') {
    const isMismatch = revalMatch[1] === 'reval-mismatch';
    const id = revalMatch[2];
    const cfg = getRevalState(id);
    const etag = cfg.etagMode === 'none' ? undefined : (cfg.etagMode === 'weak' ? `W/"${id}-v${cfg.version}"` : `"${id}-v${cfg.version}"`);
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];

    let is304 = false;
    if (cfg.status === 200) {
      if (typeof inm === 'string' && etag) {
        is304 = matchesWeakEtag(inm, etag);
      } else if (!inm && typeof ims === 'string' && cfg.lm) {
        is304 = matchesLastModified(ims, cfg.lm);
      }
    }

    const respond = () => {
      if (is304) {
        const respEtag = isMismatch ? `"other-${cfg.version}"` : etag;
        const headers: Record<string, string> = {
          'Cache-Control': cfg.cc304,
          'Date': new Date().toUTCString(),
          'Last-Modified': cfg.lm,
        };
        if (respEtag) headers['ETag'] = respEtag;
        if (cfg.expires) headers['Expires'] = cfg.expires;
        res.writeHead(304, headers);
        res.end();
        return;
      }

      cfg.servedCount++;
      const body = `id=${id} version=${cfg.version} count=${cfg.servedCount}\n`;
      const headers: Record<string, string> = {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body).toString(),
        'Cache-Control': cfg.cc,
        'Date': new Date().toUTCString(),
        'Last-Modified': cfg.lm,
      };
      if (etag) headers['ETag'] = etag;
      if (cfg.expires) headers['Expires'] = cfg.expires;
      res.writeHead(cfg.status, headers);
      res.end(body);
    };

    if (cfg.delayMs && cfg.delayMs > 0) {
      setTimeout(respond, cfg.delayMs);
    } else {
      respond();
    }
    return;
  }

  // GET /cc : returns incrementing counter body, configures response headers from query params
  if (url.pathname === '/cc') {
    counter++;
    const ccParam = url.searchParams.get('cc');
    const expiresParam = url.searchParams.get('expires');
    const ageParam = url.searchParams.get('age');
    const dateParam = url.searchParams.get('date');
    const statusParam = url.searchParams.get('status');

    const statusCode = statusParam ? parseInt(statusParam, 10) : 200;

    res.setHeader('Content-Type', 'text/plain');

    if (ccParam !== null) {
      res.setHeader('Cache-Control', ccParam);
    }
    if (expiresParam !== null) {
      res.setHeader('Expires', expiresParam);
    }
    if (ageParam !== null) {
      res.setHeader('Age', ageParam);
    }
    if (dateParam === 'none') {
      res.sendDate = false;
    } else if (dateParam !== null) {
      res.setHeader('Date', dateParam);
    }

    res.writeHead(statusCode);
    res.end(`${counter}`);
    return;
  }

  // GET /cc-multi : sends TWO separate Cache-Control header lines
  if (url.pathname === '/cc-multi') {
    counter++;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', ['max-age=60', 'no-store']);
    res.writeHead(200);
    res.end(`${counter}`);
    return;
  }

  // GET /validators : incrementing counter body; sets headers EXACTLY as given from query params
  if (url.pathname === '/validators') {
    counter++;
    const etagParams = url.searchParams.getAll('etag');
    const lmParams = url.searchParams.getAll('lm');
    const ccParam = url.searchParams.get('cc');
    const expiresParam = url.searchParams.get('expires');
    const dateParam = url.searchParams.get('date');
    const statusParam = url.searchParams.get('status');
    const origin304Param = url.searchParams.get('origin304');

    if (dateParam === 'none') {
      res.sendDate = false;
    } else if (dateParam === 'multi') {
      res.setHeader('Date', ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 09:49:37 GMT']);
    } else if (dateParam !== null) {
      res.setHeader('Date', dateParam);
    }

    if (etagParams.length > 1) {
      res.setHeader('ETag', etagParams);
    } else if (etagParams.length === 1) {
      res.setHeader('ETag', etagParams[0]);
    }

    if (lmParams.length > 1) {
      res.setHeader('Last-Modified', lmParams);
    } else if (lmParams.length === 1) {
      res.setHeader('Last-Modified', lmParams[0]);
    }

    if (ccParam !== null) {
      res.setHeader('Cache-Control', ccParam);
    }
    if (expiresParam !== null) {
      res.setHeader('Expires', expiresParam);
    }

    const firstEtag = etagParams[0];
    if (
      origin304Param === '1' &&
      firstEtag !== undefined &&
      req.headers['if-none-match'] === firstEtag
    ) {
      res.writeHead(304);
      res.end();
      return;
    }

    const statusCode = statusParam ? parseInt(statusParam, 10) : 200;
    const bodyStr = `${counter}`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Length', Buffer.byteLength(bodyStr).toString());
    res.writeHead(statusCode);
    res.end(bodyStr);
    return;
  }

  // GET /validators-multi : sends TWO ETag header lines and TWO Last-Modified header lines
  if (url.pathname === '/validators-multi') {
    counter++;
    const bodyStr = `${counter}`;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Length', Buffer.byteLength(bodyStr).toString());
    res.setHeader('ETag', ['"v1"', '"v2"']);
    res.setHeader('Last-Modified', ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 09:49:37 GMT']);
    res.setHeader('Cache-Control', 'max-age=60');
    res.writeHead(200);
    res.end(bodyStr);
    return;
  }

  if (url.pathname === '/counter') {
    counter++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/counter-private') {
    counter++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'private, max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/counter-nostore') {
    counter++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store, max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/counter-cookie') {
    counter++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'sid=1',
      'Cache-Control': 'max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/counter-vary') {
    counter++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      Vary: 'Accept-Language',
      'Cache-Control': 'max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/counter-nocache') {
    counter++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-cache, max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/counter-404') {
    counter++;
    res.writeHead(404, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'max-age=60',
    });
    res.end(`${counter}`);
    return;
  }

  if (url.pathname === '/large-1mb') {
    const size = 1024 * 1024;
    const buf = Buffer.alloc(size, 'M');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size.toString(),
      'Cache-Control': 'max-age=60',
    });
    res.end(buf);
    return;
  }

  // 1. /stream?chunks=N&delayMs=M : sends N chunks, M ms apart, using chunked transfer
  if (url.pathname === '/stream') {
    const chunks = parseInt(url.searchParams.get('chunks') ?? '5', 10);
    const delayMs = parseInt(url.searchParams.get('delayMs') ?? '200', 10);

    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    let sent = 0;
    const interval = setInterval(() => {
      sent++;
      res.write(`chunk-${sent}\n`);
      if (sent >= chunks) {
        clearInterval(interval);
        res.end();
      }
    }, delayMs);

    req.on('close', () => {
      clearInterval(interval);
    });
    return;
  }

  // 2. /stall-after-headers : sends status + headers, then never sends a body
  if (url.pathname === '/stall-after-headers') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });
    res.flushHeaders();
    // Never send body
    return;
  }

  // 3. /abort-midbody : sends some body bytes, then destroys the socket
  if (url.pathname === '/abort-midbody') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Transfer-Encoding': 'chunked',
    });
    res.write('start-of-body-data...');
    setTimeout(() => {
      req.socket.destroy();
    }, 50);
    return;
  }

  // 4. /never-respond : accepts the request and never replies
  if (url.pathname === '/never-respond') {
    // Keep connection open without writing anything
    return;
  }

  // 5. /close-after-response : replies, then destroys its socket right after
  if (url.pathname === '/close-after-response') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Connection': 'keep-alive',
    });
    res.write('response-before-close\n');
    res.end();
    res.on('finish', () => {
      setTimeout(() => {
        req.socket.destroy();
      }, 10);
    });
    return;
  }

  // 6. /big?mb=N : N megabytes, generated on the fly (never held in memory)
  if (url.pathname === '/big') {
    const mb = parseInt(url.searchParams.get('mb') ?? '1', 10);
    const totalBytes = mb * 1024 * 1024;
    const chunkSize = 64 * 1024; // 64 KB
    const patternChunk = Buffer.alloc(chunkSize, 'x');

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': totalBytes,
    });

    let bytesSent = 0;
    let isClosed = false;

    req.on('close', () => {
      isClosed = true;
      req.socket?.destroy();
    });

    function sendChunks() {
      if (isClosed) return;
      while (bytesSent < totalBytes && !isClosed) {
        const remaining = totalBytes - bytesSent;
        const currentChunkSize = Math.min(chunkSize, remaining);
        const chunk = currentChunkSize === chunkSize ? patternChunk : patternChunk.subarray(0, currentChunkSize);
        bytesSent += currentChunkSize;
        const canContinue = res.write(chunk);
        if (!canContinue) {
          res.once('drain', sendChunks);
          return;
        }
      }
      if (!isClosed) {
        res.end();
      }
    }

    sendChunks();
    return;
  }

  // 7. /redirect : returns 302 with a Location header
  if (url.pathname === '/redirect') {
    res.writeHead(302, {
      Location: '/hello',
      'Content-Type': 'text/plain',
    });
    res.end('Redirecting to /hello\n');
    return;
  }

  // 8. /head-check : behaves differently for HEAD vs GET
  if (url.pathname === '/head-check') {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': '42',
        'X-Head-Check': 'is-head',
      });
      res.end();
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Head-Check': 'is-get',
      });
      res.end('this is get\n');
    }
    return;
  }

  if (url.pathname === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello from origin!\n');
    return;
  }

  if (url.pathname === '/a/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Hello from /a/hello! Query: ${url.search}\n`);
    return;
  }

  if (url.pathname === '/echo-headers') {
    let bodyData = '';
    req.on('data', (chunk) => {
      bodyData += chunk.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            method: req.method,
            headers: req.headers,
            body: bodyData,
          },
          null,
          2
        ) + '\n'
      );
    });
    return;
  }

  if (url.pathname.startsWith('/blob-100k-')) {
    const size = 100 * 1024;
    const buf = Buffer.alloc(size, 'x');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size.toString(),
    });
    res.end(buf);
    return;
  }

  if (url.pathname.startsWith('/catalog/') || url.pathname.startsWith('/api/')) {
    const etag = `"item-${crypto.createHash('md5').update(url.pathname).digest('hex').slice(0, 8)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        'Cache-Control': 'public, max-age=120',
        'ETag': etag,
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120',
      'ETag': etag,
    });
    res.end(JSON.stringify({ item: url.pathname, timestamp: Date.now() }));
    return;
  }

  if (url.pathname === '/status/500') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error from origin\n');
    return;
  }

  if (url.pathname.startsWith('/status/')) {
    const code = parseInt(url.pathname.slice(8), 10);
    res.writeHead(isNaN(code) ? 500 : code, { 'Content-Type': 'text/plain' });
    res.end(`Origin Status ${code}\n`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found at origin\n');
});

if (process.argv[1]?.endsWith('demo-origin.ts') || process.argv[1]?.endsWith('demo-origin.js')) {
  originServer.listen(port, () => {
    console.log(`[demo-origin] listening on port ${port}`);
  });
}
