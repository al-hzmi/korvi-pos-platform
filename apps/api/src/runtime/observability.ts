import { timingSafeEqual } from 'node:crypto';
import type { ApiConfig } from '../config.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

interface DurationHistogram {
  count: number;
  sumSeconds: number;
  readonly cumulativeBuckets: number[];
}

function constantTimeBearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  const separator = header.indexOf(' ');
  if (separator <= 0 || header.slice(0, separator).toLowerCase() !== 'bearer') return false;
  const candidate = header.slice(separator + 1);
  if (candidate.length === 0) return false;

  const candidateBytes = Buffer.from(candidate, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function statusClass(statusCode: number): string {
  if (statusCode >= 100 && statusCode <= 599) return `${Math.floor(statusCode / 100)}xx`;
  return 'other';
}

function incrementRequest(
  requests: Map<string, Map<string, Map<string, number>>>,
  method: string,
  route: string,
  responseClass: string,
): void {
  let byRoute = requests.get(method);
  if (byRoute === undefined) {
    byRoute = new Map();
    requests.set(method, byRoute);
  }
  let byStatus = byRoute.get(route);
  if (byStatus === undefined) {
    byStatus = new Map();
    byRoute.set(route, byStatus);
  }
  byStatus.set(responseClass, (byStatus.get(responseClass) ?? 0) + 1);
}

function recordDuration(
  durations: Map<string, Map<string, DurationHistogram>>,
  method: string,
  route: string,
  seconds: number,
): void {
  let byRoute = durations.get(method);
  if (byRoute === undefined) {
    byRoute = new Map();
    durations.set(method, byRoute);
  }
  let histogram = byRoute.get(route);
  if (histogram === undefined) {
    histogram = {
      count: 0,
      sumSeconds: 0,
      cumulativeBuckets: DURATION_BUCKETS_SECONDS.map(() => 0),
    };
    byRoute.set(route, histogram);
  }

  histogram.count += 1;
  histogram.sumSeconds += seconds;
  for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
    if (seconds <= DURATION_BUCKETS_SECONDS[index]!) histogram.cumulativeBuckets[index]! += 1;
  }
}

/**
 * Process-local, deliberately low-cardinality telemetry.
 *
 * Financial, inventory, tax, tenant, user and product values never become
 * metric labels. Routes are the Fastify route patterns, not raw URLs, so IDs
 * and query strings cannot create unbounded series or leak merchant data.
 */
export function registerOperationalObservability(app: FastifyInstance, config: ApiConfig): void {
  const startedAt = new WeakMap<FastifyRequest, bigint>();
  const requests = new Map<string, Map<string, Map<string, number>>>();
  const durations = new Map<string, Map<string, DurationHistogram>>();
  const readiness = { ready: 0, notReady: 0 };
  let inFlight = 0;

  app.addHook('onRequest', (request, reply, done) => {
    startedAt.set(request, process.hrtime.bigint());
    inFlight += 1;
    reply.header('x-request-id', request.id);
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const started = startedAt.get(request);
    startedAt.delete(request);
    inFlight = Math.max(0, inFlight - 1);

    const route = request.routeOptions.url ?? 'unmatched';
    const method = request.method;
    incrementRequest(requests, method, route, statusClass(reply.statusCode));

    if (started !== undefined) {
      const elapsedNanoseconds = process.hrtime.bigint() - started;
      recordDuration(durations, method, route, Number(elapsedNanoseconds) / 1_000_000_000);
    }

    if (route === '/ready') {
      if (reply.statusCode === 200) readiness.ready += 1;
      else readiness.notReady += 1;
    }
    done();
  });

  const metricsToken = config.METRICS_AUTH_TOKEN;
  if (metricsToken === undefined) return;

  app.get('/metrics', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!constantTimeBearerMatches(request.headers.authorization, metricsToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const lines: string[] = [
      '# HELP korvi_process_uptime_seconds Process uptime in seconds.',
      '# TYPE korvi_process_uptime_seconds gauge',
      `korvi_process_uptime_seconds ${process.uptime().toFixed(3)}`,
      '# HELP korvi_http_in_flight_requests Requests currently executing in this process.',
      '# TYPE korvi_http_in_flight_requests gauge',
      `korvi_http_in_flight_requests ${inFlight}`,
      '# HELP korvi_http_requests_total Completed HTTP requests by stable route pattern and status class.',
      '# TYPE korvi_http_requests_total counter',
    ];

    for (const [method, byRoute] of requests) {
      for (const [route, byStatus] of byRoute) {
        for (const [responseClass, count] of byStatus) {
          lines.push(
            `korvi_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(responseClass)}"} ${count}`,
          );
        }
      }
    }

    lines.push(
      '# HELP korvi_http_request_duration_seconds Request latency by stable route pattern.',
      '# TYPE korvi_http_request_duration_seconds histogram',
    );
    for (const [method, byRoute] of durations) {
      for (const [route, histogram] of byRoute) {
        const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
        for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
          lines.push(
            `korvi_http_request_duration_seconds_bucket{${labels},le="${DURATION_BUCKETS_SECONDS[index]}"} ${histogram.cumulativeBuckets[index]}`,
          );
        }
        lines.push(
          `korvi_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${histogram.count}`,
          `korvi_http_request_duration_seconds_sum{${labels}} ${histogram.sumSeconds.toFixed(9)}`,
          `korvi_http_request_duration_seconds_count{${labels}} ${histogram.count}`,
        );
      }
    }

    lines.push(
      '# HELP korvi_readiness_responses_total Readiness responses observed by this process.',
      '# TYPE korvi_readiness_responses_total counter',
      `korvi_readiness_responses_total{result="ready"} ${readiness.ready}`,
      `korvi_readiness_responses_total{result="not_ready"} ${readiness.notReady}`,
      '',
    );

    return reply.type(PROMETHEUS_CONTENT_TYPE).send(lines.join('\n'));
  });
}
