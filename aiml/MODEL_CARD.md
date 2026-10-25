# AIML Model Cards: RFC 9111 Compliant CDN Caching Proxy

## Tier A: Popularity Predictor for proactive cache prefetch and eviction vs LRU
- **Baseline**: Non-AI Static Baseline
- **Target**: Statistically significant win on stated evaluation metric.
- **Status**: Specified & Scaffolded (**TO BE MEASURED**).
- **Graceful Fallback**: Hardcoded static threshold rule engine.

## Tier B: Cache-miss forensic diagnostics and header optimization assistant
- **LLM Prompt Guard**: Strict schema validation. The LLM is NEVER on correctness or transactional paths.
