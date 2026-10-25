import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    title: '17-CDN-Caching-Proxy',
    description: 'RFC 9111 compliant reverse-caching CDN edge proxy in TypeScript.',
    appearance: 'dark',
    base: '/',
    themeConfig: {
      nav: [
        { text: 'Guide', link: '/00a-project-analysis' },
        { text: 'Features', link: '/01-features' },
        { text: 'API Reference', link: '/03-api-reference' },
        { text: 'System Design', link: '/system-design/' },
        { text: 'Interview Q&A', link: '/09-interview-qa' },
        { text: 'Master Checklist', link: '/13-master-checklist' }
      ],
      sidebar: [
        {
          text: 'Project Overview',
          items: [
            { text: 'Project Type', link: '/00-project-type' },
            { text: 'Project Analysis', link: '/00a-project-analysis' },
            { text: 'Project Pitch', link: '/00b-project-pitch' },
            { text: 'Project Map', link: '/00-project-map' }
          ]
        },
        {
          text: 'Features (F1 - F16)',
          items: [
            { text: 'Feature Inventory', link: '/01-features' },
            { text: 'F1: RFC 9111 Cache Core', link: '/features/F1-rfc9111-cache-core' },
            { text: 'F2: Request Coalescing', link: '/features/F2-request-collapsing' },
            { text: 'F3: Multi-Tier Storage', link: '/features/F3-multi-tier-storage' },
            { text: 'F4: Eviction Algorithms', link: '/features/F4-eviction-algorithms' },
            { text: 'F5: Conditional Revalidation', link: '/features/F5-conditional-revalidation' },
            { text: 'F6: Surrogate Tag Purge', link: '/features/F6-surrogate-key-purge' },
            { text: 'F7: Streaming Compression', link: '/features/F7-streaming-compression' },
            { text: 'F8: Byte-Range Slicing', link: '/features/F8-byte-range-requests' },
            { text: 'F9: Multi-Origin Routing', link: '/features/F9-multi-origin-health' },
            { text: 'F10: Edge Security WAF', link: '/features/F10-edge-security-waf' },
            { text: 'F11: Observability Metrics', link: '/features/F11-observability-metrics' },
            { text: 'F12: Admin Control Plane', link: '/features/F12-admin-control-plane' },
            { text: 'F13: Next.js 14 Dashboard', link: '/features/F13-nextjs-telemetry-dashboard' },
            { text: 'F14: Ketama Consistent Hashing', link: '/features/F14-consistent-hashing-cluster' },
            { text: 'F15: Cache Pre-Warming', link: '/features/F15-cache-prewarming' },
            { text: 'F16: AIML Tier Models', link: '/features/F16-aiml-tier-models' }
          ]
        },
        {
          text: 'Guides & Specifications',
          items: [
            { text: 'Build Order', link: '/02-build-order' },
            { text: 'API Reference', link: '/03-api-reference' },
            { text: 'Tech Comparisons', link: '/04-tech-comparisons' },
            { text: 'Architecture Deep Dive', link: '/05-architecture' },
            { text: 'Edge Security', link: '/06-security' },
            { text: 'AI Architecture', link: '/07-ai-integration' },
            { text: 'Quality & Testing', link: '/08-quality-and-ops' }
          ]
        },
        {
          text: 'System Design Deep Dive (17 Topics)',
          items: [
            { text: 'System Design Overview', link: '/system-design/' },
            { text: '14.1 Capacity Estimation', link: '/system-design/14.1-requirements-and-estimation' },
            { text: '14.2 Architecture Styles', link: '/system-design/14.2-architecture-styles' },
            { text: '14.3 Networking & HTTP', link: '/system-design/14.3-networking-and-communication' },
            { text: '14.4 Load Balancing & Scaling', link: '/system-design/14.4-load-balancing-and-scaling' },
            { text: '14.5 Storage Architecture', link: '/system-design/14.5-databases-and-storage' },
            { text: '14.6 Deep Caching', link: '/system-design/14.6-caching' },
            { text: '14.7 Messaging & Queues', link: '/system-design/14.7-messaging-and-queues' },
            { text: '14.8 Consistency & Concurrency', link: '/system-design/14.8-consistency-and-concurrency' },
            { text: '14.9 Reliability & Resilience', link: '/system-design/14.9-reliability-and-resilience' },
            { text: '14.10 API Design & Quotas', link: '/system-design/14.10-api-design-and-rate-limiting' },
            { text: '14.11 Security Architecture', link: '/system-design/14.11-security-architecture' },
            { text: '14.12 Search & AI Architecture', link: '/system-design/14.12-search-and-ai-architecture' },
            { text: '14.13 Real-Time Telemetry', link: '/system-design/14.13-real-time-systems' },
            { text: '14.14 Observability & Operations', link: '/system-design/14.14-observability-and-operations' },
            { text: '14.15 Performance Engineering', link: '/system-design/14.15-performance-engineering' },
            { text: '14.16 Cost & Trade-offs', link: '/system-design/14.16-cost-and-trade-offs' },
            { text: '14.17 Classic Questions', link: '/system-design/14.17-classic-system-design' },
            { text: 'Architecture Decisions (ADR)', link: '/system-design/decisions' }
          ]
        },
        {
          text: 'Interview & Quality Assurance',
          items: [
            { text: 'Interview Q&A (150+)', link: '/09-interview-qa' },
            { text: 'Gaps & Roadmap', link: '/10-gaps-and-improvements' },
            { text: 'Glossary', link: '/11-glossary' },
            { text: 'Confirm List', link: '/12-confirm-list' },
            { text: 'Master Checklist (275)', link: '/13-master-checklist' },
            { text: 'Say It Out Loud', link: '/14-say-it-out-loud' }
          ]
        }
      ],
      search: {
        provider: 'local'
      },
      outline: [2, 3]
    },
    mermaid: {
      theme: 'dark'
    },
    vite: {
      optimizeDeps: {
        include: ['mermaid', 'fastdom', 'fastdom/extensions/fastdom-promised.js']
      },
      ssr: {
        noExternal: ['mermaid', 'vitepress-plugin-mermaid', 'fastdom']
      }
    }
  })
);
