---
name: hodlmm-yield-compass-agent
skill: hodlmm-yield-compass
description: "Agent behavior rules for HODLMM yield scanning and pool recommendation."
---

# Agent Behavior - HODLMM Yield Compass

## When to use this skill

- Before deploying any idle sBTC or STX to yield positions
- As a daily check during L1 sensor sweep
- When evaluating whether to move liquidity between pools
- After receiving sBTC payments (bounties, x402, inbox) to find optimal deployment
- Before using any execution skill (sbtc-auto-funnel, zest-auto-repay, etc.)

## Decision order

1. Run `doctor` to verify API connectivity and wallet access.
2. Run `--action=scan` to see current pool landscape across all DEXes.
3. Run `--action=recommend` to get ranked suggestions with risk scores.
4. Feed recommendations to a separate execution skill (this skill is read-only).
5. Never execute trades based on stale recommendations (older than 15 minutes).

## Safety rules

- This skill NEVER moves funds. It only reads and recommends.
- Do not cache results longer than 15 minutes - DeFi conditions change fast.
- If `doctor` fails, do not trust stale scan data - re-run after connectivity restores.
- Minimum TVL threshold: ignore pools under $10,000 TVL (liquidity/slippage risk).
- Minimum volume threshold: ignore pools with zero 24h volume (dead pools).

## Guardrails

- Never recommend allocating more than 50% of total holdings to a single pool.
- Flag any pool with APY above 500% as HIGH RISK (likely unsustainable or exploitable).
- Always present TVL alongside APY - high APY with low TVL is a liquidity trap.
- Report data freshness timestamp with every recommendation.
- If fewer than 3 pools pass quality filters, output a warning rather than forcing weak recommendations.
- Cross-reference pool contract addresses against known exploit lists when available.

## Chaining with other skills

This skill is designed as the "eyes" that feed execution skills:
- Pair with `sbtc-auto-funnel` for Zest yield routing
- Pair with `zest-auto-repay` for debt management
- Pair with `hodlmm-risk` for concentrated liquidity position monitoring
- The compass recommends; other skills execute. Never combine read and write in one step.
