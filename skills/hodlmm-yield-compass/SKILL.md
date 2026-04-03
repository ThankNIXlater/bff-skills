---
name: hodlmm-yield-compass
description: "Scan Stacks DeFi pools and HODLMM concentrated liquidity to find optimal sBTC/STX yield deployment"
metadata:
  author: "ThankNIXlater"
  author-agent: "Zen Rocket"
  user-invocable: "false"
  arguments: "doctor | run --action=scan | run --action=recommend"
  entry: "hodlmm-yield-compass/hodlmm-yield-compass.ts"
  requires: "wallet"
  tags: "defi, yield, hodlmm, bitflow, analytics"
---

# HODLMM Yield Compass

## What it does

Scans all Stacks DeFi liquidity pools across multiple DEXes and HODLMM concentrated liquidity positions to find where sBTC and STX earn the highest risk-adjusted yield. Returns ranked recommendations with APY, TVL, volume, and risk scoring.

## Why agents need it

Agents earning sBTC from bounties, signals, and x402 payments need to deploy idle capital efficiently. With 120+ pools across ALEX, Velar, Arkadiko, StackSwap, and Bitflow HODLMM, manually comparing yields wastes cycles. This skill automates pool discovery and ranking so agents always know the best place for their sats.

## Safety notes

- **Read-only skill.** Does NOT move funds, sign transactions, or write to chain.
- All data from public APIs (STXTools aggregator, Hiro, Bitflow).
- No wallet write access required - only reads address for balance context.

## Commands

### `doctor`

Pre-flight: checks API connectivity, wallet readability, network status.

```bash
bun run hodlmm-yield-compass/hodlmm-yield-compass.ts doctor
```

### `run --action=scan`

Fetch all pools, filter for sBTC and STX pairs, return raw pool data with TVL and volume.

```bash
bun run hodlmm-yield-compass/hodlmm-yield-compass.ts run --action=scan
```

### `run --action=recommend`

Analyze pools and return top 5 yield opportunities ranked by risk-adjusted APY. Applies minimum TVL filter, flags unsustainable APY, and diversification limits.

```bash
bun run hodlmm-yield-compass/hodlmm-yield-compass.ts run --action=recommend
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{ "status": "success", "action": "scan", "data": { "pools": [...], "timestamp": "..." }, "error": null }
```

**Error:**
```json
{ "status": "error", "action": "scan", "data": {}, "error": { "code": "API_UNREACHABLE", "message": "STXTools API returned 503", "next": "Retry in 60 seconds" } }
```

## Known constraints

- STXTools API has undocumented rate limits - skill implements exponential backoff
- HODLMM is in beta - concentrated liquidity pool data may be limited or change format
- APY calculations use trailing 24h fee data when available; falls back to 7d average
- Pools with zero 24h volume are excluded from recommendations (dead pool filter)
