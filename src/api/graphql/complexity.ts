import { FieldNode, GraphQLError, GraphQLSchema, getNamedType, isCompositeType } from 'graphql';

type ComplexityRule = {
  complexity: number | ((input: { args: Record<string, unknown> }) => number);
};

type ComplexityRulesMap = Record<string, Record<string, ComplexityRule>>;

export const complexityRulesMap: ComplexityRulesMap = {
  Query: {
    events: {
      complexity: ({ args }) => Number(args.limit ?? 10),
    },
    event: {
      complexity: 1,
    },
    myOrders: {
      complexity: ({ args }) => Number(args.limit ?? 10),
    },
    myTickets: {
      complexity: ({ args }) => Number(args.limit ?? 20),
    },
    ticketByCode: {
      complexity: 1,
    },
  },
};

export function calculateFieldComplexity(
  node: FieldNode,
  schema: GraphQLSchema,
  type: { name?: string; getFields?: () => Record<string, { type: unknown }> },
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
        depth + 1,
        maxDepth,
      );
    }
  }

  return complexity + nestedComplexity;
}

export function validateQueryComplexity(
  documentAst: { definitions: Array<{ kind: string; selectionSet?: { selections: unknown[] } }> },
  schema: GraphQLSchema,
  maxComplexity = 5000,
): void {
  let totalComplexity = 0;

  for (const definition of documentAst.definitions) {
    if (definition.kind !== 'OperationDefinition') {
      continue;
    }

    const queryType = schema.getQueryType();
    if (!queryType || !definition.selectionSet) {
      continue;
    }

    for (const selection of definition.selectionSet.selections) {
      if ((selection as { kind?: string }).kind !== 'Field') {
        continue;
      }

      totalComplexity += calculateFieldComplexity(selection as FieldNode, schema, queryType, 0);
    }
  }

  if (totalComplexity > maxComplexity) {
    throw new GraphQLError(
      `Query too complex: complexity ${totalComplexity} exceeds limit of ${maxComplexity}`,
      { extensions: { code: 'QUERY_TOO_COMPLEX' } },
    );
  }
}

export function createComplexityPlugin(options: { max?: number } = {}) {
  const maxComplexity = options.max || 5000;

  return {
    async didResolveOperation({
      document,
      schema,
    }: {
      document: { definitions: Array<{ kind: string; selectionSet?: { selections: unknown[] } }> };
      schema: GraphQLSchema;
    }) {
      try {
        validateQueryComplexity(document, schema, maxComplexity);
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
}
