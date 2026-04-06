import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const spikeLatency = new Trend('event_detail_spike_latency_ms');
const spikeErrors = new Rate('event_detail_spike_errors');
const spikeRequests = new Counter('event_detail_spike_requests');

const eventDetailQuery = `
  query EventDetail($id: ID!) {
    event(id: $id) {
      id
      title
      date
      availableSeats
      pricing {
        tier
        price
        seats
        available
      }
    }
  }
`;

function parseJson(response) {
  try {
    return response.json();
  } catch (_err) {
    return null;
  }
}

export const options = {
  stages: [
    { duration: '30s', target: 10, name: '준비' },
    { duration: '5s', target: 200, name: '스파이크' },
    { duration: '30s', target: 200, name: '유지' },
    { duration: '10s', target: 0, name: '복구' },
  ],
  thresholds: {
    event_detail_spike_latency_ms: ['p(95)<1200', 'p(99)<2000'],
    event_detail_spike_errors: ['rate<0.05'],
  },
};

export function setup() {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
  const eventId = __ENV.LOAD_TEST_EVENT_ID;

  if (eventId) {
    return { baseUrl, eventId };
  }

  const response = http.get(`${baseUrl}/events?limit=1&offset=0`);
  const events = parseJson(response);
  const firstEvent = Array.isArray(events) && events.length > 0 ? events[0] : null;

  if (!firstEvent?.id) {
    throw new Error('LOAD_TEST_EVENT_ID가 없고 /events에서도 eventId를 찾지 못함');
  }

  return { baseUrl, eventId: firstEvent.id };
}

export default function (data) {
  const response = http.post(
    `${data.baseUrl}/graphql`,
    JSON.stringify({
      query: eventDetailQuery,
      variables: { id: data.eventId },
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );

  spikeRequests.add(1);
  spikeLatency.add(response.timings.duration);

  const json = parseJson(response);
  check(response, {
    'detail status 200': (current) => current.status === 200,
    'detail graphql data': () => Boolean(json?.data?.event),
    'detail latency < 1000ms': (current) => current.timings.duration < 1000,
  }) || spikeErrors.add(1);

  sleep(Math.random() * 0.3);
}
