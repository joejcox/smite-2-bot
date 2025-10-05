# Changelog

## [0.5.0] - 2025-10-05 — persistent tier cache, fast autocomplete, and weekly refresh

### Added
- On-disk cache for tier/god names at `data/tier_cache.json` to survive restarts.
- Prewarm caches on startup for roles: `all`, `jungle`, `solo`, `mid`, `support`, `carry`.
- Weekly background refresh to keep names current.

### Changed
- Autocomplete now responds once from cache (no network) — eliminates ~3s timeouts.
- Use `flags: 64` instead of deprecated `ephemeral` for error replies.

### Fixed
- Guard against expired/duplicate interaction replies (swallow `10062`/`40060` noise).
- TDZ bug: declare `role` before using it in autocomplete.
- Background warm on stale cache (non-blocking).

### Ops
- Ensure `/opt/smite-bot/data` is writable by the container (UID `1000`) when running with `user: "node"`.

### Notes
- Command execution still fetches fresh data; persistent cache only powers autocomplete.