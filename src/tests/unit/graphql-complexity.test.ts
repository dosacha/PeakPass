import { parse, buildSchema } from 'graphql';
import type { FieldNode } from 'graphql';
import {
  validateQueryComplexity,
  calculateFieldComplexity,
  createComplexityPlugin,
  complexityRulesMap,
} from '@/api/graphql/complexity';
import { graphqlTypeDefs } from '@/api/graphql/types';

describe('GraphQL query complexity', () => {
  const schema = buildSchema(graphqlTypeDefs);

  describe('complexityRulesMap', () => {
    it('uses limit argument for events query complexity', () => {
      const rule = complexityRulesMap.Query.events;
      if (typeof rule.complexity !== 'function') {
        throw new Error('events complexity should be a function');
      }
      expect(rule.complexity({ args: { limit: 10 } })).toBe(10);
      expect(rule.complexity({ args: { limit: 100 } })).toBe(100);
      // limit 미지정 시 default 10 적용
      expect(rule.complexity({ args: {} })).toBe(10);
    });

    it('treats event lookup as constant cost', () => {
      const rule = complexityRulesMap.Query.event;
      expect(rule.complexity).toBe(1);
    });
  });

  describe('validateQueryComplexity', () => {
    it.each([
      '{ events(limit: 2) { id } }',
      'fragment Root on Query { events(limit: 2) { ...Item } } fragment Item on Event { id } query { ...Root }',
      '{ ... on Query { events(limit: 2) { ... on Event { id } } } }',
    ])('charges equivalent direct/named/inline selections the same: %s', (query) => {
      const document = parse(query);
      expect(() => validateQueryComplexity(document, schema, {}, 4)).not.toThrow();
      expect(() => validateQueryComplexity(document, schema, {}, 3)).toThrow(/Query too complex/);
    });

    it('charges a reused fragment for every aliased execution', () => {
      const document = parse('fragment Item on Event { id } query { a: event(id: "a") { ...Item } b: event(id: "b") { ...Item } }');
      expect(() => validateQueryComplexity(document, schema, {}, 4)).not.toThrow();
      expect(() => validateQueryComplexity(document, schema, {}, 3)).toThrow(/Query too complex/);
    });

    it('multiplies nested list costs using actual return types and argument defaults', () => {
      const nestedSchema = buildSchema('type Query { events(limit: Int = 3): [Event!]! } type Event { id: ID! related(limit: Int = 2): [Event!]! }');
      const document = parse('{ events { related { id } } }');
      // events 3 + 3 * (related 1 + 2 * id 1) = 12.
      expect(() => validateQueryComplexity(document, nestedSchema, {}, 12)).not.toThrow();
      expect(() => validateQueryComplexity(document, nestedSchema, {}, 11)).toThrow(/Query too complex/);
    });

    it('coerces operation variable defaults and respects provided overrides', () => {
      const document = parse('query Q($limit: Int = 10000) { events(limit: $limit) { id } }');
      expect(() => validateQueryComplexity(document, schema)).toThrow(/Query too complex/);
      expect(() => validateQueryComplexity(document, schema, { limit: 2 }, 4)).not.toThrow();
      expect(() => validateQueryComplexity(document, schema, { limit: 2 }, 3)).toThrow(/Query too complex/);
    });

    it('charges root defaults and accepts the exact 5000 budget boundary', () => {
      expect(() => validateQueryComplexity(parse('{ events { id } }'), schema, {}, 20)).not.toThrow();
      expect(() => validateQueryComplexity(parse('{ events { id } }'), schema, {}, 19)).toThrow(/Query too complex/);
      expect(() => validateQueryComplexity(parse('{ events(limit: 2500) { id } }'), schema)).not.toThrow();
      expect(() => validateQueryComplexity(parse('{ events(limit: 2501) { id } }'), schema)).toThrow(/Query too complex/);
    });

    it('rejects fragment cycles without recursion or a cheap fallback', () => {
      const document = parse('fragment Loop on Event { id ...Loop } query { event(id: "a") { ...Loop } }');
      expect(() => validateQueryComplexity(document, schema)).toThrow(/cycle|complex|depth/i);
    });

    it('enforces the depth boundary even when the default cost budget is larger', () => {
      const nestedSchema = buildSchema('type Query { event: Event } type Event { id: ID next: Event }');
      const within = parse(`{ event { ${'next { '.repeat(9)} id ${'} '.repeat(9)} } }`);
      const beyond = parse(`{ event { ${'next { '.repeat(10)} id ${'} '.repeat(10)} } }`);
      expect(() => validateQueryComplexity(within, nestedSchema)).not.toThrow();
      expect(() => validateQueryComplexity(beyond, nestedSchema)).toThrow(/depth|complex/i);
    });

    it('passes queries within the limit', () => {
      const document = parse(`
        query {
          events(limit: 10) {
            id
            name
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, {}, 100)).not.toThrow();
    });

    it('rejects queries that exceed the limit via large limit args', () => {
      // 1000 events + 1000 * two scalar fields = 3000; max 100 rejects.
      const document = parse(`
        query {
          events(limit: 1000) {
            id
            name
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, {}, 100)).toThrow(
        /Query too complex/,
      );
    });

    it('rejects queries that exceed the limit via variable args', () => {
      const document = parse(`
        query Q($l: Int!) {
          events(limit: $l) {
            id
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, { l: 1000 }, 100)).toThrow(
        /Query too complex/,
      );
    });

    it('charges the default unpaginated list estimate across parent items', () => {
      const document = parse(`
        query {
          events(limit: 5) {
            pricing {
              tierId
              name
              price
            }
          }
        }
      `);

      // events 5 + 5 * (pricing 1 + 10 estimated tiers * 3 fields) = 160.
      expect(() => validateQueryComplexity(document, schema, {}, 160)).not.toThrow();
      expect(() => validateQueryComplexity(document, schema, {}, 159)).toThrow(/Query too complex/);
    });

    it('allows detail pages to compose event data with user context fields', () => {
      const document = parse(`
        query EventDetailPage($eventId: ID!) {
          event(id: $eventId) {
            id
            name
            description
            startsAt
            availableSeats
            pricing {
              tierId
              name
              price
              seats
            }
            myActiveReservation {
              id
              tierId
              quantity
              expiresAt
              status
            }
            myTicketCount
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, { eventId: 'event-1' }, 100)).not.toThrow();
    });

    it('sums complexity across multiple top-level fields', () => {
      // Each list costs 50 items + 50 id fields; combined cost is 200.
      const document = parse(`
        query {
          events(limit: 50) {
            id
          }
          myOrders(limit: 50) {
            id
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, {}, 80)).toThrow(
        /Query too complex/,
      );
      expect(() => validateQueryComplexity(document, schema, {}, 200)).not.toThrow();
    });
  });

  describe('createComplexityPlugin', () => {
    /**
     * Apollo plugin은 requestDidStart()를 통해 listener 객체를 만들고,
     * 그 listener의 didResolveOperation이 실제 검증을 수행한다.
     * Apollo는 listener 호출 시 RequestContext 전체를 넘기지만, 본 plugin은
     * document, schema, variables, operationName을 사용한다.
     */
    async function callDidResolveOperation(
      plugin: ReturnType<typeof createComplexityPlugin>,
      query: string,
      variables: Record<string, unknown> = {},
    ): Promise<void> {
      const document = parse(query);
      const requestListener = await plugin.requestDidStart!({} as never);
      if (!requestListener || !requestListener.didResolveOperation) {
        throw new Error('plugin did not return a request listener');
      }
      await requestListener.didResolveOperation({ document, schema, request: { variables } } as never);
    }

    it('returns a plugin with requestDidStart hook', () => {
      const plugin = createComplexityPlugin({ max: 100 });
      expect(typeof plugin.requestDidStart).toBe('function');
    });

    it('throws GraphQLError when complexity exceeds max', async () => {
      const plugin = createComplexityPlugin({ max: 100 });
      await expect(
        callDidResolveOperation(plugin, `query { events(limit: 1000) { id } }`),
      ).rejects.toThrow(/Query too complex/);
    });

    it('throws GraphQLError when variable complexity exceeds max', async () => {
      const plugin = createComplexityPlugin({ max: 100 });
      await expect(
        callDidResolveOperation(
          plugin,
          `query Q($l: Int!) { events(limit: $l) { id } }`,
          { l: 1000 },
        ),
      ).rejects.toThrow(/Query too complex/);
    });

    it('does not throw when complexity is within limits', async () => {
      const plugin = createComplexityPlugin({ max: 100 });
      await expect(
        callDidResolveOperation(plugin, `query { event(id: "abc") { id name } }`),
      ).resolves.not.toThrow();
    });

    it('uses the exact default max of 5000 when not specified', async () => {
      const plugin = createComplexityPlugin();
      // 2500 root items + 2500 id fields = 5000.
      await expect(
        callDidResolveOperation(plugin, `query { events(limit: 2500) { id } }`),
      ).resolves.not.toThrow();
      await expect(
        callDidResolveOperation(plugin, `query { events(limit: 4000) { id } }`),
      ).rejects.toThrow(/Query too complex/);
    });

    it('rejects queries exceeding default max of 5000', async () => {
      const plugin = createComplexityPlugin();
      await expect(
        callDidResolveOperation(plugin, `query { events(limit: 6000) { id } }`),
      ).rejects.toThrow(/Query too complex/);
    });
  });

  describe('calculateFieldComplexity', () => {
    it('uses fallback complexity of 1 for unknown fields', () => {
      const document = parse(`{ event(id: "x") { id } }`);
      const operation = document.definitions[0];
      if (operation.kind !== 'OperationDefinition' || !operation.selectionSet) {
        throw new Error('expected operation with selection set');
      }

      const eventField = operation.selectionSet.selections[0] as FieldNode;
      const queryType = schema.getQueryType();
      if (!queryType) throw new Error('no query type');

      const result = calculateFieldComplexity(eventField, schema, queryType);
      // event(rule=1) + nested id(default 1) = 2
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThan(10);
    });
  });
});
