import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const graphqlLatency = new Trend('graphql_rate_limit_latency_ms');
const graphqlRateLimited = new Rate('graphql_rate_limited');
const graphqlUnexpectedErrors = new Rate('graphql_unexpected_errors');
const graphqlRequests = new Counter('graphql_rate_limit_requests');

const eventsQuery = `
  query BrowseEvents($limit: Int!, $offset: Int!) {
    events(limit: $limit, offset: $offset) {
      id
      name
      availableSeats
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
    { duration: '10s', target: 5, name: 'warmup' },
    { duration: '50s', target: 20, name: 'exceed graphql limit' },
    { duration: '10s', target: 0, name: 'cooldown' },
  ],
  thresholds: {
    graphql_rate_limited: ['rate>0.1'],
    graphql_unexpected_errors: ['rate<0.01'],
    graphql_rate_limit_latency_ms: ['p(95)<1000'],
  },
};

export function setup() {
  return {
    baseUrl: __ENV.BASE_URL || 'http://localhost:3000',
  };
}

export default function (data) {
  const response = http.post(
    `${data.baseUrl}/graphql`,
    JSON.stringify({
      query: eventsQuery,
      variables: {
        limit: 10,
        offset: (__ITER * 10) % 20,
      },
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );

  graphqlRequests.add(1);
  graphqlLatency.add(response.timings.duration);
  graphqlRateLimited.add(response.status === 429);

  const json = parseJson(response);
  const accepted = response.status === 200 || response.status === 429;
  const expectedBody =
    response.status === 429 ||
    Boolean(json && json.data && json.data.events);

  const ok = check(response, {
    'graphql status is allowed or rate limited': () => accepted,
    'graphql body matches status': () => expectedBody,
  });
  graphqlUnexpectedErrors.add(!ok);

  sleep(Math.random() * 0.1);
}
