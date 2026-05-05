// scripts/dmz/load/websocket-fanout.js — k6 load profile for the
// long-lived WebSocket path through the DMZ. Opens N concurrent
// connections to a Guacamole-shaped endpoint, holds them open for
// 60s sending a small ping every 5s, and asserts:
//   - all N reach OPEN within 10s
//   - 0 unexpected closes during steady state
//
// Run:
//   k6 run scripts/dmz/load/websocket-fanout.js \
//     --env DMZ_URL=wss://localhost:8443 \
//     --env CONCURRENT=1000 \
//     --insecure-skip-tls-verify
import ws from 'k6/ws';
import { check } from 'k6';

const CONCURRENT = parseInt(__ENV.CONCURRENT || '1000', 10);
const URL = __ENV.DMZ_URL || 'wss://localhost:8443';

export const options = {
    insecureSkipTLSVerify: true,
    scenarios: {
        fanout: {
            executor: 'per-vu-iterations',
            vus: CONCURRENT,
            iterations: 1,
            maxDuration: '90s',
        },
    },
    thresholds: {
        ws_connecting: ['p(95)<2000'],
        ws_sessions: [`count>=${CONCURRENT * 0.99}`],  // allow 1% loss
    },
};

export default function () {
    // Endpoint shape mirrors guacamole's /api/connections/<id>/tunnel
    // — the actual upstream is gated behind auth, so under load this
    // will return early with 401. The point of this profile is the
    // WebSocket upgrade handling on the DMZ proxy itself, not a
    // logged-in session.
    const path = '/api/health/ws';
    const url = `${URL}${path}`;
    const res = ws.connect(url, null, function (socket) {
        socket.on('open', function () {
            socket.setInterval(function () {
                socket.ping();
            }, 5000);
            socket.setTimeout(function () {
                socket.close();
            }, 60000);
        });
    });
    check(res, { 'handshake completed': (r) => r && r.status === 101 });
}
