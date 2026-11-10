import { z } from 'zod';

// 400 from StandardSchemaValidationPipe: one string per issue, the field path first
// (`business.timeZone: Unknown IANA time zone`).
export const validationErrorSchema = z.object({
  statusCode: z.literal(400),
  error: z.string(),
  message: z.array(z.string()),
});

// 409 on a taken unique value; `field` is the form field to highlight.
export const conflictErrorSchema = <const F extends readonly [string, ...string[]]>(fields: F) =>
  z.object({
    statusCode: z.literal(409),
    error: z.literal('Conflict'),
    message: z.string(),
    field: z.enum(fields),
  });

export const openApi = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' }) as object;
