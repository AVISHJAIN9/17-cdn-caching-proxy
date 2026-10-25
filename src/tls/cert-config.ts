import fs from 'node:fs';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { DEFAULT_MIN_TLS_VERSION, DEFAULT_CIPHERS } from './constants.js';
import type { TlsCertificateConfig, LoadedCertificate } from './types.js';

export class TlsConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TlsConfigError';
  }
}

/**
 * Sanitizes any potential secret/private key data from error messages.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]');
}

/**
 * Safely reads a file with descriptive errors for missing and unreadable files.
 */
function safeReadFile(filePath: string, fileLabel: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new TlsConfigError(
        'TLS_FILE_NOT_FOUND',
        `${fileLabel} file not found: ${filePath}`
      );
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new TlsConfigError(
        'TLS_FILE_UNREADABLE',
        `Permission denied reading ${fileLabel} file: ${filePath}`
      );
    }
    throw new TlsConfigError(
      'TLS_FILE_READ_ERROR',
      `Failed to read ${fileLabel} file (${filePath}): ${err.message}`
    );
  }
}

export interface CertValidationOptions {
  allowExpired?: boolean;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
  now?: Date;
  clientCa?: string | Buffer;
}

/**
 * Loads, inspects, and strictly validates a TLS certificate and private key:
 * - Checks missing and unreadable files
 * - Validates PEM format
 * - Verifies private key matches public key in certificate
 * - Rejects expired certificates
 * - Never prints private key in errors or logs
 */
export function loadAndValidateCertificate(
  config: TlsCertificateConfig,
  options: CertValidationOptions = {}
): LoadedCertificate {
  let certBuf: Buffer;
  let keyBuf: Buffer;
  let caBuf: Buffer | undefined;

  // 1. Load Certificate buffer
  if (config.certPath) {
    certBuf = safeReadFile(config.certPath, 'Certificate');
  } else if (config.cert) {
    certBuf = Buffer.isBuffer(config.cert) ? config.cert : Buffer.from(config.cert);
  } else {
    throw new TlsConfigError('TLS_MISSING_CONFIG', 'Certificate path or content is required');
  }

  // 2. Load Private Key buffer
  if (config.keyPath) {
    keyBuf = safeReadFile(config.keyPath, 'Private key');
  } else if (config.key) {
    keyBuf = Buffer.isBuffer(config.key) ? config.key : Buffer.from(config.key);
  } else {
    throw new TlsConfigError('TLS_MISSING_CONFIG', 'Private key path or content is required');
  }

  // 3. Optional CA bundle
  if (config.caPath) {
    caBuf = safeReadFile(config.caPath, 'CA');
  } else if (config.ca) {
    caBuf = Buffer.isBuffer(config.ca) ? config.ca : Buffer.from(config.ca);
  }

  // 4. Validate Certificate PEM format
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(certBuf);
  } catch (err: any) {
    throw new TlsConfigError(
      'TLS_MALFORMED_CERTIFICATE',
      `Malformed PEM certificate: ${sanitizeErrorMessage(err.message)}`
    );
  }

  // 5. Validate Private Key PEM format (ensure key content is never printed)
  let privateKeyObj: crypto.KeyObject;
  try {
    privateKeyObj = crypto.createPrivateKey(keyBuf);
  } catch (err: any) {
    throw new TlsConfigError(
      'TLS_MALFORMED_KEY',
      `Malformed PEM private key: ${sanitizeErrorMessage(err.message)}`
    );
  }

  // 6. Verify Private Key matches Certificate public key
  try {
    const certPublicKeyPem = x509.publicKey.export({ type: 'spki', format: 'pem' });
    const keyPublicKeyPem = crypto.createPublicKey(privateKeyObj).export({ type: 'spki', format: 'pem' });

    if (certPublicKeyPem !== keyPublicKeyPem) {
      throw new TlsConfigError(
        'TLS_KEY_MISMATCH',
        'Private key does not match public key in certificate'
      );
    }
  } catch (err: any) {
    if (err instanceof TlsConfigError) throw err;
    throw new TlsConfigError(
      'TLS_KEY_MISMATCH',
      `Failed to verify private key match: ${sanitizeErrorMessage(err.message)}`
    );
  }

  // 7. Validate expiration date
  const notBefore = new Date(x509.validFrom);
  const notAfter = new Date(x509.validTo);
  const checkTime = options.now ?? new Date();

  if (!options.allowExpired && notAfter.getTime() <= checkTime.getTime()) {
    throw new TlsConfigError(
      'TLS_CERT_EXPIRED',
      `Certificate has expired on ${x509.validTo} (fingerprint: ${x509.fingerprint256})`
    );
  }

  // 8. Extract all hostnames / domains from Subject and SAN
  const domains = new Set<string>();

  // Extract CN from subject
  const subjectStr = x509.subject;
  const cnMatch = subjectStr.match(/(?:^|\n|\/)CN=([^/\n,]+)/i);
  if (cnMatch && cnMatch[1]) {
    domains.add(cnMatch[1].trim().toLowerCase());
  }

  // Extract DNS and IP from subjectAltName
  if (x509.subjectAltName) {
    const sanEntries = x509.subjectAltName.split(',').map((s) => s.trim());
    for (const entry of sanEntries) {
      const match = entry.match(/^(?:DNS|IP Address):(.+)$/i);
      if (match && match[1]) {
        domains.add(match[1].trim().toLowerCase());
      }
    }
  }

  // 9. Build secure context with strict minimum TLS version and ciphers
  const secureContext = tls.createSecureContext({
    cert: certBuf,
    key: keyBuf,
    ca: caBuf ?? options.clientCa,
    minVersion: options.minVersion ?? DEFAULT_MIN_TLS_VERSION,
    ciphers: options.ciphers ?? DEFAULT_CIPHERS,
  });

  return {
    cert: certBuf,
    key: keyBuf,
    ca: caBuf,
    certPath: config.certPath,
    keyPath: config.keyPath,
    caPath: config.caPath,
    domains: Array.from(domains),
    isDefault: Boolean(config.isDefault),
    notBefore,
    notAfter,
    fingerprint256: x509.fingerprint256,
    subject: x509.subject,
    secureContext,
  };
}

import { CertificateFileWatcher, type CertWatcherOptions } from './cert-watcher.js';

export interface CertificateManagerOptions {
  allowExpired?: boolean;
  refuseUnknownSni?: boolean;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
  clientCa?: string | Buffer;
}

/**
 * Manages multiple loaded certificates, handles SNI dispatch with wildcard and default matching,
 * and supports zero-downtime certificate rotation with file watching.
 */
export class CertificateManager {
  private certificates: LoadedCertificate[] = [];
  private defaultCert: LoadedCertificate | null = null;
  private domainMap = new Map<string, LoadedCertificate>();
  private wildcardMap = new Map<string, LoadedCertificate>();
  private activeWatchers: CertificateFileWatcher[] = [];
  private rotateCallbacks: Array<(newCert: LoadedCertificate, oldCert?: LoadedCertificate) => void> = [];
  private originalConfigs: TlsCertificateConfig[] = [];

  constructor(
    configs: TlsCertificateConfig[] = [],
    private readonly options: CertificateManagerOptions = {}
  ) {
    this.originalConfigs = [...configs];
    for (let i = 0; i < configs.length; i++) {
      const isFirst = i === 0;
      const loaded = loadAndValidateCertificate(configs[i], {
        allowExpired: options.allowExpired,
        minVersion: options.minVersion,
        ciphers: options.ciphers,
        clientCa: options.clientCa,
      });
      this.addCertificate(loaded, isFirst && !configs.some((c) => c.isDefault));
    }
  }

  public onRotate(callback: (newCert: LoadedCertificate, oldCert?: LoadedCertificate) => void): () => void {
    this.rotateCallbacks.push(callback);
    return () => {
      this.rotateCallbacks = this.rotateCallbacks.filter((cb) => cb !== callback);
    };
  }

  public addCertificate(cert: LoadedCertificate, markAsDefault: boolean = false): void {
    this.certificates.push(cert);
    if (cert.isDefault || markAsDefault || !this.defaultCert) {
      this.defaultCert = cert;
    }

    for (const domain of cert.domains) {
      if (domain.startsWith('*.')) {
        this.wildcardMap.set(domain.slice(2), cert);
      } else {
        this.domainMap.set(domain, cert);
      }
    }
  }

  /**
   * Reloads a certificate by file path, strictly validating it first.
   * If valid, updates domain maps and default cert atomically.
   * If invalid, throws and leaves existing certificate completely untouched.
   */
  public reloadCertificate(certConfig: TlsCertificateConfig): LoadedCertificate {
    const newCert = loadAndValidateCertificate(certConfig, {
      allowExpired: this.options.allowExpired,
      minVersion: this.options.minVersion,
      ciphers: this.options.ciphers,
      clientCa: this.options.clientCa,
    });

    // Find previous matching certificate
    let oldCertIdx = -1;
    if (certConfig.certPath) {
      oldCertIdx = this.certificates.findIndex((c) => c.certPath === certConfig.certPath);
    } else if (certConfig.isDefault) {
      oldCertIdx = this.certificates.findIndex((c) => c === this.defaultCert);
    }

    const oldCert = oldCertIdx >= 0 ? this.certificates[oldCertIdx] : undefined;

    if (oldCert) {
      // Clean up old domain mappings
      for (const domain of oldCert.domains) {
        if (domain.startsWith('*.')) {
          if (this.wildcardMap.get(domain.slice(2)) === oldCert) {
            this.wildcardMap.delete(domain.slice(2));
          }
        } else {
          if (this.domainMap.get(domain) === oldCert) {
            this.domainMap.delete(domain);
          }
        }
      }

      this.certificates[oldCertIdx] = newCert;
    } else {
      this.certificates.push(newCert);
    }

    if (oldCert === this.defaultCert || certConfig.isDefault || !this.defaultCert) {
      this.defaultCert = newCert;
    }

    // Register new domain mappings
    for (const domain of newCert.domains) {
      if (domain.startsWith('*.')) {
        this.wildcardMap.set(domain.slice(2), newCert);
      } else {
        this.domainMap.set(domain, newCert);
      }
    }

    // Notify listeners
    for (const cb of this.rotateCallbacks) {
      try {
        cb(newCert, oldCert);
      } catch (err) {
        console.error('[cert-rotation] Error in rotation callback:', err);
      }
    }

    return newCert;
  }

  /**
   * Reloads all certificates configured with file paths.
   */
  public reloadAll(): LoadedCertificate[] {
    const results: LoadedCertificate[] = [];
    for (const config of this.originalConfigs) {
      if (config.certPath && config.keyPath) {
        results.push(this.reloadCertificate(config));
      }
    }
    return results;
  }

  /**
   * Starts a file watcher on all configured certificate paths.
   */
  public watch(options: CertWatcherOptions = {}): CertificateFileWatcher {
    const pathsToWatch: string[] = [];
    for (const config of this.originalConfigs) {
      if (config.certPath) pathsToWatch.push(config.certPath);
      if (config.keyPath) pathsToWatch.push(config.keyPath);
      if (config.caPath) pathsToWatch.push(config.caPath);
    }

    const watcher = new CertificateFileWatcher(pathsToWatch, {
      debounceMs: options.debounceMs ?? 100,
      onReload: async () => {
        try {
          const reloaded = this.reloadAll();
          if (options.onReload) {
            await options.onReload();
          }
        } catch (err: any) {
          console.error(`[cert-rotation] Failed to reload certificate on disk: ${err.message}`);
          if (options.onError) {
            options.onError(err);
          }
        }
      },
      onError: (err) => {
        console.error(`[cert-rotation] Certificate watcher error: ${err.message}`);
        if (options.onError) {
          options.onError(err);
        }
      },
    });

    this.activeWatchers.push(watcher);
    return watcher;
  }

  public close(): void {
    for (const watcher of this.activeWatchers) {
      watcher.close();
    }
    this.activeWatchers = [];
    this.rotateCallbacks = [];
  }

  public getCertificateForServerName(serverName?: string): LoadedCertificate | null {
    if (!serverName) {
      return this.defaultCert;
    }

    const lower = serverName.toLowerCase().trim();

    // 1. Exact domain match
    const exact = this.domainMap.get(lower);
    if (exact) return exact;

    // 2. Wildcard domain match (e.g. *.example.com matches foo.example.com)
    const dotIdx = lower.indexOf('.');
    if (dotIdx > 0) {
      const parentDomain = lower.slice(dotIdx + 1);
      const wildcard = this.wildcardMap.get(parentDomain);
      if (wildcard) return wildcard;
    }

    // 3. Unknown SNI
    if (this.options.refuseUnknownSni) {
      return null;
    }

    return this.defaultCert;
  }

  public getSecureContext(serverName?: string): tls.SecureContext | null {
    const cert = this.getCertificateForServerName(serverName);
    return cert ? cert.secureContext : null;
  }

  public getDefaultCertificate(): LoadedCertificate | null {
    return this.defaultCert;
  }

  public getAllCertificates(): LoadedCertificate[] {
    return [...this.certificates];
  }

  /**
   * SNI callback for tls.Server / https.Server options.
   */
  public sniCallback = (
    serverName: string,
    callback: (err: Error | null, ctx?: tls.SecureContext) => void
  ): void => {
    const ctx = this.getSecureContext(serverName);
    if (!ctx) {
      if (this.options.refuseUnknownSni) {
        callback(new Error(`Unrecognized SNI servername: "${serverName}"`));
      } else {
        callback(null, this.defaultCert?.secureContext);
      }
      return;
    }
    callback(null, ctx);
  };
}
