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
    it('passes queries within the limit', () => {
      const document = parse(`
        query {
          events(limit: 10) {
            id
            title
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, 100)).not.toThrow();
    });

    it('rejects queries that exceed the limit via large limit args', () => {
      // limit=1000 → events complexity가 1000으로 계산됨. max=100이면 거부.
      const document = parse(`
        query {
          events(limit: 1000) {
            id
            title
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, 100)).toThrow(
        /Query too complex/,
      );
    });

    it('passes nested queries within reasonable depth', () => {
      const document = parse(`
        query {
          events(limit: 5) {
            pricing {
              tier
              price
            }
          }
        }
      `);

      expect(() => validateQueryComplexity(document, schema, 100)).not.toThrow();
    });

    it('sums complexity across multiple top-level fields', () => {
      // events(limit:50) + myOrders(limit:50) = 100. max=80이면 거부.
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

      expect(() => validateQueryComplexity(document, schema, 80)).toThrow(
        /Query too complex/,
      );
      expect(() => validateQueryComplexity(document, schema, 200)).not.toThrow();
    });
  });

  describe('createComplexityPlugin', () => {
    /**
     * Apollo plugin은 requestDidStart()를 통해 listener 객체를 만들고,
     * 그 listener의 didResolveOperation이 실제 검증을 수행한다.
     * Apollo는 listener 호출 시 RequestContext 전체를 넘기지만, 본 plugin은
     * document와 schema만 사용한다.
     */
    async function callDidResolveOperation(
      plugin: ReturnType<typeof createComplexityPlugin>,
      query: string,
    ): Promise<void> {
      const document = parse(query);
      const requestListener = await plugin.requestDidStart!({} as never);
      if (!requestListener || !requestListener.didResolveOperation) {
        throw new Error('plugin did not return a request listener');
      }
      await requestListener.didResolveOperation({ document, schema } as never);
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

    it('does not throw when complexity is within limits', async () => {
      const plugin = createComplexityPlugin({ max: 100 });
      await expect(
        callDidResolveOperation(plugin, `query { event(id: "abc") { id title } }`),
      ).resolves.not.toThrow();
    });

    it('uses default max of 5000 when not specified', async () => {
      const plugin = createComplexityPlugin();
      // limit=4000은 default 5000 안에 들어가니 통과
      await expect(
        callDidResolveOperation(plugin, `query { events(limit: 4000) { id } }`),
      ).resolves.not.toThrow();
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