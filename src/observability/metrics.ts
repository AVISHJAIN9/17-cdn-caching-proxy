export interface MetricLabels {
  status?: 'fresh' | 'stale' | 'coalesced' | string;
  reason?: 'miss' | 'bypass' | 'revalidated_304' | string;
  source?: 'cache' | 'origin' | string;
  method?: string;
  status_code?: string | number;
  tenant?: string;
  [key: string]: string | number | undefined;
}

const MAX_TENANTS = 100;
const MAX_TENANT_LEN = 64;

/**
 * Escapes label values according to Prometheus text exposition format:
 * - Backslash \ -> \\
 * - Double-quote " -> \"
 * - Newline \n -> \n
 */
export function escapeLabelValue(val: string | number): string {
  const str = String(val);
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Bounds tenant label to prevent label cardinality explosions
 */
export function sanitizeTenantLabel(tenant?: string): string {
  if (!tenant || tenant.trim() === '') return 'default';
  const clean = tenant.trim();
  if (clean.length > MAX_TENANT_LEN) {
    return clean.slice(0, MAX_TENANT_LEN);
  }
  return clean;
}

const MAX_ORIGIN_LEN = 64;

export const DEFAULT_ORIGIN_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export const DEFAULT_PROXY_LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/**
 * Bounds origin label to prevent label cardinality explosions
 */
export function sanitizeOriginLabel(origin?: string): string {
  if (!origin || origin.trim() === '') return 'default';
  const clean = origin.trim();
  if (clean.length > MAX_ORIGIN_LEN) {
    return clean.slice(0, MAX_ORIGIN_LEN);
  }
  return clean;
}

/**
 * Classifies upstream error modes into stable bounded Prometheus label values.
 */
export function classifyUpstreamError(
  err: any,
  phase?: string
): 'connect_timeout' | 'read_timeout' | 'connection_refused' | 'dns_failure' | 'tls_error' | 'aborted' | '5xx' | 'other' {
  if (!err) return 'other';
  const code = (err.code || err.syscall || '').toString().toUpperCase();
  const msg = (err.message || '').toString().toLowerCase();

  if (code === 'ECONNREFUSED') {
    return 'connection_refused';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'dns_failure';
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    err.name === 'TimeoutError' ||
    msg.includes('timeout')
  ) {
    if (phase === 'connecting' || msg.includes('connect')) return 'connect_timeout';
    return 'read_timeout';
  }
  if (
    code.startsWith('ERR_TLS_') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('cert')
  ) {
    return 'tls_error';
  }
  if (
    code === 'ECONNRESET' ||
    code === 'ERR_CANCELED' ||
    err.name === 'AbortError' ||
    msg.includes('abort') ||
    msg.includes('hang up')
  ) {
    return 'aborted';
  }
  return 'other';
}

/**
 * Serializes labels to `{key="val",...}` string sorted deterministically by key.
 */
export function formatLabels(labels: Record<string, string | number>): string {
  const entries = Object.entries(labels).filter(([_, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  const inner = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
  return `{${inner}}`;
}

/**
 * Native Prometheus Cumulative Histogram implementation without external dependencies.
 */
export class NativeHistogram {
  readonly buckets: number[];
  private data: Map<string, { labels: Record<string, string | number>; counts: number[]; sum: number; count: number }> = new Map();

  constructor(buckets: number[] = DEFAULT_ORIGIN_LATENCY_BUCKETS) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Record<string, string | number>, value: number): void {
    const key = formatLabels(labels);
    let entry = this.data.get(key);
    if (!entry) {
      entry = {
        labels: { ...labels },
        counts: new Array(this.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.data.set(key, entry);
    }
    entry.sum += value;
    entry.count++;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.counts[i]++;
      }
    }
    // +Inf bucket counts all observations
    entry.counts[this.buckets.length]++;
  }

  get(labels: Record<string, string | number>): { sum: number; count: number; counts: number[] } | undefined {
    const key = formatLabels(labels);
    const entry = this.data.get(key);
    if (!entry) return undefined;
    return { sum: entry.sum, count: entry.count, counts: [...entry.counts] };
  }

  format(metricName: string, help: string): string[] {
    const lines: string[] = [];
    lines.push(`# HELP ${metricName} ${help}`);
    lines.push(`# TYPE ${metricName} histogram`);

    const sortedEntries = Array.from(this.data.values()).sort((a, b) => {
      const ka = formatLabels(a.labels);
      const kb = formatLabels(b.labels);
      return ka.localeCompare(kb);
    });

    for (const entry of sortedEntries) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabels = { ...entry.labels, le: String(this.buckets[i]) };
        lines.push(`${metricName}_bucket${formatLabels(bucketLabels)} ${entry.counts[i]}`);
      }
      const infLabels = { ...entry.labels, le: '+Inf' };
      lines.push(`${metricName}_bucket${formatLabels(infLabels)} ${entry.counts[this.buckets.length]}`);
      lines.push(`${metricName}_sum${formatLabels(entry.labels)} ${parseFloat(entry.sum.toFixed(6))}`);
      lines.push(`${metricName}_count${formatLabels(entry.labels)} ${entry.count}`);
    }

    if (sortedEntries.length === 0) {
      const defLabels: Record<string, string | number> = { origin: 'default' };
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${metricName}_bucket${formatLabels({ ...defLabels, le: String(this.buckets[i]) })} 0`);
      }
      lines.push(`${metricName}_bucket${formatLabels({ ...defLabels, le: '+Inf' })} 0`);
      lines.push(`${metricName}_sum${formatLabels(defLabels)} 0`);
      lines.push(`${metricName}_count${formatLabels(defLabels)} 0`);
    }

    return lines;
  }

  clear(): void {
    this.data.clear();
  }
}

export class MetricsRegistry {
  private knownTenants: Set<string> = new Set(['default']);

  // Counters stored as Map<labelString, number>
  private hitsCounter: Map<string, number> = new Map();
  private missesCounter: Map<string, number> = new Map();
  private bytesCounter: Map<string, number> = new Map();
  private requestsCounter: Map<string, number> = new Map();

  // Origin latency histogram
  private originLatencyHistogram = new NativeHistogram(DEFAULT_ORIGIN_LATENCY_BUCKETS);
  // Proxy latency histogram
  private proxyLatencyHistogram = new NativeHistogram(DEFAULT_PROXY_LATENCY_BUCKETS);

  // Eviction counters Map<labelsKey, number>
  private evictionsCount: Map<string, number> = new Map();
  private evictedBytes: Map<string, number> = new Map();

  // Revalidation counter Map<labelsKey, number>
  private revalidationsCounter: Map<string, number> = new Map();

  // Upstream errors counter Map<labelsKey, number>
  private upstreamErrorsCounter: Map<string, number> = new Map();

  // Tenant aggregated counters for ratio computation
  private tenantHits: Map<string, number> = new Map();
  private tenantMisses: Map<string, number> = new Map();
  private tenantCacheBytes: Map<string, number> = new Map();
  private tenantOriginBytes: Map<string, number> = new Map();

  private globalHits = 0;
  private globalMisses = 0;
  private globalCacheBytes = 0;
  private globalOriginBytes = 0;

  private recordTenant(rawTenant?: string): string {
    const tenant = sanitizeTenantLabel(rawTenant);
    if (!this.knownTenants.has(tenant)) {
      if (this.knownTenants.size >= MAX_TENANTS) {
        return 'other';
      }
      this.knownTenants.add(tenant);
    }
    return tenant;
  }

  /**
   * Records a cache hit
   */
  public recordHit(labels: { status: 'fresh' | 'stale' | 'coalesced'; tenant?: string }): void {
    const tenant = this.recordTenant(labels.tenant);
    const key = formatLabels({ status: labels.status, tenant });
    this.hitsCounter.set(key, (this.hitsCounter.get(key) ?? 0) + 1);

    this.tenantHits.set(tenant, (this.tenantHits.get(tenant) ?? 0) + 1);
    this.globalHits++;
  }

  /**
   * Records a cache miss
   */
  public recordMiss(labels: { reason: 'miss' | 'bypass' | 'revalidated_304'; tenant?: string }): void {
    const tenant = this.recordTenant(labels.tenant);
    const key = formatLabels({ reason: labels.reason, tenant });
    this.missesCounter.set(key, (this.missesCounter.get(key) ?? 0) + 1);

    this.tenantMisses.set(tenant, (this.tenantMisses.get(tenant) ?? 0) + 1);
    this.globalMisses++;
  }

  /**
   * Records bytes served
   */
  public recordBytes(labels: { source: 'cache' | 'origin'; bytes: number; tenant?: string }): void {
    if (labels.bytes <= 0) return;
    const tenant = this.recordTenant(labels.tenant);
    const key = formatLabels({ source: labels.source, tenant });
    this.bytesCounter.set(key, (this.bytesCounter.get(key) ?? 0) + labels.bytes);

    if (labels.source === 'cache') {
      this.tenantCacheBytes.set(tenant, (this.tenantCacheBytes.get(tenant) ?? 0) + labels.bytes);
      this.globalCacheBytes += labels.bytes;
    } else {
      this.tenantOriginBytes.set(tenant, (this.tenantOriginBytes.get(tenant) ?? 0) + labels.bytes);
      this.globalOriginBytes += labels.bytes;
    }
  }

  /**
   * Records request count
   */
  public recordRequest(labels: { method: string; status_code: number | string; tenant?: string }): void {
    const tenant = this.recordTenant(labels.tenant);
    const key = formatLabels({
      method: labels.method.toUpperCase(),
      status_code: String(labels.status_code),
      tenant,
    });
    this.requestsCounter.set(key, (this.requestsCounter.get(key) ?? 0) + 1);
  }

  public getHitRatio(tenant?: string): number {
    if (tenant) {
      const hits = this.tenantHits.get(tenant) ?? 0;
      const misses = this.tenantMisses.get(tenant) ?? 0;
      const total = hits + misses;
      return total === 0 ? 0.0 : hits / total;
    }
    const total = this.globalHits + this.globalMisses;
    return total === 0 ? 0.0 : this.globalHits / total;
  }

  public getByteHitRatio(tenant?: string): number {
    if (tenant) {
      const cBytes = this.tenantCacheBytes.get(tenant) ?? 0;
      const oBytes = this.tenantOriginBytes.get(tenant) ?? 0;
      const total = cBytes + oBytes;
      return total === 0 ? 0.0 : cBytes / total;
    }
    const total = this.globalCacheBytes + this.globalOriginBytes;
    return total === 0 ? 0.0 : this.globalCacheBytes / total;
  }

  public getHitsCount(tenant?: string): number {
    return tenant ? this.tenantHits.get(tenant) ?? 0 : this.globalHits;
  }

  public getMissesCount(tenant?: string): number {
    return tenant ? this.tenantMisses.get(tenant) ?? 0 : this.globalMisses;
  }

  public getCacheBytes(tenant?: string): number {
    return tenant ? this.tenantCacheBytes.get(tenant) ?? 0 : this.globalCacheBytes;
  }

  public getOriginBytes(tenant?: string): number {
    return tenant ? this.tenantOriginBytes.get(tenant) ?? 0 : this.globalOriginBytes;
  }

  /**
   * Records upstream origin request latency in seconds.
   */
  public recordOriginLatency(
    labels: { origin?: string; tenant?: string },
    durationSeconds: number
  ): void {
    const origin = sanitizeOriginLabel(labels.origin);
    const tenant = this.recordTenant(labels.tenant);
    this.originLatencyHistogram.observe({ origin, tenant }, Math.max(0, durationSeconds));
  }

  public getOriginLatencyStats(labels?: { origin?: string; tenant?: string }): { sum: number; count: number; counts: number[] } | undefined {
    const origin = sanitizeOriginLabel(labels?.origin);
    const tenant = sanitizeTenantLabel(labels?.tenant);
    return this.originLatencyHistogram.get({ origin, tenant });
  }

  /**
   * Records total proxy request latency in seconds.
   */
  public recordProxyLatency(
    labels: { cache_status?: 'HIT' | 'MISS' | 'STALE' | 'BYPASS' | string; tenant?: string },
    durationSeconds: number
  ): void {
    const cache_status = labels.cache_status ?? 'MISS';
    const tenant = this.recordTenant(labels.tenant);
    this.proxyLatencyHistogram.observe({ cache_status, tenant }, Math.max(0, durationSeconds));
  }

  public getProxyLatencyStats(labels?: { cache_status?: string; tenant?: string }): { sum: number; count: number; counts: number[] } | undefined {
    const cache_status = labels?.cache_status ?? 'MISS';
    const tenant = sanitizeTenantLabel(labels?.tenant);
    return this.proxyLatencyHistogram.get({ cache_status, tenant });
  }

  /**
   * Records cache evictions (items and bytes reclaimed) by reason and tenant.
   */
  public recordEviction(
    labels: {
      reason: 'lru' | 'lfu' | 'slru' | 'ttl' | 'size' | 'quota' | string;
      tenant?: string;
    },
    count = 1,
    bytes = 0
  ): void {
    if (count <= 0) return;
    const reason = labels.reason || 'lru';
    const tenant = this.recordTenant(labels.tenant);
    const key = formatLabels({ reason, tenant });

    this.evictionsCount.set(key, (this.evictionsCount.get(key) ?? 0) + count);
    if (bytes > 0) {
      this.evictedBytes.set(key, (this.evictedBytes.get(key) ?? 0) + bytes);
    }
  }

  public getEvictionsCount(labels?: { reason?: string; tenant?: string }): number {
    if (!labels) {
      let sum = 0;
      for (const val of this.evictionsCount.values()) sum += val;
      return sum;
    }
    const reason = labels.reason ?? 'lru';
    const tenant = sanitizeTenantLabel(labels.tenant);
    const key = formatLabels({ reason, tenant });
    return this.evictionsCount.get(key) ?? 0;
  }

  public getEvictedBytes(labels?: { reason?: string; tenant?: string }): number {
    if (!labels) {
      let sum = 0;
      for (const val of this.evictedBytes.values()) sum += val;
      return sum;
    }
    const reason = labels.reason ?? 'lru';
    const tenant = sanitizeTenantLabel(labels.tenant);
    const key = formatLabels({ reason, tenant });
    return this.evictedBytes.get(key) ?? 0;
  }

  /**
   * Records cache revalidations by result, type, and tenant.
   */
  public recordRevalidation(labels: {
    result: '304_not_modified' | '200_updated' | 'failed' | 'stale_fallback' | string;
    type?: 'sync' | 'swr' | 'background' | string;
    tenant?: string;
  }): void {
    const result = labels.result || '304_not_modified';
    const type = labels.type || 'sync';
    const tenant = this.recordTenant(labels.tenant);
    const key = formatLabels({ result, type, tenant });

    this.revalidationsCounter.set(key, (this.revalidationsCounter.get(key) ?? 0) + 1);
  }

  public getRevalidationsCount(labels?: {
    result?: string;
    type?: string;
    tenant?: string;
  }): number {
    if (!labels) {
      let sum = 0;
      for (const val of this.revalidationsCounter.values()) sum += val;
      return sum;
    }
    const result = labels.result ?? '304_not_modified';
    const type = labels.type ?? 'sync';
    const tenant = sanitizeTenantLabel(labels.tenant);
    const key = formatLabels({ result, type, tenant });
    return this.revalidationsCounter.get(key) ?? 0;
  }

  /**
   * Records upstream origin error classifications.
   */
  public recordUpstreamError(labels: {
    error_type:
      | 'connect_timeout'
      | 'read_timeout'
      | 'connection_refused'
      | '5xx'
      | 'dns_failure'
      | 'tls_error'
      | 'aborted'
      | 'other'
      | string;
    origin?: string;
  }): void {
    const error_type = labels.error_type || 'other';
    const origin = sanitizeOriginLabel(labels.origin);
    const key = formatLabels({ error_type, origin });

    this.upstreamErrorsCounter.set(key, (this.upstreamErrorsCounter.get(key) ?? 0) + 1);
  }

  public getUpstreamErrorsCount(labels?: {
    error_type?: string;
    origin?: string;
  }): number {
    if (!labels) {
      let sum = 0;
      for (const val of this.upstreamErrorsCounter.values()) sum += val;
      return sum;
    }
    const error_type = labels.error_type ?? 'other';
    const origin = sanitizeOriginLabel(labels.origin);
    const key = formatLabels({ error_type, origin });
    return this.upstreamErrorsCounter.get(key) ?? 0;
  }

  /**
   * Renders the complete Prometheus Text Exposition Format (0.0.4)
   */
  public toPrometheusText(): string {
    const lines: string[] = [];

    // 1. Hits Counter
    lines.push('# HELP cdn_cache_hits_total Total number of cache hits served.');
    lines.push('# TYPE cdn_cache_hits_total counter');
    const sortedHits = Array.from(this.hitsCounter.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedHits) {
      lines.push(`cdn_cache_hits_total${labels} ${val}`);
    }
    if (sortedHits.length === 0) {
      lines.push('cdn_cache_hits_total{status="fresh",tenant="default"} 0');
    }

    // 2. Misses Counter
    lines.push('# HELP cdn_cache_misses_total Total number of cache misses and bypasses.');
    lines.push('# TYPE cdn_cache_misses_total counter');
    const sortedMisses = Array.from(this.missesCounter.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedMisses) {
      lines.push(`cdn_cache_misses_total${labels} ${val}`);
    }
    if (sortedMisses.length === 0) {
      lines.push('cdn_cache_misses_total{reason="miss",tenant="default"} 0');
    }

    // 3. Hit Ratio Gauge
    lines.push('# HELP cdn_cache_hit_ratio Ratio of cache hits to total requests (0.0 to 1.0).');
    lines.push('# TYPE cdn_cache_hit_ratio gauge');
    for (const t of Array.from(this.knownTenants).sort()) {
      const ratio = this.getHitRatio(t);
      const strRatio = ratio === 0 ? '0.0' : ratio === 1 ? '1.0' : parseFloat(ratio.toFixed(4)).toString();
      lines.push(`cdn_cache_hit_ratio{tenant="${escapeLabelValue(t)}"} ${strRatio}`);
    }

    // 4. Bytes Served Counter
    lines.push('# HELP cdn_cache_bytes_served_total Total payload bytes delivered to clients.');
    lines.push('# TYPE cdn_cache_bytes_served_total counter');
    const sortedBytes = Array.from(this.bytesCounter.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedBytes) {
      lines.push(`cdn_cache_bytes_served_total${labels} ${val}`);
    }
    if (sortedBytes.length === 0) {
      lines.push('cdn_cache_bytes_served_total{source="cache",tenant="default"} 0');
    }

    // 5. Byte Hit Ratio Gauge
    lines.push('# HELP cdn_cache_byte_hit_ratio Ratio of bytes served from cache vs total bytes.');
    lines.push('# TYPE cdn_cache_byte_hit_ratio gauge');
    for (const t of Array.from(this.knownTenants).sort()) {
      const ratio = this.getByteHitRatio(t);
      const strRatio = ratio === 0 ? '0.0' : ratio === 1 ? '1.0' : parseFloat(ratio.toFixed(4)).toString();
      lines.push(`cdn_cache_byte_hit_ratio{tenant="${escapeLabelValue(t)}"} ${strRatio}`);
    }

    // 6. Requests Total Counter
    lines.push('# HELP cdn_cache_requests_total Total number of proxy requests handled.');
    lines.push('# TYPE cdn_cache_requests_total counter');
    const sortedReqs = Array.from(this.requestsCounter.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedReqs) {
      lines.push(`cdn_cache_requests_total${labels} ${val}`);
    }

    // 7. Origin Latency Histogram (Feature 100)
    const originLatencyLines = this.originLatencyHistogram.format(
      'cdn_origin_latency_seconds',
      'Latency of upstream origin requests in seconds.'
    );
    lines.push(...originLatencyLines);

    // 8. Proxy Latency Histogram (Feature 101)
    const proxyLatencyLines = this.proxyLatencyHistogram.format(
      'cdn_proxy_latency_seconds',
      'Total proxy end-to-end processing latency in seconds.'
    );
    lines.push(...proxyLatencyLines);

    // 9. Evictions Total Counter (Feature 102)
    lines.push('# HELP cdn_cache_evictions_total Total number of cache entries evicted.');
    lines.push('# TYPE cdn_cache_evictions_total counter');
    const sortedEvictions = Array.from(this.evictionsCount.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedEvictions) {
      lines.push(`cdn_cache_evictions_total${labels} ${val}`);
    }
    if (sortedEvictions.length === 0) {
      lines.push('cdn_cache_evictions_total{reason="lru",tenant="default"} 0');
    }

    // 10. Evicted Bytes Counter (Feature 102)
    lines.push('# HELP cdn_cache_evicted_bytes_total Total payload bytes reclaimed via eviction.');
    lines.push('# TYPE cdn_cache_evicted_bytes_total counter');
    const sortedEvictedBytes = Array.from(this.evictedBytes.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedEvictedBytes) {
      lines.push(`cdn_cache_evicted_bytes_total${labels} ${val}`);
    }
    if (sortedEvictedBytes.length === 0) {
      lines.push('cdn_cache_evicted_bytes_total{reason="lru",tenant="default"} 0');
    }

    // 11. Revalidations Total Counter (Feature 103)
    lines.push('# HELP cdn_cache_revalidations_total Total number of cache revalidations performed.');
    lines.push('# TYPE cdn_cache_revalidations_total counter');
    const sortedRevals = Array.from(this.revalidationsCounter.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedRevals) {
      lines.push(`cdn_cache_revalidations_total${labels} ${val}`);
    }
    if (sortedRevals.length === 0) {
      lines.push('cdn_cache_revalidations_total{result="304_not_modified",tenant="default",type="sync"} 0');
    }

    // 12. Upstream Errors Total Counter (Feature 104)
    lines.push('# HELP cdn_upstream_errors_total Total number of upstream origin errors encountered.');
    lines.push('# TYPE cdn_upstream_errors_total counter');
    const sortedUpstreamErrors = Array.from(this.upstreamErrorsCounter.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, val] of sortedUpstreamErrors) {
      lines.push(`cdn_upstream_errors_total${labels} ${val}`);
    }
    if (sortedUpstreamErrors.length === 0) {
      lines.push('cdn_upstream_errors_total{error_type="other",origin="default"} 0');
    }

    return lines.join('\n') + '\n';
  }

  public clear(): void {
    this.hitsCounter.clear();
    this.missesCounter.clear();
    this.bytesCounter.clear();
    this.requestsCounter.clear();
    this.originLatencyHistogram.clear();
    this.proxyLatencyHistogram.clear();
    this.evictionsCount.clear();
    this.evictedBytes.clear();
    this.revalidationsCounter.clear();
    this.upstreamErrorsCounter.clear();
    this.tenantHits.clear();
    this.tenantMisses.clear();
    this.tenantCacheBytes.clear();
    this.tenantOriginBytes.clear();
    this.knownTenants = new Set(['default']);
    this.globalHits = 0;
    this.globalMisses = 0;
    this.globalCacheBytes = 0;
    this.globalOriginBytes = 0;
  }
}
