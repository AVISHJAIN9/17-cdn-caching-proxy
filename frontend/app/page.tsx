export default function HomePage() {
  return (
    <div className="max-w-5xl mx-auto py-16 text-center">
      <h1 className="text-5xl font-extrabold text-white mb-6">RFC 9111 Compliant CDN Caching Proxy</h1>
      <p className="text-slate-400 text-lg mb-8">High-performance reverse caching proxy with RFC 9111 HTTP caching semantics, memory/disk tiering, and request coalescing.</p>
      <a href="/dashboard" className="px-6 py-3 rounded-lg bg-cyan-400 text-black font-semibold">Open Telemetry Dashboard</a>
    </div>
  )
}
