import type tls from 'node:tls';

export interface TlsCertificateConfig {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  cert?: string | Buffer;
  key?: string | Buffer;
  ca?: string | Buffer;
  isDefault?: boolean;
}

export interface LoadedCertificate {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  domains: string[];
  isDefault: boolean;
  notBefore: Date;
  notAfter: Date;
  fingerprint256: string;
  subject: string;
  secureContext: tls.SecureContext;
}

export type ClientCertAuthMode = 'off' | 'optional' | 'required';

export interface VerifiedClientCert {
  authorized: boolean;
  authorizationError?: string;
  subject: Record<string, string>;
  issuer: Record<string, string>;
  subjectaltname?: string;
  san?: string;
  fingerprint256: string;
  serialNumber?: string;
  validFrom?: string;
  validTo?: string;
  raw?: Buffer;
}

export interface TlsListenerConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
  certificates: TlsCertificateConfig[];
  refuseUnknownSni?: boolean;
  clientAuth?: ClientCertAuthMode;
  clientCaPath?: string;
  clientCa?: string | Buffer;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
}

export interface UpstreamTlsConfig {
  enabled?: boolean;
  caPath?: string;
  ca?: string | Buffer;
  clientCertPath?: string;
  clientKeyPath?: string;
  clientCert?: string | Buffer;
  clientKey?: string | Buffer;
  rejectUnauthorized?: boolean;
  insecureSkipVerify?: boolean;
  servername?: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
}
