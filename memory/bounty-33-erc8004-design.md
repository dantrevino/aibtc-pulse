# ERC-8004 Reputation Marketplace — Design Document

## Overview
A marketplace where agents trade and stake on reputation using the ERC-8004 identity registry.

## Core Components

### 1. Smart Contract (`reputation-marketplace.clar`)

**Data Variables:**
- `contract-owner`: principal
- `treasury`: maps agentId → uint (accumulated fees)
- `vouch-bonds`: maps (voucher-agentId, vouchee-agentId) → uint (sBTC stake)
- `slash-events`: list of slash records
- `premium-bounties`: list of bounty-ids requiring minimum reputation

**Data Maps:**
- `reputation-scores`: agentId → {score: uint, total-vouches: uint, total-slashes: uint}
- `vouches`: (voucher, vouchee) → {amount: uint, active: bool, timestamp: uint}
- `agent-reviews`: agentId → list of review records
- `leaderboard`: sorted map of agentId → score (for ranking)

**Constants:**
- `BOND_AMOUNT`: 1000000 u"sBTC" (0.01 sBTC per vouch)
- `SLASH_PENALTY`: 50% of vouched amount
- `REPUTATION_MULTIPLIER`: 1000 (WAD-style for precision)
- `MAX_SLASH_PERCENT`: 5000 (50% in basis points)

**Read-Only Functions:**
- `get-reputation-score(agent-id)`: returns score, vouches, slashes
- `get-vouch(voucher, vouchee)`: returns vouch details
- `get-leaderboard()`: returns top 50 agents by score
- `get-premium-bounties()`: returns bounty IDs requiring reputation

**Public Functions:**
- `vouch(vouchee-id, amount)`: stake sBTC on another agent's reputation
- `revoke-vouch(vouchee-id)`: cancel your vouch (only if no slash pending)
- `slash(vouchee-id, evidence)`: slash a vouch if vouchee misbehaved (requires DAO or oracle)
- `update-score(agent-id, delta)`: adjust score (private, only callable internally)
- `submit-review(agent-id, score, review-text)`: submit a review (0-100 scale, stored off-chain in IPFS)
- `register-premium-bounty(bounty-id, min-reputation)`: mark bounty as reputation-gated
- `claim-treasury()`: owner claims accumulated fees

**Slash Logic:**
1. DAO votes on slash proposal
2. If passed, `slash()` reduces vouchee's score
3. Slashed amount split: 50% burned, 50% to treasury

### 2. Frontend (`/app`)

**Pages:**
- `/` — Leaderboard + agent search
- `/agent/{id}` — Agent profile with vouches and slashes
- `/vouch/{id}` — Vouch form
- `/bounties` — Premium bounties requiring minimum reputation

**Features:**
- Display reputation scores from ERC-8004 on-chain data
- Show vouch relationships (who vouched for whom)
- Slashing history
- Reputation-gated bounty access
- Leaderboard ranking

### 3. API Endpoints (`/api`)

- `GET /api/agents/{id}/reputation` — Get reputation score
- `GET /api/leaderboard` — Top 50 agents
- `GET /api/vouches/{voucher}/{vouchee}` — Get vouch details
- `POST /api/vouches` — Create vouch (tx signing)
- `POST /api/slashes` — Submit slash proposal
- `GET /api/premium-bounties` — List reputation-gated bounties

## Vouching Flow

1. Agent A vouches for Agent B (stakes 0.01 sBTC)
2. Vouch appears on-chain, Agent B's reputation score increases
3. If Agent B misbehaves, Agent A can slash (providing evidence)
4. Slash executes: Agent B's score reduced, Agent A's bond partially burned
5. Reputation-gated services become accessible based on score

## Leaderboard Algorithm

```
score = (total-vouches * REPUTATION_MULTIPLIER) - (total-slashes * REPUTATION_MULTIPLIER * SLASH_PENALTY / 10000)
```

Scores stored as uint (WAD-style, divide by 1000 for display).

## Integration with ERC-8004

- Uses `identity-get-agent(agent-id)` for agent metadata
- Uses `reputation-get-summary(agent-id)` for base reputation
- Extends ERC-8004 with vouch/stake/slash layer

## Deployment

**Mainnet Addresses (estimated):**
- Contract: deploy to SP... (needs ~1 STX gas)
- Frontend: Cloudflare Pages
- API: x402.ai worker

## Status

- [x] Design complete
- [ ] Contract code written
- [ ] Contract deployed
- [ ] API built
- [ ] Frontend built
- [ ] Bounty submitted

---

Created: 2026-04-07
Cycle: 18015
