import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const reservationLatency = new Trend('reservation_rate_limit_latency_ms');
const reservationRateLimited = new Rate('reservation_rate_limited');
const reservationUnexpectedErrors = new Rate('reservation_unexpected_errors');
const reservationRequests = new Counter('reservation_rate_limit_requests');

function createUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const randomValue = Math.random() * 16 | 0;
    const value = character === 'x' ? randomValue : (randomValue & 0x3) | 0x8;
    return value.toString(16);
  });
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_err) {
    return null;
  }
}

function requireValue(name) {
  const value = __ENV[name];
  if (!value) {
    throw new Error(`${name} 환경 변수가 필요함`);
  }

  return value;
}

export const options = {
  stages: [
    { duration: '10s', target: 5, name: 'warmup' },
    { duration: '50s', target: 25, name: 'exceed reservation limit' },
    { duration: '10s', target: 0, name: 'cooldown' },
  ],
  thresholds: {
    reservation_rate_limited: ['rate>0.1'],
    reservation_unexpected_errors: ['rate<0.01'],
    reservation_rate_limit_latency_ms: ['p(95)<1000'],
  },
};

export function setup() {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
  const userId = requireValue('LOAD_TEST_USER_ID');

  if (__ENV.LOAD_TEST_EVENT_ID && __ENV.LOAD_TEST_TIER_ID) {
    return {
      baseUrl,
      userId,
      eventId: __ENV.LOAD_TEST_EVENT_ID,
      tierId: __ENV.LOAD_TEST_TIER_ID,
    };
  }

  const response = http.get(`${baseUrl}/events?limit=1&offset=0`);
  const events = parseJson(response);
  const firstEvent = Array.isArray(events) && events.length > 0 ? events[0] : null;
  const firstTier = firstEvent && firstEvent.pricing && firstEvent.pricing[0] ? firstEvent.pricing[0] : null;

  if (!firstEvent || !firstEvent.id || !firstTier || !firstTier.id) {
    throw new Error('이벤트 또는 tierId를 찾지 못함');
  }

  return {
    baseUrl,
    userId,
    eventId: firstEvent.id,
    tierId: firstTier.id,
  };
}

export default function (data) {
  const response = http.post(
    `${data.baseUrl}/reservations`,
    JSON.stringify({
      eventId: data.eventId,
      userId: data.userId,
      quantity: 1,
      tierId: data.tierId,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': createUuid(),
      },
    },
  );

  reservationRequests.add(1);
  reservationLatency.add(response.timings.duration);
  reservationRateLimited.add(response.status === 429);

  const json = parseJson(response);
  const accepted = response.status === 201 || response.status === 409 || response.status === 429;
  const expectedBody =
    response.status === 429 ||
    response.status === 409 ||
    Boolean(json && json.id);

  const ok = check(response, {
    'reservation status is accepted, conflicted, or rate limited': () => accepted,
    'reservation body matches status': () => expectedBody,
  });
  reservationUnexpectedErrors.add(!ok);

  sleep(Math.random() * 0.1);
}
