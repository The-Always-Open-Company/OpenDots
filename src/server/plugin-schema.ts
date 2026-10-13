import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

type JsonSchema = Record<string, unknown>;

interface Issue {
  message: string;
  path?: string[];
}

/**
 * A plugin tool's parameters as the server declared them: the model sees the
 * server's JSON Schema unchanged, and calls are checked against it before they
 * run or reach the owner for approval.
 */
export interface PluginParameters {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'opendots';
    readonly validate: (
      value: unknown,
    ) => { value: Record<string, unknown> } | { issues: Issue[] };
    readonly jsonSchema: {
      readonly input: () => JsonSchema;
      readonly output: () => JsonSchema;
    };
  };
}

const operationId = {
  type: 'string',
  minLength: 1,
  maxLength: 80,
  description: 'Pass this only when retrying the same plugin call.',
};

// Lenient on purpose: an unfamiliar keyword or format must not reject a call
// the server itself would accept.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const compiled = new Map<string, ValidateFunction | null>();
const MAX_ISSUES = 6;

function modelSchema(schema: unknown): JsonSchema {
  const base: JsonSchema =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? { ...(schema as JsonSchema) }
      : {};
  delete base.$schema;
  delete base.$id;
  const props =
    base.properties && typeof base.properties === 'object'
      ? (base.properties as JsonSchema)
      : {};
  return {
    ...base,
    type: 'object',
    properties: { ...props, operationId },
  };
}

function validator(key: string, schema: JsonSchema) {
  if (!compiled.has(key)) {
    let check: ValidateFunction | null = null;
    try {
      check = ajv.compile(schema);
    } catch {
      // A schema Ajv cannot compile is still offered; the server validates it.
    }
    compiled.set(key, check);
  }
  return compiled.get(key) ?? null;
}

function issue(error: ErrorObject): Issue {
  const path = error.instancePath.split('/').filter(Boolean);
  const where = path.length ? path.join('.') : 'input';
  return { message: `${where} ${error.message ?? 'is invalid'}`, path };
}

/** `cacheKey` identifies the schema, such as its hash, so each compiles once. */
export function pluginParameters(
  schema: unknown,
  cacheKey: string,
): PluginParameters {
  const jsonSchema = modelSchema(schema);
  return {
    '~standard': {
      version: 1,
      vendor: 'opendots',
      validate: (value) => {
        const input = (
          value && typeof value === 'object' ? value : {}
        ) as Record<string, unknown>;
        const check = validator(cacheKey, jsonSchema);
        if (!check || check(input)) return { value: input };
        const seen = new Set<string>();
        const issues = (check.errors ?? [])
          .map(issue)
          .filter(
            (entry) => !seen.has(entry.message) && seen.add(entry.message),
          )
          .slice(0, MAX_ISSUES);
        return { issues };
      },
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  };
}

/** The server answered, and said the call failed; nothing is uncertain about it. */
export class PluginToolError extends Error {
  override name = 'PluginToolError';
}

const MAX_ERROR = 1000;

/** The error text of an MCP result marked `isError`, or null for a success. */
export function toolErrorOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as { isError?: unknown; content?: unknown };
  if (record.isError !== true) return null;
  const text = (Array.isArray(record.content) ? record.content : [])
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
  const message = text || 'The plugin reported an error.';
  return message.length > MAX_ERROR
    ? `${message.slice(0, MAX_ERROR)}…`
    : message;
}
