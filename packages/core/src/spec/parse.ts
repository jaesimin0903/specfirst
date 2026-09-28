import { parseDocument } from 'yaml';
import { SpecError } from './errors.js';
import { specSchema, type Spec } from './schema.js';

/** Parse and validate spec YAML text. Throws SpecError (exit code 2) on any problem. */
export function parseSpec(yamlText: string): Spec {
  const doc = parseDocument(yamlText, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new SpecError(
      'spec is not valid YAML',
      doc.errors.map((e) => ({ path: e.linePos ? `line ${e.linePos[0].line}` : '', message: e.message })),
    );
  }
  const raw: unknown = doc.toJS();
  const result = specSchema.safeParse(raw);
  if (!result.success) {
    throw new SpecError(
      'spec failed validation',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
