# Kimi Usage

Shows Kimi Code plan limits in BB's **Settings → Plugins → Provider usage**
view, next to the other usage sources, and in a sidebar footer card when that
option is on.

BB's ACP provider plugin reads plan limits for opencode and Cursor only, so a
Kimi Code subscription shows no limits at all. This plugin fills that gap
without touching the provider: it registers the same
`provider-usage.v1.*` RPC resources that BB's built-in Provider usage plugin
discovers on any loaded plugin.

## How it works

- `server.ts` declares one usage resource per connected host and answers
  `provider-usage.v1.listResources` / `provider-usage.v1.getResource`.
- `host.ts` runs on each host daemon. It finds the Kimi Code CLI credentials
  (`$KIMI_CODE_HOME`, `~/.kimi-code`, or the legacy `~/.kimi`), refreshes the
  OAuth token when it is close to expiry — writing the rotated token back to
  the CLI's credentials file — and reads
  `GET {base_url}/coding/v1/usages`.
- The base URL comes from the CLI's own `config.toml`
  (`https://api.kimi.ai/coding/v1` or `https://api.kimi.com/coding/v1`).

Reported windows: the 5-hour window, a weekly/daily window when the API
reports one, and the monthly quota.

## Requirements

- Kimi Code CLI signed in on the host: `kimi login`.
- bb 0.49 or newer.

A host without credentials reports "unauthenticated", one whose token refresh
fails reports "expired"; both are normal states of the usage contract.

## Command

```
bb kimi-usage show [--host <host-id>] [--json]
```

Prints the same numbers from a terminal and forces a fresh measurement.
