#!/usr/bin/env bun
/**
 * HODLMM Yield Compass - Find optimal sBTC/STX yield across Stacks DeFi
 *
 * Commands: doctor | run
 * Actions (run): scan | recommend
 *
 * Built by Zen Rocket (ThankNIXlater) for AIBTC x Bitflow Skills Competition.
 * Read-only skill - never moves funds or signs transactions.
 */

import { Command } from "commander";

// -- Constants ---------------------------------------------------------------

const STXTOOLS_API = "https://api.stxtools.io";
const HIRO_API = "https://api.hiro.so";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Safety thresholds - hardcoded floors
const MIN_TVL_USD = 10_000;        // ignore pools under $10K TVL
const MIN_VOLUME_24H = 0;          // must have some trading activity
const MAX_SAFE_APY = 500;          // flag anything above 500% as high risk
const MAX_SINGLE_POOL_PCT = 50;    // never recommend >50% in one pool
const MAX_RECOMMENDATIONS = 5;     // top N pools to recommend
const STALE_THRESHOLD_MS = 900_000; // 15 minutes

// -- Types -------------------------------------------------------------------

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface PoolData {
  pool_id: string;
  token_x: string;
  token_y: string;
  tvl_usd: number;
  volume_24h_usd: number;
  fee_rate: number;
  platform: string;
  token_x_symbol: string;
  token_y_symbol: string;
}

interface ScoredPool extends PoolData {
  estimated_apy: number;
  risk_score: number; // 1 (low) to 5 (high)
  risk_flags: string[];
}

// -- Helpers -----------------------------------------------------------------

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errorOutput(action: string, code: string, message: string, next: string): SkillOutput {
  return { status: "error", action, data: {}, error: { code, message, next } };
}

async function fetchWithTimeout(url: string, timeoutMs: number = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// -- API Reads ---------------------------------------------------------------

async function fetchPools(): Promise<PoolData[]> {
  // STXTools returns paginated results (10 per page), up to 120 pools total
  const allPools: PoolData[] = [];
  const maxPages = 13;

  for (let page = 1; page <= maxPages; page++) {
    const resp = await fetchWithTimeout(`${STXTOOLS_API}/pools?page=${page}`, 8_000);
    if (!resp.ok) throw new Error(`STXTools API ${resp.status}: ${resp.statusText}`);
    const json = await resp.json() as any;
    const items = json.data || [];
    if (items.length === 0) break;

    for (const p of items) {
      const metrics = p.metrics || {};
      // Extract symbols from contract IDs
      const xContract = String(p.token_x_contract_id || "");
      const yContract = String(p.token_y_contract_id || "");
      const xSymbol = xContract === "stx" ? "STX" : xContract.split(".").pop()?.replace(/-/g, " ") || "?";
      const ySymbol = yContract === "stx" ? "STX" : yContract.split(".").pop()?.replace(/-/g, " ") || "?";

      allPools.push({
        pool_id: p.pool_id || "unknown",
        token_x: xContract,
        token_y: yContract,
        tvl_usd: Number(p.liquidity_usd || 0),
        volume_24h_usd: Number(metrics.volume_1d_usd || 0),
        fee_rate: 0.003, // Default 0.3% - STXTools doesn't expose per-pool fee
        platform: String(p.platform || "unknown"),
        token_x_symbol: xSymbol,
        token_y_symbol: ySymbol,
      });
    }
  }

  return allPools;
}

async function getStxBalance(address: string): Promise<{ stx: number; sbtc: number }> {
  const resp = await fetchWithTimeout(`${HIRO_API}/extended/v1/address/${address}/balances`);
  if (!resp.ok) throw new Error(`Hiro API ${resp.status}: ${resp.statusText}`);
  const data = await resp.json() as any;

  const stxBalance = Number(data?.stx?.balance || 0) / 1e6;
  const ftBalances = data?.fungible_tokens || {};
  const sbtcKey = Object.keys(ftBalances).find((k: string) => k.includes("sbtc-token"));
  const sbtcBalance = sbtcKey ? Number(ftBalances[sbtcKey].balance || 0) : 0;

  return { stx: stxBalance, sbtc: sbtcBalance };
}

// -- Scoring -----------------------------------------------------------------

function estimateApy(pool: PoolData): number {
  // APY from fees: (daily_fees / tvl) * 365
  // daily_fees approximated from volume * fee_rate
  if (pool.tvl_usd <= 0) return 0;
  const dailyFees = pool.volume_24h_usd * (pool.fee_rate || 0.003);
  return (dailyFees / pool.tvl_usd) * 365 * 100;
}

function scoreRisk(pool: PoolData, apy: number): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 1;

  if (pool.tvl_usd < 50_000) { score += 1; flags.push("LOW_TVL"); }
  if (pool.tvl_usd < 20_000) { score += 1; flags.push("VERY_LOW_TVL"); }
  if (apy > MAX_SAFE_APY) { score += 2; flags.push("UNSUSTAINABLE_APY"); }
  if (apy > 100 && apy <= MAX_SAFE_APY) { score += 1; flags.push("HIGH_APY"); }
  if (pool.volume_24h_usd < 1_000) { score += 1; flags.push("LOW_VOLUME"); }

  return { score: Math.min(score, 5), flags };
}

function filterSbtcStxPools(pools: PoolData[]): PoolData[] {
  const targets = ["sbtc", "stx", "wstx", "xbtc", "abtc"];
  return pools.filter((p) => {
    const symbols = [
      p.token_x_symbol.toLowerCase(),
      p.token_y_symbol.toLowerCase(),
    ];
    return symbols.some((s) => targets.some((t) => s.includes(t)));
  });
}

// -- Commands ----------------------------------------------------------------

async function doctor(): Promise<void> {
  const checks: Record<string, string> = {};

  // Check STXTools API
  try {
    const resp = await fetchWithTimeout(`${STXTOOLS_API}/pools`, 5_000);
    checks["stxtools_api"] = resp.ok ? `OK (${resp.status})` : `FAIL (${resp.status})`;
  } catch (e: any) {
    checks["stxtools_api"] = `FAIL: ${e.message}`;
  }

  // Check Hiro API
  try {
    const resp = await fetchWithTimeout(`${HIRO_API}/v2/info`, 5_000);
    checks["hiro_api"] = resp.ok ? `OK (${resp.status})` : `FAIL (${resp.status})`;
  } catch (e: any) {
    checks["hiro_api"] = `FAIL: ${e.message}`;
  }

  // Check wallet env
  const walletAddr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS || "";
  if (walletAddr) {
    checks["wallet"] = `Found: ${walletAddr.slice(0, 8)}...${walletAddr.slice(-6)}`;
    try {
      const bal = await getStxBalance(walletAddr);
      checks["stx_balance"] = `${bal.stx.toFixed(2)} STX`;
      checks["sbtc_balance"] = `${bal.sbtc} sats`;
    } catch (e: any) {
      checks["balance_read"] = `FAIL: ${e.message}`;
    }
  } else {
    checks["wallet"] = "No STACKS_ADDRESS env var - set it for balance context";
  }

  const allOk = !Object.values(checks).some((v) => v.startsWith("FAIL"));

  emit({
    status: allOk ? "success" : "blocked",
    action: "doctor",
    data: { checks, timestamp: new Date().toISOString() },
    error: allOk ? null : { code: "PREFLIGHT_FAIL", message: "One or more checks failed", next: "Fix failing checks and retry" },
  });
}

async function scan(): Promise<void> {
  try {
    const allPools = await fetchPools();
    const relevant = filterSbtcStxPools(allPools);

    // Sort by TVL descending
    relevant.sort((a, b) => b.tvl_usd - a.tvl_usd);

    emit({
      status: "success",
      action: "scan",
      data: {
        total_pools: allPools.length,
        sbtc_stx_pools: relevant.length,
        pools: relevant.map((p) => ({
          pair: `${p.token_x_symbol}/${p.token_y_symbol}`,
          platform: p.platform,
          tvl_usd: Math.round(p.tvl_usd),
          volume_24h_usd: Math.round(p.volume_24h_usd),
          fee_rate: p.fee_rate,
          estimated_apy_pct: Number(estimateApy(p).toFixed(2)),
        })),
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  } catch (e: any) {
    emit(errorOutput("scan", "FETCH_FAILED", e.message, "Check API connectivity with doctor command"));
  }
}

async function recommend(): Promise<void> {
  try {
    const allPools = await fetchPools();
    const relevant = filterSbtcStxPools(allPools);

    // Score and filter
    const scored: ScoredPool[] = relevant
      .map((p) => {
        const apy = estimateApy(p);
        const { score, flags } = scoreRisk(p, apy);
        return { ...p, estimated_apy: apy, risk_score: score, risk_flags: flags };
      })
      .filter((p) => p.tvl_usd >= MIN_TVL_USD)
      .filter((p) => p.volume_24h_usd > MIN_VOLUME_24H)
      .filter((p) => p.estimated_apy > 0);

    // Sort by risk-adjusted APY (apy / risk_score)
    scored.sort((a, b) => (b.estimated_apy / b.risk_score) - (a.estimated_apy / a.risk_score));

    const top = scored.slice(0, MAX_RECOMMENDATIONS);

    if (top.length === 0) {
      emit({
        status: "blocked",
        action: "recommend",
        data: {
          total_scanned: allPools.length,
          sbtc_stx_pools: relevant.length,
          passing_filters: 0,
          warning: "No pools passed quality filters (min TVL $10K, non-zero volume, positive APY)",
        },
        error: { code: "NO_QUALIFYING_POOLS", message: "No pools met minimum quality thresholds", next: "Lower thresholds or check if DeFi activity is paused" },
      });
      return;
    }

    emit({
      status: "success",
      action: "recommend",
      data: {
        total_scanned: allPools.length,
        sbtc_stx_pools: relevant.length,
        recommendations: top.map((p, i) => ({
          rank: i + 1,
          pair: `${p.token_x_symbol}/${p.token_y_symbol}`,
          platform: p.platform,
          estimated_apy_pct: Number(p.estimated_apy.toFixed(2)),
          tvl_usd: Math.round(p.tvl_usd),
          volume_24h_usd: Math.round(p.volume_24h_usd),
          risk_score: p.risk_score,
          risk_flags: p.risk_flags,
          max_allocation_pct: MAX_SINGLE_POOL_PCT,
        })),
        safety: {
          min_tvl_filter: MIN_TVL_USD,
          max_single_pool_pct: MAX_SINGLE_POOL_PCT,
          high_apy_threshold: MAX_SAFE_APY,
          stale_after_ms: STALE_THRESHOLD_MS,
        },
        timestamp: new Date().toISOString(),
      },
      error: null,
    });
  } catch (e: any) {
    emit(errorOutput("recommend", "ANALYSIS_FAILED", e.message, "Run doctor to check API connectivity"));
  }
}

// -- CLI ---------------------------------------------------------------------

const program = new Command();

program
  .name("hodlmm-yield-compass")
  .description("Scan Stacks DeFi pools and recommend optimal sBTC/STX yield deployment")
  .version("1.0.0");

program
  .command("doctor")
  .description("Pre-flight checks for API connectivity and wallet")
  .action(doctor);

program
  .command("run")
  .description("Execute scan or recommend actions")
  .requiredOption("--action <action>", "Action to perform: scan | recommend")
  .action(async (opts: { action: string }) => {
    switch (opts.action) {
      case "scan":
        await scan();
        break;
      case "recommend":
        await recommend();
        break;
      default:
        emit(errorOutput("run", "UNKNOWN_ACTION", `Unknown action: ${opts.action}`, "Use --action=scan or --action=recommend"));
    }
  });

program.parse();
