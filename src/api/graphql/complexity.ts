import {
  DocumentNode,
  FieldNode,
  GraphQLError,
  GraphQLSchema,
  getNamedType,
  isCompositeType,
} from 'graphql';
import type { ApolloServerPlugin, BaseContext } from '@apollo/server';

type ComplexityRule = {
  complexity: number | ((input: { args: Record<string, unknown> }) => number);
};

type ComplexityRulesMap = Record<string, Record<string, ComplexityRule>>;

function numericLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.floor(parsed));
}

export const complexityRulesMap: ComplexityRulesMap = {
  Query: {
    events: {
      complexity: ({ args }) => numericLimit(args.limit, 10),
    },
    event: {
      complexity: 1,
    },
    myOrders: {
      complexity: ({ args }) => numericLimit(args.limit, 10),
    },
    myTickets: {
      complexity: ({ args }) => numericLimit(args.limit, 20),
    },
    ticketByCode: {
      complexity: 1,
    },
  },
};

/**
 * 단일 field의 복잡도를 재귀적으로 계산한다.
 *
 * - complexityRulesMap에 정의된 rule이 있으면 그 값/함수를 사용
 * - 없으면 default 1
 * - nested selectionSet은 재귀로 합산
 * - depth가 maxDepth를 넘으면 큰 페널티(1000)를 반환해 deep-nested DoS를 차단
 */
export function calculateFieldComplexity(
  node: FieldNode,
  schema: GraphQLSchema,
  type: { name?: string; getFields?: () => Record<string, { type: unknown }> },
  variables: Record<string, unknown> = {},
  depth = 0,
  maxDepth = 10,
): number {
  void schema;

  if (depth > maxDepth) {
    return 1000;
  }

  const typeName = type.name ?? 'Unknown';
  const fieldName = node.name.value;
  const fieldRule = complexityRulesMap[typeName]?.[fieldName];

  let complexity = fieldRule?.complexity ?? 1;
  if (typeof complexity === 'function') {
    const args =
      node.arguments?.reduce<Record<string, unknown>>((acc, arg) => {
        if (arg.value.kind === 'IntValue') {
          acc[arg.name.value] = parseInt(arg.value.value, 10);
        } else if (arg.value.kind === 'StringValue') {
          acc[arg.name.value] = arg.value.value;
        } else if (arg.value.kind === 'Variable') {
          const varName = arg.value.name.value;
          if (variables[varName] !== undefined) {
            acc[arg.name.value] = variables[varName];
          }
        }
        return acc;
      }, {}) ?? {};

    complexity = complexity({ args });
  }

  let nestedComplexity = 0;
  if (node.selectionSet && isCompositeType(type as never)) {
    for (const selection of node.selectionSet.selections) {
      if (selection.kind !== 'Field') {
        continue;
      }

      const fieldType = type.getFields?.()[selection.name.value];
      if (!fieldType) {
        continue;
      }

      const namedType = getNamedType(fieldType.type as never);
      nestedComplexity += calculateFieldComplexity(
        selection,
        schema,
        namedType as never,
        variables,
        depth + 1,
        maxDepth,
      );
    }
  }

  return complexity + nestedComplexity;
}

/**
 * Query 전체의 누적 복잡도가 maxComplexity를 초과하면 GraphQLError를 던진다.
 * Apollo plugin의 didResolveOperation 단계에서 호출되어, resolver 진입 전에
 * 폭주성 query를 거부한다.
 */
export function validateQueryComplexity(
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown> = {},
  maxComplexity = 5000,
): void {
  let totalComplexity = 0;

  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition') {
      continue;
    }

    const queryType = schema.getQueryType();
    if (!queryType || !definition.selectionSet) {
      continue;
    }

    for (const selection of definition.selectionSet.selections) {
      if (selection.kind !== 'Field') {
        continue;
      }

      totalComplexity += calculateFieldComplexity(selection, schema, queryType, variables, 0);
    }
  }

  if (totalComplexity > maxComplexity) {
    throw new GraphQLError(
      `Query too complex: complexity ${totalComplexity} exceeds limit of ${maxComplexity}`,
      { extensions: { code: 'QUERY_TOO_COMPLEX' } },
    );
  }
}

/**
 * Apollo Server plugin factory.
 *
 * 정확한 hook 위치는 requestDidStart -> didResolveOperation.
 * didResolveOperation은 schema validation은 끝나고 resolver는 아직 실행되기 전에 호출된다.
 * 즉 query 구조는 검증된 상태에서, DB 접근 없이 복잡도만 빠르게 계산해 거부할 수 있다.
 */
export function createComplexityPlugin<TContext extends BaseContext = BaseContext>(
  options: { max?: number } = {},
): ApolloServerPlugin<TContext> {
  const maxComplexity = options.max ?? 5000;

  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ document, schema, request }) {
          try {
            const variables = (request.variables ?? {}) as Record<string, unknown>;
            validateQueryComplexity(document, schema, variables, maxComplexity);
          } catch (err) {
            if (err instanceof GraphQLError) {
              throw err;
            }

            throw new GraphQLError(
              `Query validation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      };
    },
  };
}
