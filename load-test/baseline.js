import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const browseLatency = new Trend('browse_latency_ms');
const browseErrors = new Rate('browse_errors');
const graphqlBrowseRequests = new Counter('graphql_browse_requests');

const eventsQuery = `
  query BrowseEvents($limit: Int!, $offset: Int!) {
    events(limit: $limit, offset: $offset) {
      id
      title
      date
      capacity
      availableSeats
    }
  }
`;

const eventDetailQuery = `
  query EventDetail($id: ID!) {
    event(id: $id) {
      id
      title
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
    { duration: '1m', target: 10, name: '워밍업' },
    { duration: '3m', target: 50, name: '상승' },
    { duration: '5m', target: 50, name: '안정' },
    { duration: '1m', target: 0, name: '종료' },
  ],
  thresholds: {
    browse_latency_ms: ['p(95)<800', 'p(99)<1500'],
    browse_errors: ['rate<0.03'],
  },
};

export function setup() {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
  const response = http.get(`${baseUrl}/events?limit=5&offset=0`);
  const events = parseJson(response);
  const firstEvent = Array.isArray(events) && events.length > 0 ? events[0] : null;

  return {
    baseUrl,
    eventId: __ENV.LOAD_TEST_EVENT_ID || firstEvent?.id || null,
  };
}

export default function (data) {
  const headers = { 'Content-Type': 'application/json' };

  const healthResponse = http.get(`${data.baseUrl}/health`, { headers });
  check(healthResponse, {
    'health 200': (response) => response.status === 200,
  }) || browseErrors.add(1);

  const browseResponse = http.post(
    `${data.baseUrl}/graphql`,
    JSON.stringify({
      query: eventsQuery,
      variables: {
        limit: 10,
        offset: (__ITER * 10) % 20,
      },
    }),
    { headers },
  );

  graphqlBrowseRequests.add(1);
  browseLatency.add(browseResponse.timings.duration);

  const browseJson = parseJson(browseResponse);
  check(browseResponse, {
    'browse status 200': (response) => response.status === 200,
    'browse graphql data': () => Boolean(browseJson?.data?.events),
    'browse latency < 500ms': (response) => response.timings.duration < 500,
  }) || browseErrors.add(1);

  sleep(0.3);

  if (data.eventId) {
    const detailResponse = http.post(
      `${data.baseUrl}/graphql`,
      JSON.stringify({
        query: eventDetailQuery,
        variables: { id: data.eventId },
      }),
      { headers },
    );

    browseLatency.add(detailResponse.timings.duration);
    const detailJson = parseJson(detailResponse);
    check(detailResponse, {
      'detail status 200': (response) => response.status === 200,
      'detail graphql data': () => Boolean(detailJson?.data?.event),
      'detail latency < 600ms': (response) => response.timings.duration < 600,
    }) || browseErrors.add(1);
  }

  sleep(0.7);
}
