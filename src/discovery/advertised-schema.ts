import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { canonicalJSON } from '../workspace/values.js';

export const JsonObject = Type.Record(Type.String(), Type.Unknown());
/** A JSON object: a tool's input schema, or the arguments of one call. */
export type JsonObject = Static<typeof JsonObject>;
const ObjectSchema = Type.Object({ type: Type.Literal('object'), properties: Type.Record(Type.String(), JsonObject),
  required: Type.Optional(Type.Array(Type.String())) });
const objectSchema = Compile(ObjectSchema);
const unionSchema = Compile(Type.Object({ anyOf: Type.Array(ObjectSchema, { minItems: 1 }) }));

/**
 * The input schema a discovery tool advertises to a model whose route cannot carry a union at a schema's root, which is
 * every route except OpenAI Codex's: Claude Code and Anthropic's API refuse one, Pi's Anthropic Messages conversion keeps
 * only the root's properties, and Gemini through OpenRouter nests its arguments under an invented key. An object schema
 * is used as it is. A union of objects becomes one object with every variant's properties, a property
 * that differs between variants as the `anyOf` of its versions, and only the properties every variant requires; mipmux
 * still checks each call against the exact union.
 */
export function advertisedSchema(schema: TSchema): JsonObject {
  const plain: unknown = JSON.parse(JSON.stringify(schema));
  if (objectSchema.Check(plain)) return plain;
  const { anyOf } = unionSchema.Parse(plain);
  const versions = new Map<string, JsonObject[]>();
  for (const variant of anyOf) {
    for (const [name, property] of Object.entries(variant.properties)) {
      const known = versions.get(name) ?? [];
      if (!known.some(version => canonicalJSON(version) === canonicalJSON(property))) known.push(property);
      versions.set(name, known);
    }
  }
  const required = anyOf.map(variant => new Set(variant.required ?? []));
  return { type: 'object', properties: Object.fromEntries([...versions].map(([name, known]) => [name, known.length === 1 ? known[0] : { anyOf: known }])),
    required: [...required[0] ?? []].filter(name => required.every(names => names.has(name))), additionalProperties: false };
}
