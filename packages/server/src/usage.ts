import type { LLMTokenUsage } from "@page-assistant/core";
import { envInt } from "./env.js";

/**
 * In-memory usage meter + daily budget. Counts tokens and requests per day so the host
 * can see spend and cap it. Everything resets at UTC midnight (a fresh day key) — no cron
 * needed. This is intentionally lightweight (process-local, not durable); a multi-instance
 * deployment should back this with a shared store, but for a single node it stops silent
 * credit drain.
 */
export interface UsageSnapshot {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number }>;
  byCapability: Record<string, number>;
  budget: { dailyTokenCap: number | null; dailyRequestCap: number | null; exceeded: boolean };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export class UsageMeter {
  private day = todayKey();
  private requests = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number }> = {};
  private byCapability: Record<string, number> = {};

  private roll(): void {
    const t = todayKey();
    if (t !== this.day) {
      this.day = t;
      this.requests = 0;
      this.promptTokens = 0;
      this.completionTokens = 0;
      this.byProvider = {};
      this.byCapability = {};
    }
  }

  /** Record one LLM-backed request's usage. `provider`/`capabilities` are optional. */
  record(opts: { usage?: LLMTokenUsage; provider?: string; capabilities?: string[] }): void {
    this.roll();
    this.requests++;
    const p = opts.usage?.promptTokens ?? 0;
    const c = opts.usage?.completionTokens ?? 0;
    this.promptTokens += p;
    this.completionTokens += c;
    const key = opts.provider || "unknown";
    const bp = (this.byProvider[key] ??= { requests: 0, promptTokens: 0, completionTokens: 0 });
    bp.requests++;
    bp.promptTokens += p;
    bp.completionTokens += c;
    for (const cap of opts.capabilities ?? []) this.byCapability[cap] = (this.byCapability[cap] ?? 0) + 1;
  }

  /** Daily caps from env; null means "no cap". */
  private caps(): { dailyTokenCap: number | null; dailyRequestCap: number | null } {
    // PA_DAILY_BUDGET caps TOKENS/day. PA_DAILY_REQUEST_BUDGET caps REQUESTS/day.
    const tok = process.env.PA_DAILY_BUDGET ? envInt("PA_DAILY_BUDGET", 0) : null;
    const reqs = process.env.PA_DAILY_REQUEST_BUDGET ? envInt("PA_DAILY_REQUEST_BUDGET", 0) : null;
    return { dailyTokenCap: tok && tok > 0 ? tok : null, dailyRequestCap: reqs && reqs > 0 ? reqs : null };
  }

  /** True when today's spend has hit a configured cap. LLM routes should 429 when so. */
  isBudgetExceeded(): boolean {
    this.roll();
    const { dailyTokenCap, dailyRequestCap } = this.caps();
    if (dailyTokenCap !== null && this.promptTokens + this.completionTokens >= dailyTokenCap) return true;
    if (dailyRequestCap !== null && this.requests >= dailyRequestCap) return true;
    return false;
  }

  snapshot(): UsageSnapshot {
    this.roll();
    const caps = this.caps();
    return {
      day: this.day,
      requests: this.requests,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      byProvider: JSON.parse(JSON.stringify(this.byProvider)),
      byCapability: { ...this.byCapability },
      budget: { ...caps, exceeded: this.isBudgetExceeded() },
    };
  }
}

/** Self-contained HTML dashboard (inline CSS, no external assets) for the usage snapshot. */
export function usageDashboardHtml(s: UsageSnapshot): string {
  const esc = (v: unknown) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const providerRows =
    Object.entries(s.byProvider)
      .map(
        ([k, v]) =>
          `<tr><td>${esc(k)}</td><td>${v.requests}</td><td>${v.promptTokens}</td><td>${v.completionTokens}</td></tr>`
      )
      .join("") || `<tr><td colspan="4" class="muted">no usage yet today</td></tr>`;
  const capRows =
    Object.entries(s.byCapability)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
      .join("") || `<tr><td colspan="2" class="muted">no capability calls yet</td></tr>`;
  const budget = s.budget.exceeded
    ? `<span class="badge over">budget exceeded</span>`
    : `<span class="badge ok">within budget</span>`;
  const cap = s.budget.dailyTokenCap ?? s.budget.dailyRequestCap;
  const capLabel = s.budget.dailyTokenCap
    ? `${s.budget.dailyTokenCap} tokens/day`
    : s.budget.dailyRequestCap
    ? `${s.budget.dailyRequestCap} requests/day`
    : "none";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Usage — page-assistant</title>
<style>
:root{--fg:#1a1a1a;--muted:#777;--line:#e5e5e5;--accent:#2563eb}
*{box-sizing:border-box}body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);margin:0;padding:2rem;background:#fafafa}
h1{font-size:1.3rem;margin:0 0 .25rem}.day{color:var(--muted);margin:0 0 1.5rem}
.cards{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:1rem 1.25rem;min-width:140px}
.card .n{font-size:1.6rem;font-weight:600}.card .l{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:1.5rem}
th,td{text-align:left;padding:.55rem .85rem;border-bottom:1px solid var(--line)}th{background:#f5f5f5;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
tr:last-child td{border-bottom:none}.muted{color:var(--muted)}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.8rem;font-weight:600}
.badge.ok{background:#dcfce7;color:#166534}.badge.over{background:#fee2e2;color:#991b1b}
h2{font-size:1rem;margin:1.5rem 0 .5rem}
</style></head><body>
<h1>Usage — page-assistant</h1>
<p class="day">${esc(s.day)} (UTC) · budget: ${esc(capLabel)} · ${budget}</p>
<div class="cards">
  <div class="card"><div class="n">${s.requests}</div><div class="l">Requests</div></div>
  <div class="card"><div class="n">${s.totalTokens}</div><div class="l">Total tokens</div></div>
  <div class="card"><div class="n">${s.promptTokens}</div><div class="l">Prompt</div></div>
  <div class="card"><div class="n">${s.completionTokens}</div><div class="l">Completion</div></div>
</div>
<h2>By provider</h2>
<table><thead><tr><th>Provider</th><th>Requests</th><th>Prompt</th><th>Completion</th></tr></thead><tbody>${providerRows}</tbody></table>
<h2>By capability</h2>
<table><thead><tr><th>Capability</th><th>Invocations</th></tr></thead><tbody>${capRows}</tbody></table>
<p class="muted">In-memory, resets daily (UTC). Not durable across restarts.${cap ? "" : " Set PA_DAILY_BUDGET to cap spend."}</p>
</body></html>`;
}
