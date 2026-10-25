import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  loadAndValidateCertificate,
  CertificateManager,
  TlsConfigError,
} from '../src/tls/cert-config.js';

describe('Feature 81: Certificate config', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures/tls');
  const serverCrtPath = path.join(fixturesDir, 'server.crt');
  const serverKeyPath = path.join(fixturesDir, 'server.key');
  const serverAltCrtPath = path.join(fixturesDir, 'server-alt.crt');
  const serverAltKeyPath = path.join(fixturesDir, 'server-alt.key');
  const expiredCrtPath = path.join(fixturesDir, 'expired.crt');
  const expiredKeyPath = path.join(fixturesDir, 'expired.key');

  it('valid config loads certificate, parses SAN domains, and creates secure context', () => {
    const loaded = loadAndValidateCertificate({
      certPath: serverCrtPath,
      keyPath: serverKeyPath,
    });

    expect(loaded).toBeDefined();
    expect(loaded.certPath).toBe(serverCrtPath);
    expect(loaded.keyPath).toBe(serverKeyPath);
    expect(loaded.domains).toContain('localhost');
    expect(loaded.domains).toContain('127.0.0.1');
    expect(loaded.domains).toContain('example.com');
    expect(loaded.domains).toContain('test.local');
    expect(loaded.secureContext).toBeDefined();
    expect(loaded.fingerprint256).toMatch(/^[0-9A-F:]{95}$/);
  });

  it('missing file fails at load with clear error and does not print key', () => {
    // Missing certificate
    expect(() => {
      loadAndValidateCertificate({
        certPath: '/nonexistent/path/to/missing.crt',
        keyPath: serverKeyPath,
      });
    }).toThrowError(TlsConfigError);

    try {
      loadAndValidateCertificate({
        certPath: '/nonexistent/path/to/missing.crt',
        keyPath: serverKeyPath,
      });
    } catch (err: any) {
      expect(err.code).toBe('TLS_FILE_NOT_FOUND');
      expect(err.message).toContain('Certificate file not found');
      expect(err.message).not.toContain('PRIVATE KEY');
    }

    // Missing key
    try {
      loadAndValidateCertificate({
        certPath: serverCrtPath,
        keyPath: '/nonexistent/path/to/missing.key',
      });
    } catch (err: any) {
      expect(err.code).toBe('TLS_FILE_NOT_FOUND');
      expect(err.message).toContain('Private key file not found');
      expect(err.message).not.toContain('PRIVATE KEY');
    }
  });

  it('unreadable file fails at load with clear error', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-perm-test-'));
    const unreadableFile = path.join(tmpDir, 'unreadable.crt');
    fs.writeFileSync(unreadableFile, 'dummy content');
    try {
      fs.chmodSync(unreadableFile, 0o000);
      expect(() => {
        loadAndValidateCertificate({
          certPath: unreadableFile,
          keyPath: serverKeyPath,
        });
      }).toThrowError(TlsConfigError);
    } finally {
      fs.chmodSync(unreadableFile, 0o644);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('malformed PEM fails at load with clear error and does not print key', () => {
    // Malformed certificate
    try {
      loadAndValidateCertificate({
        cert: '-----BEGIN CERTIFICATE-----\nGARBAGE_NOT_A_REAL_BASE64\n-----END CERTIFICATE-----',
        keyPath: serverKeyPath,
      });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('TLS_MALFORMED_CERTIFICATE');
      expect(err.message).not.toContain('PRIVATE KEY');
    }

    // Malformed private key
    try {
      loadAndValidateCertificate({
        certPath: serverCrtPath,
        key: '-----BEGIN RSA PRIVATE KEY-----\nGARBAGE_KEY_DATA\n-----END RSA PRIVATE KEY-----',
      });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('TLS_MALFORMED_KEY');
      expect(err.message).not.toContain('GARBAGE_KEY_DATA');
    }
  });

  it('key not matching the certificate fails at load with clear error and does not print key', () => {
    try {
      loadAndValidateCertificate({
        certPath: serverCrtPath,
        keyPath: serverAltKeyPath, // Different key
      });
      expect.fail('Should have thrown on mismatched key');
    } catch (err: any) {
      expect(err.code).toBe('TLS_KEY_MISMATCH');
      expect(err.message).toContain('Private key does not match public key');
      expect(err.message).not.toContain('PRIVATE KEY');
    }
  });

  it('expired certificate fails at load with clear error indicating expiration', () => {
    try {
      loadAndValidateCertificate({
        certPath: expiredCrtPath,
        keyPath: expiredKeyPath,
      });
      expect.fail('Should have thrown on expired cert');
    } catch (err: any) {
      expect(err.code).toBe('TLS_CERT_EXPIRED');
      expect(err.message).toContain('Certificate has expired');
    }
  });

  it('multiple certificates with SNI selection picks correct certificate or default', () => {
    const mgr = new CertificateManager([
      { certPath: serverCrtPath, keyPath: serverKeyPath, isDefault: true },
      { certPath: serverAltCrtPath, keyPath: serverAltKeyPath },
    ]);

    // 1. SNI match for alt.example.com
    const altCert = mgr.getCertificateForServerName('alt.example.com');
    expect(altCert).not.toBeNull();
    expect(altCert?.domains).toContain('alt.example.com');
    expect(altCert?.domains).toContain('alt.local');

    // 2. SNI match for localhost
    const localCert = mgr.getCertificateForServerName('localhost');
    expect(localCert).not.toBeNull();
    expect(localCert?.domains).toContain('localhost');

    // 3. Unknown SNI returns default certificate
    const unknownCert = mgr.getCertificateForServerName('unknown.domain.org');
    expect(unknownCert).not.toBeNull();
    expect(unknownCert).toBe(mgr.getDefaultCertificate());
    expect(unknownCert?.domains).toContain('localhost');

    // 4. Case-insensitivity in SNI
    const caseCert = mgr.getCertificateForServerName('ALT.EXAMPLE.COM');
    expect(caseCert).toBe(altCert);
  });

  it('refuses unknown SNI when refuseUnknownSni is configured', () => {
    const mgr = new CertificateManager(
      [
        { certPath: serverCrtPath, keyPath: serverKeyPath },
        { certPath: serverAltCrtPath, keyPath: serverAltKeyPath },
      ],
      { refuseUnknownSni: true }
    );

    expect(mgr.getCertificateForServerName('localhost')).not.toBeNull();
    expect(mgr.getCertificateForServerName('unknown.domain.org')).toBeNull();

    // Verify sniCallback returns error on unknown SNI
    let cbErr: any = null;
    mgr.sniCallback('unknown.domain.org', (err) => {
      cbErr = err;
    });
    expect(cbErr).toBeDefined();
    expect(cbErr.message).toContain('Unrecognized SNI servername');
  });
});
