import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Feature 143: Kubernetes deployment manifests', () => {
  const k8sDir = path.resolve(__dirname, '../deploy/k8s');
  const templatesDir = path.join(k8sDir, 'templates');

  it('validates Chart.yaml and values.yaml existence and schema', () => {
    const chartPath = path.join(k8sDir, 'Chart.yaml');
    expect(fs.existsSync(chartPath)).toBe(true);
    const chartContent = fs.readFileSync(chartPath, 'utf8');
    expect(chartContent).toContain('name: cdn-caching-proxy');
    expect(chartContent).toContain('apiVersion: v2');

    const valuesPath = path.join(k8sDir, 'values.yaml');
    expect(fs.existsSync(valuesPath)).toBe(true);
    const valuesContent = fs.readFileSync(valuesPath, 'utf8');
    expect(valuesContent).toContain('replicaCount: 3');
    expect(valuesContent).toContain('terminationGracePeriodSeconds: 30');
    expect(valuesContent).toContain('readOnlyRootFilesystem: true');
  });

  it('asserts StatefulSet invariants: persistent disk cache, stable identity, security context, and probes', () => {
    const sfsPath = path.join(templatesDir, 'statefulset.yaml');
    expect(fs.existsSync(sfsPath)).toBe(true);
    const sfs = fs.readFileSync(sfsPath, 'utf8');

    // Kind is StatefulSet
    expect(sfs).toContain('kind: StatefulSet');

    // Headless service linkage for stable network identity
    expect(sfs).toContain('serviceName:');
    expect(sfs).toContain('-headless');

    // Pod and Container SecurityContext
    expect(sfs).toContain('runAsNonRoot: true');
    expect(sfs).toContain('readOnlyRootFilesystem: true');
    expect(sfs).toContain('type: RuntimeDefault');
    expect(sfs).toContain('drop:');
    expect(sfs).toContain('- ALL');

    // All 3 probes configured with real health routes
    expect(sfs).toContain('startupProbe:');
    expect(sfs).toContain('readinessProbe:');
    expect(sfs).toContain('livenessProbe:');
    expect(sfs).toContain('/health');

    // Graceful shutdown: termination grace period and preStop lifecycle hook
    expect(sfs).toContain('terminationGracePeriodSeconds:');
    expect(sfs).toContain('preStop:');

    // Persistent storage for disk cache via volumeClaimTemplates
    expect(sfs).toContain('volumeClaimTemplates:');
    expect(sfs).toContain('name: disk-cache');
    expect(sfs).toContain('ReadWriteOnce');
  });

  it('asserts Headless service for peer discovery and Client service for traffic ingress', () => {
    const headlessPath = path.join(templatesDir, 'service-headless.yaml');
    expect(fs.existsSync(headlessPath)).toBe(true);
    const headless = fs.readFileSync(headlessPath, 'utf8');
    expect(headless).toContain('kind: Service');
    expect(headless).toContain('clusterIP: None');
    expect(headless).toContain('port: 8080');
    expect(headless).toContain('port: 9090');

    const clientPath = path.join(templatesDir, 'service-client.yaml');
    expect(fs.existsSync(clientPath)).toBe(true);
    const client = fs.readFileSync(clientPath, 'utf8');
    expect(client).toContain('kind: Service');
    expect(client).toContain('port:');
  });

  it('asserts PodDisruptionBudget, HPA, and NetworkPolicy isolation', () => {
    // PDB
    const pdbPath = path.join(templatesDir, 'pdb.yaml');
    expect(fs.existsSync(pdbPath)).toBe(true);
    const pdb = fs.readFileSync(pdbPath, 'utf8');
    expect(pdb).toContain('kind: PodDisruptionBudget');
    expect(pdb).toContain('minAvailable:');
    expect(pdb).toContain('app.kubernetes.io/name: cdn-caching-proxy');

    // HPA
    const hpaPath = path.join(templatesDir, 'hpa.yaml');
    expect(fs.existsSync(hpaPath)).toBe(true);
    const hpa = fs.readFileSync(hpaPath, 'utf8');
    expect(hpa).toContain('kind: HorizontalPodAutoscaler');
    expect(hpa).toContain('kind: StatefulSet');
    expect(hpa).toContain('type: Resource');

    // NetworkPolicy
    const netpolPath = path.join(templatesDir, 'networkpolicy.yaml');
    expect(fs.existsSync(netpolPath)).toBe(true);
    const netpol = fs.readFileSync(netpolPath, 'utf8');
    expect(netpol).toContain('kind: NetworkPolicy');
    expect(netpol).toContain('port: 8080'); // client port
    expect(netpol).toContain('port: 9090'); // admin port
    expect(netpol).toContain('adminAllowedNamespaces');
  });

  it('verifies no plaintext passwords or raw secrets are stored in ConfigMap or manifest templates', () => {
    const files = fs.readdirSync(templatesDir);
    for (const file of files) {
      const content = fs.readFileSync(path.join(templatesDir, file), 'utf8');
      if (file !== 'secret.yaml') {
        expect(content).not.toMatch(/password:\s*['"][^'"]+['"]/i);
        expect(content).not.toMatch(/secretKey:\s*['"][^'"]+['"]/i);
      }
    }
  });
});
