import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const callbackLatency = new Trend('payment_callback_latency_ms');
const callbackErrors = new Rate('payment_callback_errors');
const callbackDuplicates = new Counter('payment_callback_duplicates');

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

function createPendingOrder(baseUrl, eventId, tierId, userId) {
  const reservationResponse = http.post(
    `${baseUrl}/reservations`,
    JSON.stringify({
      eventId,
      userId,
      quantity: 1,
      tierId,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );

  const reservationJson = parseJson(reservationResponse);
  if (reservationResponse.status !== 201 || !reservationJson?.id) {
    throw new Error('payment callback setup 중 reservation 생성 실패');
  }

  const checkoutResponse = http.post(
    `${baseUrl}/checkouts`,
    JSON.stringify({
      eventId,
      userId,
      quantity: 1,
      tierId,
      reservationId: reservationJson.id,
      idempotencyKey: createUuid(),
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': createUuid(),
      },
    },
  );

  const checkoutJson = parseJson(checkoutResponse);
  if (checkoutResponse.status !== 201 || !checkoutJson?.order?.id) {
    throw new Error('payment callback setup 중 checkout 생성 실패');
  }

  return checkoutJson.order.id;
}

export const options = {
  stages: [
    { duration: '15s', target: 10, name: '준비' },
    { duration: '30s', target: 50, name: '중복 webhook 집중' },
    { duration: '15s', target: 50, name: '재시도 유지' },
    { duration: '10s', target: 0, name: '종료' },
  ],
  thresholds: {
    payment_callback_latency_ms: ['p(95)<1000', 'p(99)<1800'],
    payment_callback_errors: ['rate<0.05'],
  },
};

export function setup() {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
  const userId = requireValue('LOAD_TEST_USER_ID');
  const eventId = requireValue('LOAD_TEST_EVENT_ID');
  const tierId = requireValue('LOAD_TEST_TIER_ID');

  const orderId = createPendingOrder(baseUrl, eventId, tierId, userId);

  return {
    baseUrl,
    orderId,
    providerTransactionId: __ENV.LOAD_TEST_PROVIDER_TXN_ID || `txn-load-${Date.now()}`,
  };
}

export default function (data) {
  const useRepeatedIdempotencyKey = __ITER % 2 === 0;
  const idempotencyKey = useRepeatedIdempotencyKey
    ? '00000000-0000-4000-8000-000000000001'
    : createUuid();

  const response = http.post(
    `${data.baseUrl}/webhooks/payments/settlement`,
    JSON.stringify({
      orderId: data.orderId,
      providerTransactionId: data.providerTransactionId,
      status: 'settled',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
    },
  );

  callbackLatency.add(response.timings.duration);

  const json = parseJson(response);
  const accepted = response.status === 200 && json?.order?.id === data.orderId;
  const duplicate = Boolean(json?.duplicate);

  if (duplicate) {
    callbackDuplicates.add(1);
  }

  check(response, {
    'callback status 200': () => response.status === 200,
    'callback order returned': () => accepted,
    'callback payment status settled': () => json?.paymentStatus === 'settled',
  }) || callbackErrors.add(1);

  sleep(Math.random() * 0.2);
}
