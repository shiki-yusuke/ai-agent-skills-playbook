// Shared minimal JSON Schema (draft 2020-12 subset) validator: type, const, enum, pattern,
// minLength, minimum, maxItems, minItems, uniqueItems, required, properties,
// additionalProperties, items, allOf, if/then/else, and $ref (to a sibling schema file, or
// to a local #/$defs/... pointer). Extracted out
// of contracts/agent-metrics/v1/verify-fixtures.mjs so every contract's verify script shares
// one implementation instead of re-implementing it. This is exactly the subset this repo's
// schemas use -- it is not a general draft 2020-12 implementation, and does not replace a
// real validator (e.g. ajv) for schemas outside this repo.
//
// Usage: const { validate } = createValidator(schemaDir); validate("some.schema.json", instance)
// `schemaDir` is the directory $ref filenames are resolved relative to (normally the calling
// contract's own directory, so "envelope.schema.json" means "<schemaDir>/envelope.schema.json").

import { readFileSync } from "node:fs";
import path from "node:path";

export function createValidator(schemaDir) {
  const schemaFileCache = new Map();

  function loadSchemaFile(filename) {
    if (!schemaFileCache.has(filename)) {
      const text = readFileSync(path.join(schemaDir, filename), "utf-8");
      schemaFileCache.set(filename, JSON.parse(text));
    }
    return schemaFileCache.get(filename);
  }

  function resolvePointer(doc, pointer) {
    // pointer looks like "#/$defs/tokenUsageRecord"
    const parts = pointer.replace(/^#\//, "").split("/").filter(Boolean);
    let node = doc;
    for (const part of parts) node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return node;
  }

  function resolveRef(ref, currentDoc) {
    if (ref.startsWith("#/")) {
      return { schema: resolvePointer(currentDoc, ref), doc: currentDoc };
    }
    const [filename, pointer] = ref.split("#");
    const doc = loadSchemaFile(filename);
    if (!pointer) return { schema: doc, doc };
    return { schema: resolvePointer(doc, "#" + pointer), doc };
  }

  function typeOf(instance) {
    if (instance === null) return "null";
    if (Array.isArray(instance)) return "array";
    if (typeof instance === "number") return Number.isInteger(instance) ? "integer" : "number";
    return typeof instance; // "string" | "object" | "boolean"
  }

  function validateAgainst(schema, instance, currentDoc, pathStr, errors) {
    if (schema.$ref) {
      const { schema: refSchema, doc: refDoc } = resolveRef(schema.$ref, currentDoc);
      validateAgainst(refSchema, instance, refDoc, pathStr, errors);
      return;
    }
    if (schema.allOf) {
      for (const sub of schema.allOf) validateAgainst(sub, instance, currentDoc, pathStr, errors);
      return;
    }
    // if/then/else: `if` is evaluated in an isolated error list (never leaked into the
    // caller's `errors` on its own) purely to decide which branch applies; only the chosen
    // branch's errors (if any) are appended to `errors`. This composes with every other
    // keyword on the same schema object -- it does not return early -- so a schema can mix
    // e.g. `required` with a conditional `if/then` at the same level.
    if (schema.if) {
      const ifErrors = [];
      validateAgainst(schema.if, instance, currentDoc, pathStr, ifErrors);
      const branch = ifErrors.length === 0 ? schema.then : schema.else;
      if (branch) validateAgainst(branch, instance, currentDoc, pathStr, errors);
    }
    if (schema.const !== undefined && instance !== schema.const) {
      errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`);
    }
    if (schema.enum && !schema.enum.includes(instance)) {
      errors.push(`${pathStr}: ${JSON.stringify(instance)} not in enum ${JSON.stringify(schema.enum)}`);
    }
    if (schema.type) {
      // `type` may be a single string or (draft 2020-12) an array of alternatives, e.g.
      // ["integer", "null"] for a nullable numeric field -- needed by contracts that
      // represent "genuinely unmeasured" as null rather than 0 (never collapse the two).
      const actual = typeOf(instance);
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      const ok = allowed.some((t) => actual === t || (t === "number" && actual === "integer"));
      if (!ok) errors.push(`${pathStr}: expected type ${JSON.stringify(schema.type)}, got ${actual}`);
    }
    if (schema.pattern && typeof instance === "string" && !new RegExp(schema.pattern).test(instance)) {
      errors.push(`${pathStr}: ${JSON.stringify(instance)} does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && typeof instance === "string" && instance.length < schema.minLength) {
      errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.minimum !== undefined && typeof instance === "number" && instance < schema.minimum) {
      errors.push(`${pathStr}: ${instance} < minimum ${schema.minimum}`);
    }
    if (Array.isArray(instance)) {
      if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
        errors.push(`${pathStr}: array length ${instance.length} > maxItems ${schema.maxItems}`);
      }
      if (schema.minItems !== undefined && instance.length < schema.minItems) {
        errors.push(`${pathStr}: array length ${instance.length} < minItems ${schema.minItems}`);
      }
      if (schema.uniqueItems) {
        const seen = new Set();
        instance.forEach((item, i) => {
          const key = JSON.stringify(item);
          if (seen.has(key)) errors.push(`${pathStr}[${i}]: duplicate item, uniqueItems requires no repeats`);
          seen.add(key);
        });
      }
      if (schema.items) {
        instance.forEach((item, i) => validateAgainst(schema.items, item, currentDoc, `${pathStr}[${i}]`, errors));
      }
    }
    if (instance !== null && typeof instance === "object" && !Array.isArray(instance)) {
      if (schema.required) {
        for (const key of schema.required) {
          if (!(key in instance)) errors.push(`${pathStr}: missing required property "${key}"`);
        }
      }
      if (schema.properties) {
        for (const [key, subSchema] of Object.entries(schema.properties)) {
          if (key in instance) validateAgainst(subSchema, instance[key], currentDoc, `${pathStr}.${key}`, errors);
        }
      }
      if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(schema.properties || {}));
        for (const key of Object.keys(instance)) {
          if (!known.has(key)) errors.push(`${pathStr}: additional property "${key}" not allowed`);
        }
      }
    }
  }

  function validate(schemaFilename, instance) {
    const doc = loadSchemaFile(schemaFilename);
    const errors = [];
    validateAgainst(doc, instance, doc, "$", errors);
    return errors;
  }

  return { validate, loadSchemaFile, resolveRef, resolvePointer, typeOf, validateAgainst };
}
