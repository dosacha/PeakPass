import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const reservationLatency = new Trend('flash_sale_reservation_latency_ms');
const reservationErrors = new Rate('flash_sale_reservation_errors');
const reservationCreated = new Counter('flash_sale_reservations_created');
const rateLimitedResponses = new Counter('flash_sale_rate_limited');

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

export const options = {
  stages: [
    { duration: '30s', target: 20, name: '준비' },
    { duration: '30s', target: 150, name: '상승' },
    { duration: '2m', target: 150, name: '플래시세일 유지' },
    { duration: '20s', target: 0, name: '종료' },
  ],
  thresholds: {
    flash_sale_reservation_latency_ms: ['p(95)<1000', 'p(99)<2000'],
    flash_sale_reservation_errors: ['rate<0.1'],
  },
};

export function setup() {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
  const userId = __ENV.LOAD_TEST_USER_ID;

  if (!userId) {
    throw new Error('LOAD_TEST_USER_ID 환경 변수가 필요함');
  }

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
  const firstTier = firstEvent?.pricing?.[0] || null;

  if (!firstEvent?.id || !firstTier?.id) {
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
  const requestBody = {
    eventId: data.eventId,
    userId: data.userId,
    quantity: 1,
    tierId: data.tierId,
  };

  const response = http.post(
    `${data.baseUrl}/reservations`,
    JSON.stringify(requestBody),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': createUuid(),
      },
    },
  );

  reservationLatency.add(response.timings.duration);

  if (response.status === 429) {
    rateLimitedResponses.add(1);
  }

  const json = parseJson(response);
  const isAcceptedStatus = response.status === 201 || response.status === 429 || response.status === 409;

  check(response, {
    'reservation expected status': () => isAcceptedStatus,
    'reservation created or rate limited': () =>
      response.status === 201 ? Boolean(json?.id) : true,
  }) || reservationErrors.add(1);

  if (response.status === 201) {
    reservationCreated.add(1);
  }

  sleep(Math.random() * 0.2);
}
