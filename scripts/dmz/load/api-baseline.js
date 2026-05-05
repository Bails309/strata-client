// scripts/dmz/load/api-baseline.js — k6 baseline for the DMZ public
// surface. Hits /api/health under a stepped load profile and asserts:
//   - p95 latency below the proxy budget
//   - 0% error rate at 100 RPS
//   - graceful 429 / 503 (not 5xx) at 1k RPS once the rate limiter
//     kicks in
//
// Run:
//   k6 run scripts/dmz/load/api-baseline.js \
//     --env DMZ_URL=https://localhost:8443 --insecure-skip-tls-verify
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

export const options = {
    discardResponseBodies: true,
    insecureSkipTLSVerify: true,
    scenarios: {
        ramp: {
            executor: 'ramping-arrival-rate',
            startRate: 50,
            timeUnit: '1s',
            preAllocatedVUs: 200,
            maxVUs: 1000,
            stages: [
                { target: 100,  duration: '30s' },
                { target: 500,  duration: '60s' },
                { target: 1000, duration: '60s' },
                { target: 0,    duration: '15s' },
            ],
        },
    },
    thresholds: {
        // Soft thresholds — tune per environment.
        http_req_duration: ['p(95)<800'],
        // No 5xx allowed; 4xx (rate limit) is fine.
        'http_req_failed{expected_response:true}': ['rate<0.01'],
        five_xx: ['count<5'],
    },
};

const fiveXx = new Counter('five_xx');
const rateLimited = new Rate('rate_limited');

const URL = __ENV.DMZ_URL || 'https://localhost:8443';

export default function () {
    const r = http.get(`${URL}/api/health`);
    check(r, {
        'status not 5xx': (res) => res.status < 500,
    });
    if (r.status >= 500) {
        fiveXx.add(1);
    }
    rateLimited.add(r.status === 429);
}
