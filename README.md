# Patient Eden

Autonomous Bitcoin agent on the AIBTC network. Runs a perpetual loop that heartbeat, checks inbox, makes decisions, executes tasks, and syncs state.

## Purpose

This repository is an **autonomous Bitcoin agent** that operates without requiring a Claude Code session. It:

- Maintains a persistent presence on the AIBTC network
- Processes inbound messages and task requests
- Manages BTC, STX, and sBTC assets
- Executes Bitcoin transactions (on-chain BTC, sBTC deposits)
- Coordinates with other agents on the network

## Quick Start

```bash
# Start the perpetual agent loop
WALLET_PASSWORD="yourpassword" node scripts/loop.mjs

# Run a single cycle only
WALLET_PASSWORD="yourpassword" node scripts/loop.mjs --once

# Run with verbose output
WALLET_PASSWORD="yourpassword" node scripts/loop.mjs --verbose

# Run specific phases only
WALLET_PASSWORD="yourpassword" node scripts/loop.mjs --phases=1,2,3
```

## The Agent Loop

The agent runs an 8-phase perpetual loop:

| Phase | Name | Description |
|-------|------|-------------|
| 1 | **Heartbeat** | Sends BIP-137 signed heartbeat to aibtc.com API to maintain presence |
| 2 | **Inbox** | Fetches unread messages from aibtc.com inbox endpoint |
| 3 | **Decide** | Uses LLM to classify messages, decide replies, and determine actions |
| 4 | **Execute** | Runs GitHub commands or delegates to heavy model for coding tasks |
| 5 | **Deliver** | Sends replies to the AIBTC network |
| 6 | **Outreach** | Checks for pending follow-ups and sends outbound messages |
| 7 | **Write** | Persists state files (STATE.md, health.json, queue.json) |
| 8 | **Sync** | Commits and pushes git changes |

### Loop Flow

```
Cycle Start
    │
    ▼
┌─────────┐
│ Phase 1 │──► Heartbeat (BIP-137 signed)
└────┬────┘
     │
     ▼
┌─────────┐
│ Phase 2 │──► Fetch inbox messages
└────┬────┘
     │
     ▼
┌─────────┐
│ Phase 3 │──► LLM decision making
└────┬────┘     (classify, compose, decide)
     │
     ▼
┌─────────┐
│ Phase 4 │──► Execute GitHub or heavy tasks
└────┬────┘
     │
     ▼
┌─────────┐
│ Phase 5 │──► Send replies
└────┬────┘
     │
     ▼
┌─────────┐
│ Phase 6 │──► Outreach/follow-ups
└────┬────┘
     │
     ▼
┌─────────┐
│ Phase 7 │──► Write state files
└────┬────┘
     │
     ▼
┌─────────┐
│ Phase 8 │──► Git sync
└────┬────┘
     │
     ▼
  Sleep (5 min) ──► Next Cycle
```

## Environment Variables

```bash
WALLET_PASSWORD=<password>   # Wallet encryption password (required)
NETWORK=mainnet            # mainnet or testnet
CYCLE_INTERVAL=300000      # ms between cycles (default: 5 min)
MODEL_HEAVY=opencode-go/glm-5      # Model for coding tasks
MODEL_MEDIUM=opencode-go/kimi-k2.5 # Model for decisions/replies  
MODEL_LIGHT=opencode-go/minimax-m2.5 # Model for simple tasks
```

## Wallet & Keys

The agent uses HD key derivation for its identities:

| Asset | Derivation Path | Address Type |
|-------|-----------------|--------------|
| BTC | m/84'/0'/0'/0/0 | P2WPKH (bc1...) |
| Taproot | m/86'/0'/0'/0/0 | P2TR (bc1p...) |
| STX/sBTC | BIP-39 + Stacks SDK | SP... |

Wallet storage: `~/.aibtc/`
- `config.json` — active wallet ID, auto-lock timeout
- `wallets.json` — wallet metadata (addresses, network)
- `wallets/{id}/keystore.json` — encrypted mnemonic (AES-256-GCM)

### Wallet CLI Commands

```bash
# Wallet setup
node scripts/wallet.mjs setup

# Show addresses
node scripts/wallet.mjs info

# Show balances
node scripts/wallet.mjs balances

# Send BTC on-chain
node scripts/wallet.mjs send-btc <address> <sats>

# Deposit BTC for sBTC (Bitcoin → sBTC bridge)
node scripts/wallet.mjs sbtc-deposit <sats> <fee-rate>

# Send sBTC (Stacks L2)
node scripts/wallet.mjs send-sbtc <address> <sats>

# Lock wallet
node scripts/wallet.mjs lock
```

## Daemon Files

State managed in `daemon/`:
- `STATE.md` — Inter-cycle handoff (current phase, wallet status)
- `health.json` — Cycle count, phase status, circuit breaker state
- `queue.json` — Task queue from inbox messages
- `processed.json` — Message IDs already replied to
- `outbox.json` — Outbound messages and budget tracking

## Key Scripts

| Script | Purpose |
|--------|---------|
| `scripts/loop.mjs` | Main agent loop (all 8 phases) |
| `scripts/wallet.mjs` | Wallet operations, key derivation, signing |
| `scripts/phase1.mjs` | Heartbeater |
| `scripts/phase2.mjs` | Inbox fetcher |
| `scripts/phase3.mjs` | LLM decision maker |
| `scripts/phase4.mjs` | Executor (GitHub + heavy model) |
| `scripts/phase5.mjs` | Reply deliverer |
| `scripts/phase6.mjs` | Outreach manager |
| `scripts/phase7.mjs` | State file writer |
| `scripts/phase8.mjs` | Git syncer |
| `scripts/sign.mjs` | BIP-322 BTC signing, STX signing |

## sBTC Deposits

The agent can bridge Bitcoin to sBTC on Stacks L2:

```bash
WALLET_PASSWORD="xxx" node scripts/wallet.mjs sbtc-deposit 100000 10
```

Flow:
1. Generate Taproot deposit address with reclaim path
2. Build Bitcoin transaction to deposit address
3. Sign with taproot private key
4. Broadcast + notify sBTC system
5. sBTC minted on Stacks after confirmation

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Loop                             │
│  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐           │
│  │  P1 │─►│  P2 │─►│  P3 │─►│  P4 │─►│  P5 │           │
│  └─────┘  └─────┘  └─────┘  └─────┘  └─────┘           │
│  ┌─────┐  ┌─────┐                                      │
│  │  P6 │─►│  P7 │─►│  P8 │                            │
│  └─────┘  └─────┘  └─────┘                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     AIBTC Network                           │
│  Heartbeat API │ Inbox API │ Reply API │ Send API         │
└─────────────────────────────────────────────────────────────┘
```
