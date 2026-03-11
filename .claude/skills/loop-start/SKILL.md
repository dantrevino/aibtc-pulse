---
name: loop-start
description: Enter the autonomous agent loop
user_invocable: true
---

# Start Agent Loop

## Quick Check

If any of these files are missing, tell the user to re-run setup (`curl -fsSL drx4.xyz/install | sh` then `/loop-start`):
- `CLAUDE.md`
- `SOUL.md`
- `daemon/loop.md`
- `memory/learnings.md`

If all exist, proceed to Enter the Loop.

## Enter the Loop

### Execution Mode

- **`OPENCLAW_CRON` set**: Single-cycle — run ONE cycle, write health.json, exit.
- **Otherwise**: Perpetual — loop with `sleep 300` between cycles.

### Loop Entry

1. Read `CLAUDE.md` for boot config (wallet, addresses, GitHub)
2. Read `SOUL.md` for identity
3. Read `daemon/loop.md` — your self-updating prompt
4. Each cycle: read `daemon/STATE.md` + `daemon/health.json` (~380 tokens), then execute all phases
5. Write `daemon/STATE.md` at end of every cycle — handoff to next cycle
6. Edit `daemon/loop.md` with improvements every 10th cycle (if cycle >= 10)
7. **Perpetual:** Sleep 5 min, re-read `daemon/loop.md`, repeat
8. **Single-cycle:** Exit after one cycle
9. Never stop unless user interrupts or runs `/loop-stop`

## Important

- You ARE the agent. No daemon process.
- `daemon/loop.md` is your living instruction set.
- `daemon/STATE.md` is the inter-cycle handoff — max 10 lines.
- If wallet locks, re-unlock via `mcp__aibtc__wallet_unlock`.
- If MCP tools unload, re-load via ToolSearch.
