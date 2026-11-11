---
name: kimi-usage
description: Read Kimi Code plan limits (5-hour and monthly windows) for the hosts enrolled in this BB server. Use when the user asks how much of the Kimi Code quota is left, when limits reset, or why bb shows no Kimi usage.
---

# Kimi Code usage

Run `bb kimi-usage show --json` to get the current windows for every connected
host. Each entry looks like:

```json
{
  "host": "workstation",
  "hostId": "host_...",
  "observedAt": 1794404965129,
  "usage": {
    "status": "ok",
    "windows": [
      { "id": "limit_5h", "label": "5 hours", "kind": "five-hour", "usedPercent": 5.3, "resetsAt": "2026-11-11T13:57:49Z" },
      { "id": "limit_month_total", "label": "Monthly", "kind": "custom", "usedPercent": 36.64, "resetsAt": "2026-12-04T00:00:00Z" }
    ]
  }
}
```

`status` is one of `ok`, `not_installed`, `unauthenticated`, `expired`, `error`.
`expired` and `unauthenticated` mean the Kimi Code CLI on that host has to be
signed in again with `kimi login`; this plugin cannot repair a rejected refresh
token on its own.

The same numbers appear in BB under Settings → Plugins → Provider usage.
