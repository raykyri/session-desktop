// `GET /metrics` in Prometheus text format (`13-deployment-fly.md` §7).
//
// A small registry rather than `prom-client`: the endpoint has exactly one
// histogram and a handful of gauges, and the gauges are read out of SQLite at
// scrape time instead of being mirrored in counters the process would have to
// keep consistent with the database across a restart.

import { statSync, statfsSync } from "node:fs";

import type { Config } from "./config.js";
import type { ServerDeps } from "./deps.js";
import type { HealthState } from "./health.js";

/** Seconds. The long tail matters here — a research run's SSE stream is minutes
 * long — but the buckets stop at 30s because anything past that is the stream
 * and not a request the histogram can say anything useful about. */
export const LATENCY_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Coarse route labels. The histogram is keyed by prefix rather than by path so
 * a token, a node id, or a 404-scanner cannot multiply the series. */
export function routeLabel(pathname: string): string {
  if (pathname === "/healthz" || pathname === "/metrics") {
    return pathname;
  }
  for (const prefix of ["/api/trpc", "/auth", "/uploads", "/a", "/__session/fonts"]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return "static";
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

interface Series {
  method: string;
  route: string;
  status: string;
  counts: number[];
  sum: number;
  count: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs: Readonly<Record<string, string>>): string {
  const body = Object.entries(pairs)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
  return body === "" ? "" : `{${body}}`;
}

/** The request-latency histogram. Everything else is sampled on demand. */
export class MetricsRegistry {
  readonly #series = new Map<string, Series>();

  observeRequest(method: string, pathname: string, status: number, seconds: number): void {
    const normalizedMethod = KNOWN_METHODS.has(method) ? method : "other";
    const route = routeLabel(pathname);
    const statusLabel = statusClass(status);
    const key = [normalizedMethod, route, statusLabel].join(" ");
    let series = this.#series.get(key);
    if (!series) {
      series = {
        method: normalizedMethod,
        route,
        status: statusLabel,
        counts: new Array<number>(LATENCY_BUCKETS.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.#series.set(key, series);
    }
    let bucket = LATENCY_BUCKETS.findIndex((upper) => seconds <= upper);
    if (bucket === -1) {
      bucket = LATENCY_BUCKETS.length;
    }
    series.counts[bucket] = (series.counts[bucket] ?? 0) + 1;
    series.sum += seconds;
    series.count += 1;
  }

  /** The histogram's lines. Buckets are cumulative, as the format requires. */
  render(): string[] {
    const lines = [
      "# HELP session_http_request_duration_seconds Request latency by route class.",
      "# TYPE session_http_request_duration_seconds histogram",
    ];
    for (const series of this.#series.values()) {
      const base = { method: series.method, route: series.route, status: series.status };
      let cumulative = 0;
      for (const [index, upper] of LATENCY_BUCKETS.entries()) {
        cumulative += series.counts[index] ?? 0;
        lines.push(
          `session_http_request_duration_seconds_bucket${labels({ ...base, le: String(upper) })} ${cumulative}`,
        );
      }
      cumulative += series.counts[LATENCY_BUCKETS.length] ?? 0;
      lines.push(
        `session_http_request_duration_seconds_bucket${labels({ ...base, le: "+Inf" })} ${cumulative}`,
      );
      lines.push(
        `session_http_request_duration_seconds_sum${labels(base)} ${series.sum.toFixed(6)}`,
      );
      lines.push(`session_http_request_duration_seconds_count${labels(base)} ${series.count}`);
    }
    return lines;
  }
}

export interface ProviderRunCount {
  provider: string;
  count: number;
}

export interface ProviderDailyUsage {
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
}

/** Claimed rows are the runs with an open provider stream; unclaimed ones are
 * the queue the admission caps hold back (`05-run-lifecycle-and-streaming.md`
 * §8). Read with SQL rather than through the repos: a scrape should not take
 * the write path's transactions or map rows it will not use. */
export function activeRunsByProvider(deps: ServerDeps): ProviderRunCount[] {
  return deps.db.$client
    .prepare(
      "SELECT provider, count(*) AS count FROM run_queue WHERE claimed_at IS NOT NULL GROUP BY provider ORDER BY provider",
    )
    .all() as ProviderRunCount[];
}

export function queueDepth(deps: ServerDeps): number {
  const row = deps.db.$client
    .prepare("SELECT count(*) AS count FROM run_queue WHERE claimed_at IS NULL")
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function startOfUtcDay(at: number): number {
  return Math.floor(at / 86_400_000) * 86_400_000;
}

/** Tokens and cost for the current UTC day, which is the window the daily
 * limits are enforced over (`06-auth-and-users.md` §8). */
export function dailyUsageByProvider(deps: ServerDeps, at = Date.now()): ProviderDailyUsage[] {
  const day = startOfUtcDay(at);
  return deps.db.$client
    .prepare(
      `SELECT provider,
              sum(input_tokens) AS inputTokens,
              sum(output_tokens) AS outputTokens,
              sum(cost_estimate_micros) AS costMicros
         FROM usage_events
        WHERE created_at >= ?
        GROUP BY provider
        ORDER BY provider`,
    )
    .all(day) as ProviderDailyUsage[];
}

/**
 * Free bytes on the filesystem holding the data directory. The volume is the
 * one resource whose exhaustion takes the whole server down rather than one
 * request: every SQLite write fails at once when the mount fills, and uploads
 * are what fill it. `bavail` rather than `bfree` — the reserved blocks are not
 * this process's to use. Unreadable (a path that does not exist yet) is 0,
 * which is a gauge an alert can read rather than a scrape that fails.
 */
export function volumeFreeBytes(path: string): number {
  try {
    const stats = statfsSync(path);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return 0;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface RenderMetricsOptions {
  deps: ServerDeps;
  config: Config;
  registry: MetricsRegistry;
  health: HealthState;
  at?: number;
}

/** The whole exposition, newline-terminated as the format requires. */
export function renderMetrics(options: RenderMetricsOptions): string {
  const { deps, config, registry, health } = options;
  const lines = [...registry.render()];

  lines.push("# HELP session_ready 1 when the server is admitting requests.");
  lines.push("# TYPE session_ready gauge");
  lines.push(`session_ready ${health === "ready" ? 1 : 0}`);

  lines.push("# HELP session_active_runs Research runs with an open provider stream.");
  lines.push("# TYPE session_active_runs gauge");
  for (const row of activeRunsByProvider(deps)) {
    lines.push(`session_active_runs${labels({ provider: row.provider })} ${row.count}`);
  }

  lines.push("# HELP session_queue_depth Admitted runs waiting for a slot.");
  lines.push("# TYPE session_queue_depth gauge");
  lines.push(`session_queue_depth ${queueDepth(deps)}`);

  lines.push("# HELP session_sse_clients Open event-stream connections.");
  lines.push("# TYPE session_sse_clients gauge");
  lines.push(`session_sse_clients ${deps.eventBus.connectionCount()}`);

  lines.push("# HELP session_volume_free_bytes Free space on the data volume.");
  lines.push("# TYPE session_volume_free_bytes gauge");
  lines.push(`session_volume_free_bytes ${volumeFreeBytes(config.dataDir)}`);

  lines.push("# HELP session_db_size_bytes Size of session.db and its WAL.");
  lines.push("# TYPE session_db_size_bytes gauge");
  lines.push(`session_db_size_bytes${labels({ file: "db" })} ${fileSize(config.databasePath)}`);
  lines.push(
    `session_db_size_bytes${labels({ file: "wal" })} ${fileSize(`${config.databasePath}-wal`)}`,
  );

  const usage = dailyUsageByProvider(deps, options.at ?? Date.now());
  lines.push("# HELP session_daily_tokens Tokens billed today (UTC), by provider.");
  lines.push("# TYPE session_daily_tokens gauge");
  for (const row of usage) {
    lines.push(
      `session_daily_tokens${labels({ provider: row.provider, direction: "input" })} ${row.inputTokens ?? 0}`,
    );
    lines.push(
      `session_daily_tokens${labels({ provider: row.provider, direction: "output" })} ${row.outputTokens ?? 0}`,
    );
  }
  lines.push("# HELP session_daily_cost_usd Estimated spend today (UTC), by provider.");
  lines.push("# TYPE session_daily_cost_usd gauge");
  for (const row of usage) {
    lines.push(
      `session_daily_cost_usd${labels({ provider: row.provider })} ${((row.costMicros ?? 0) / 1_000_000).toFixed(6)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
