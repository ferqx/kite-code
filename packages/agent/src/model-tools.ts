import type { ModelRequest, ModelTool, ModelToolCall } from '@kite-ai/ai';
import Ajv from 'ajv';
import type { ToolDefinition } from './extensions';
import { AgentError, type Json, type JsonSchema, type ToolCall } from './storage/types';

type Rename = NonNullable<ToolCall['model']>['parameters'];
const object = (value: unknown): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const snake = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/** Rename only schema-declared properties. Schema keywords, defaults and user JSON are data. */
function schemaProjection(schema: JsonSchema, model: NonNullable<ToolDefinition['model']>) {
  const parameters: NonNullable<Rename> = [];
  if (
    !model.snakeCase &&
    !Object.keys(model.parameterNames ?? {}).length &&
    !model.omitParameters?.length &&
    !model.requiredParameters?.length
  )
    return { inputSchema: structuredClone(schema), parameters };
  const seen = new Map<string, string>();
  const publicName = (path: string[], key: string) =>
    model.parameterNames?.[[...path, key].join('.')] ?? (model.snakeCase ? snake(key) : key);
  // Compare declaration provenance without enumerating combinations of alternative branches.
  type Choices = ReadonlyMap<number, number>;
  const declarations = new Map<string, { key: string; choices: Choices }[]>();
  let branchGroup = 0;
  const choose = (choices: Choices, group: number, branch: number): Choices =>
    new Map([...choices, [group, branch]]);
  const compatible = (left: Choices, right: Choices) =>
    [...left].every(([group, branch]) => !right.has(group) || right.get(group) === branch);
  function visit(
    value: Json,
    path: string[],
    predicate = false,
    choices: Choices = new Map(),
  ): Json {
    if (!object(value)) return value;
    if (value.$ref !== undefined && (model.snakeCase || model.parameterNames))
      throw new AgentError('model_tool_schema_reference_unsupported');
    const result = structuredClone(value);
    if (object(value.properties)) {
      const properties: Record<string, Json> = Object.create(null);
      for (const [key, property] of Object.entries(value.properties)) {
        if (!path.length && model.omitParameters?.includes(key)) continue;
        const name = publicName(path, key);
        const location = JSON.stringify([...path, name]);
        const priorDeclarations = declarations.get(location) ?? [];
        if (
          !name ||
          priorDeclarations.some((prior) => prior.key !== key && compatible(prior.choices, choices))
        )
          throw new AgentError('model_tool_parameter_collision');
        priorDeclarations.push({ key, choices });
        declarations.set(location, priorDeclarations);
        if (name !== key) {
          if (predicate) throw new AgentError('model_tool_schema_predicate_unsupported');
          const location = [...path, key].join('.');
          const prior = seen.get(location);
          if (prior !== undefined && prior !== name)
            throw new AgentError('model_tool_parameter_collision');
          if (prior === undefined) parameters.push({ path: [...path, key], name });
          seen.set(location, name);
        }
        properties[name] = visit(property, [...path, key], predicate, choices);
      }
      result.properties = properties;
    }
    if (Array.isArray(value.required))
      result.required = value.required
        .filter((key) => path.length || !model.omitParameters?.includes(String(key)))
        .map((key) => (typeof key === 'string' ? publicName(path, key) : key));
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (!Array.isArray(value[key])) continue;
      const group = branchGroup++;
      result[key] = value[key].map((entry, index) =>
        visit(entry, path, predicate, key === 'allOf' ? choices : choose(choices, group, index)),
      );
    }
    const conditionalGroup = branchGroup++;
    for (const key of ['not', 'if', 'then', 'else'] as const)
      if (object(value[key]))
        result[key] = visit(
          value[key],
          path,
          predicate || key === 'not' || key === 'if',
          key === 'then' || key === 'else'
            ? choose(choices, conditionalGroup, key === 'then' ? 0 : 1)
            : choices,
        );
    if (object(value.items)) result.items = visit(value.items, [...path, '*'], predicate, choices);
    if (Array.isArray(value.prefixItems))
      result.prefixItems = value.prefixItems.map((entry, index) =>
        visit(entry, [...path, String(index)], predicate, choices),
      );
    return result;
  }
  const inputSchema = visit(schema, []) as Record<string, Json>;
  if (model.requiredParameters) {
    if (
      model.requiredParameters.some(
        (key) =>
          !object(schema.properties) ||
          !Object.hasOwn(schema.properties, key) ||
          model.omitParameters?.includes(key),
      )
    )
      throw new AgentError('model_tool_parameter_unknown');
    inputSchema.required = [
      ...new Set([
        ...((inputSchema.required as string[]) ?? []),
        ...model.requiredParameters.map((key) => publicName([], key)),
      ]),
    ];
  }
  for (const path of Object.keys(model.parameterNames ?? {}))
    if (!seen.has(path) && model.parameterNames?.[path] !== path.split('.').at(-1))
      throw new AgentError('model_tool_parameter_unknown');
  // Each tool owns its schema registry. Remote/name-only tools need no second validator.
  const transformed =
    parameters.length > 0 || !!model.omitParameters?.length || !!model.requiredParameters?.length;
  if (!transformed) return { inputSchema, parameters };
  const validator = new Ajv({ allErrors: false, strict: false });
  const validate = validator.compile(inputSchema);
  const branches = new WeakMap<object, ReturnType<Ajv['compile']>>();
  const matches = (branch: Json, value: Json): boolean => {
    if (typeof branch === 'boolean') return branch;
    if (!object(branch)) return false;
    let check = branches.get(branch);
    if (!check) {
      check = new Ajv({ allErrors: false, strict: false }).compile(branch);
      branches.set(branch, check);
    }
    return !!check(value);
  };
  function active(
    original: Json,
    projected: Json,
    value: Json,
    path: string[],
    schemaPath: string[] = [],
  ): NonNullable<Rename> {
    if (!object(original) || !object(projected)) return [];
    const rules: NonNullable<Rename> = [];
    if (object(original.properties) && object(projected.properties) && object(value)) {
      for (const [key, child] of Object.entries(original.properties)) {
        const name = publicName(schemaPath, key);
        if (name !== key && Object.hasOwn(value, key) && !Object.hasOwn(projected.properties, key))
          throw new AgentError('model_tool_parameter_collision');
        if (!Object.hasOwn(projected.properties, name) || !Object.hasOwn(value, name)) continue;
        if (name !== key) rules.push({ path: [...path, key], name });
        rules.push(
          ...active(
            child,
            projected.properties[name]!,
            value[name]!,
            [...path, key],
            [...schemaPath, key],
          ),
        );
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const originals = original[keyword],
        projections = projected[keyword];
      if (!Array.isArray(originals) || !Array.isArray(projections)) continue;
      const selected = projections.flatMap((branch, index) =>
        keyword === 'allOf' || matches(branch, value)
          ? [active(originals[index]!, branch, value, path, schemaPath)]
          : [],
      );
      if (
        keyword === 'anyOf' &&
        selected.length > 1 &&
        selected.some((entry) => JSON.stringify(entry) !== JSON.stringify(selected[0]))
      )
        throw new AgentError('model_tool_parameter_ambiguous');
      rules.push(...selected.flat());
    }
    if (object(projected.if)) {
      const key = matches(projected.if, value) ? 'then' : 'else';
      if (original[key] !== undefined && projected[key] !== undefined)
        rules.push(...active(original[key]!, projected[key]!, value, path, schemaPath));
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const prefix = Array.isArray(projected.prefixItems) && index < projected.prefixItems.length;
        const child = prefix ? (original.prefixItems as Json[])[index] : original.items;
        const projection = prefix ? (projected.prefixItems as Json[])[index] : projected.items;
        if (child !== undefined && projection !== undefined)
          rules.push(
            ...active(
              child,
              projection,
              item,
              [...path, String(index)],
              [...schemaPath, prefix ? String(index) : '*'],
            ),
          );
      }
    }
    return [...new Map(rules.map((rule) => [JSON.stringify(rule.path), rule])).values()];
  }
  return {
    inputSchema,
    parameters,
    validate,
    active: (value: Json) => active(schema, inputSchema, value, []),
  };
}

function rename(value: Json, path: string[], target: string): void {
  if (!path.length) return;
  const [key, ...rest] = path;
  if (key === '*') {
    if (Array.isArray(value)) for (const entry of value) rename(entry, rest, target);
    return;
  }
  if (!object(value) && !Array.isArray(value)) return;
  if (!Object.hasOwn(value, key!)) return;
  const record = value as Record<string, Json>;
  if (rest.length) rename(record[key!]!, rest, target);
  else if (target !== key) {
    if (Object.hasOwn(record, target)) throw new AgentError('model_tool_parameter_collision');
    Object.defineProperty(record, target, {
      value: record[key!],
      enumerable: true,
      writable: true,
      configurable: true,
    });
    delete record[key!];
  }
}
function argumentsProjection(text: string, parameters: Rename, outward: boolean): string {
  if (!parameters?.length) return text;
  const value = JSON.parse(text) as Json;
  const rules = [...parameters].sort((a, b) =>
    outward ? b.path.length - a.path.length : a.path.length - b.path.length,
  );
  for (const rule of rules) {
    const path = [...rule.path];
    const original = path.at(-1)!;
    if (!outward) path[path.length - 1] = rule.name;
    rename(value, path, outward ? rule.name : original);
  }
  return JSON.stringify(value);
}

/** Restore the exact public shape of a recorded call without consulting today's tool registry. */
export function modelToolCall(call: ModelToolCall): ModelToolCall {
  const saved = (call as ToolCall).model;
  if (!saved) return { id: call.id, name: call.name, arguments: call.arguments };
  return {
    id: call.id,
    name: saved.name,
    arguments: saved.error
      ? call.arguments
      : argumentsProjection(call.arguments, saved.parameters, true),
  };
}
export function modelToolMessages(messages: ModelRequest['messages']): ModelRequest['messages'] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(modelToolCall) } : {}),
  }));
}

/** One exact selected catalogue. No builtin IDs or authority are inferred from public names. */
export function createModelToolSurface(
  request: ModelRequest,
  definitions: ReadonlyMap<string, ToolDefinition>,
) {
  const catalogue = new Map<
    string,
    {
      id: string;
      parameters: Rename;
      validate?: ReturnType<Ajv['compile']>;
      active?: (value: Json) => NonNullable<Rename>;
    }
  >();
  const tools: ModelTool[] = [];
  let changed = request.messages.some((message) =>
    message.toolCalls?.some((call) => (call as ToolCall).model !== undefined),
  );
  for (const tool of request.tools) {
    const definition = definitions.get(tool.id);
    const presentation =
      definition?.version === tool.definitionVersion ? definition.model : undefined;
    changed ||= presentation !== undefined;
    if (presentation?.hidden) continue;
    const name = presentation?.name ?? tool.id;
    if (presentation && !/^[a-z][a-z0-9_]{0,63}$/.test(name))
      throw new AgentError('model_tool_name_invalid');
    if (catalogue.has(name)) throw new AgentError('model_tool_name_collision');
    const projected = presentation
      ? schemaProjection(tool.inputSchema, presentation)
      : {
          inputSchema: tool.inputSchema,
          parameters: [],
        };
    catalogue.set(name, {
      id: tool.id,
      parameters: projected.parameters,
      ...('validate' in projected
        ? { validate: projected.validate, active: projected.active }
        : {}),
    });
    tools.push({ ...tool, id: name, inputSchema: projected.inputSchema });
  }
  return {
    changed,
    tools,
    request: { ...request, tools, messages: modelToolMessages(request.messages) },
    decode(call: ModelToolCall): ToolCall {
      const entry = catalogue.get(call.name);
      if (!entry)
        return {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          model: { name: call.name, error: 'tool_not_available' },
        };
      const model: NonNullable<ToolCall['model']> = {
        name: call.name,
      };
      try {
        const value = entry.validate ? (JSON.parse(call.arguments) as Json) : undefined;
        if (entry.validate && !entry.validate(value)) model.error = 'invalid_tool_arguments';
        const parameters = model.error ? undefined : (entry.active?.(value!) ?? entry.parameters);
        if (parameters?.length) model.parameters = parameters;
        return {
          id: call.id,
          name: entry.id,
          arguments: model.error
            ? call.arguments
            : argumentsProjection(call.arguments, parameters, false),
          ...(changed ? { model } : {}),
        };
      } catch {
        return {
          id: call.id,
          name: entry.id,
          arguments: call.arguments,
          model: { name: call.name, error: 'invalid_tool_arguments' },
        };
      }
    },
  };
}

/** Validate the small replay descriptor before using persisted data to project model history. */
export function isToolCallModel(value: unknown): boolean {
  if (
    !object(value) ||
    typeof value.name !== 'string' ||
    Object.keys(value).some((key) => !['name', 'parameters', 'error'].includes(key)) ||
    (value.error !== undefined &&
      !['invalid_tool_arguments', 'tool_not_available'].includes(String(value.error)))
  )
    return false;
  return (
    value.parameters === undefined ||
    (Array.isArray(value.parameters) &&
      value.parameters.every(
        (rule) =>
          object(rule) &&
          Object.keys(rule).every((key) => ['path', 'name'].includes(key)) &&
          typeof rule.name === 'string' &&
          Array.isArray(rule.path) &&
          rule.path.length > 0 &&
          rule.path.every((part) => typeof part === 'string'),
      ))
  );
}
