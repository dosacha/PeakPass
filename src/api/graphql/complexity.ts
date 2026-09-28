import {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLError,
  GraphQLSchema,
  Kind,
  SelectionSetNode,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
  getArgumentValues,
  getNamedType,
  getOperationAST,
  getVariableValues,
  isCompositeType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
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

type ComplexityContext = {
  schema: GraphQLSchema;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
  maxComplexity: number;
  maxDepth: number;
};

function rejectComplexity(message: string): never {
  throw new GraphQLError(`Query too complex: ${message}`, {
    extensions: { code: 'QUERY_TOO_COMPLEX', http: { status: 400 } },
  });
}

function selectionComplexity(
  selectionSet: SelectionSetNode,
  type: GraphQLCompositeType,
  context: ComplexityContext,
  depth = 0,
  fragmentPath = new Set<string>(),
  fragmentDepth = 0,
): number {
  if (depth > context.maxDepth || fragmentDepth > context.maxDepth) {
    rejectComplexity(`maximum depth ${context.maxDepth} exceeded`);
  }

  let total = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldName = selection.name.value;
      const field = fieldName === '__typename' ? TypeNameMetaFieldDef
        : fieldName === '__schema' && type === context.schema.getQueryType() ? SchemaMetaFieldDef
          : fieldName === '__type' && type === context.schema.getQueryType() ? TypeMetaFieldDef
            : isObjectType(type) || isInterfaceType(type) ? type.getFields()[fieldName] : undefined;
      const args = field ? getArgumentValues(field, selection, context.variables) : {};
      const rule = complexityRulesMap[type.name]?.[fieldName]?.complexity ?? 1;
      const baseCost = typeof rule === 'function' ? rule({ args }) : rule;
      const returnType = field ? getNamedType(field.type) : undefined;
      let nestedCost = 0;
      if (selection.selectionSet && returnType && isCompositeType(returnType)) {
        nestedCost = selectionComplexity(selection.selectionSet, returnType, context, depth + 1, fragmentPath);
      }
      const outputType = field && isNonNullType(field.type) ? field.type.ofType : field?.type;
      // ponytail: unpaginated lists estimate 10 items; a tier-count bound or measurement must replace this if needed.
      const cardinality = outputType && isListType(outputType)
        ? numericLimit(args.limit, typeof rule === 'function' ? baseCost : 10) : 1;
      total += baseCost + cardinality * nestedCost;
    } else {
      const name = selection.kind === Kind.FRAGMENT_SPREAD ? selection.name.value : undefined;
      if (name && fragmentPath.has(name)) rejectComplexity(`fragment cycle at ${name}`);
      const fragment = name ? context.fragments.get(name) : selection;
      if (!fragment || !('selectionSet' in fragment)) continue;
      const condition = fragment.typeCondition;
      const fragmentType = condition ? context.schema.getType(condition.name.value) : type;
      if (fragmentType && isCompositeType(fragmentType)) {
        total += selectionComplexity(fragment.selectionSet, fragmentType, context, depth,
          name ? new Set([...fragmentPath, name]) : fragmentPath, fragmentDepth + 1);
      }
    }
    if (total > context.maxComplexity) {
      rejectComplexity(`complexity ${total} exceeds limit of ${context.maxComplexity}`);
    }
  }
  return total;
}

export function calculateFieldComplexity(
  node: FieldNode,
  schema: GraphQLSchema,
  type: GraphQLCompositeType,
  variables: Record<string, unknown> = {},
  depth = 0,
  maxDepth = 10,
): number {
  return selectionComplexity({ kind: Kind.SELECTION_SET, selections: [node] }, type,
    { schema, variables, fragments: new Map(), maxComplexity: Infinity, maxDepth }, depth);
}

// Validate only the selected operation, using the same variable/argument defaults as execution.
export function validateQueryComplexity(
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown> = {},
  maxComplexity = 5000,
  operationName?: string,
): void {
  const operation = getOperationAST(document, operationName);
  if (!operation) {
    throw new GraphQLError('Unable to select operation', {
      extensions: { code: 'OPERATION_RESOLUTION_FAILURE', http: { status: 400 } },
    });
  }
  const effectiveVariables = getVariableValues(schema, operation.variableDefinitions ?? [], variables);
  if (effectiveVariables.errors) {
    throw new GraphQLError(effectiveVariables.errors[0].message, {
      extensions: { code: 'BAD_USER_INPUT', http: { status: 400 } },
    });
  }
  const rootType = operation.operation === 'query' ? schema.getQueryType()
    : operation.operation === 'mutation' ? schema.getMutationType() : schema.getSubscriptionType();
  if (!rootType) return;
  const fragments = new Map(document.definitions
    .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
    .map((definition) => [definition.name.value, definition]));
  selectionComplexity(operation.selectionSet, rootType, {
    schema, variables: effectiveVariables.coerced, fragments, maxComplexity, maxDepth: 10,
  });
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
            validateQueryComplexity(document, schema, variables, maxComplexity, request.operationName ?? undefined);
          } catch (err) {
            if (err instanceof GraphQLError) {
              throw err;
            }

            throw new GraphQLError(
              `Query validation failed: ${err instanceof Error ? err.message : String(err)}`,
              { extensions: { code: 'BAD_USER_INPUT', http: { status: 400 } } },
            );
          }
        },
      };
    },
  };
}
