import { z } from 'zod';

// Blank (or missing, or null) is no value: a form sends «» for an empty field.
export const blankIsNone = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

export const clientName = z.string().trim().min(1).max(100);
// E.164: «+», a country code that doesn't start with 0, 7 to 15 digits in all. The lower bound is the
// same as the `clients_phone` and `appointments_client_phone` CHECKs in the database: a looser one here
// would be a 500 there.
export const clientPhone = z
  .string()
  .max(16)
  .regex(/^\+[1-9]\d{6,14}$/, 'Not a phone number in the international format');

// A person is a holder (their own phone) or a dependent (a guardian who is a holder), never both and
// never neither: a union of two strict objects, so a body with both phone and guardianId is a 400.
export const clientInput = z.union([
  z.strictObject({ name: clientName, phone: clientPhone, note: blankIsNone(2000) }),
  z.strictObject({
    name: clientName,
    guardianId: z.uuid().describe('A holder of this business: a dependent has no phone of their own'),
    note: blankIsNone(2000),
  }),
]);
export type ClientInput = z.infer<typeof clientInput>;

export const clientSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string().nullable().describe('E.164; none for a dependent'),
  guardianId: z.uuid().nullable(),
  guardian: z.object({ id: z.uuid(), name: z.string(), phone: z.string() }).nullable(),
  note: z.string().nullable(),
  noShowCount: z.number().int().describe('NO_SHOW bookings of the client, all masters'),
});
export type ClientDto = z.infer<typeof clientSchema>;

// The card: the client, their dependents and how many visits they made.
export const clientCardSchema = clientSchema.extend({
  dependents: z.array(z.object({ id: z.uuid(), name: z.string() })).describe('By name'),
  visitCount: z.number().int().describe('DONE bookings of the client, all masters'),
});
export type ClientCardDto = z.infer<typeof clientCardSchema>;

// What may change; what is not given stays. A holder's phone can change, a dependent's can't (409 notHolder).
// The note: null or blank clears it.
export const clientPatch = z.strictObject({
  name: clientName.optional(),
  phone: clientPhone.optional(),
  note: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null)),
});
export type ClientPatch = z.infer<typeof clientPatch>;

// Paged by limit and offset: «show more», not page numbers.
export const pagingQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
};

export const clientsQuery = z.object({
  q: z.string().trim().max(100).optional().describe('Part of a name, or of a phone (digits only)'),
  phone: clientPhone.optional().describe('The holder of this phone and their dependents; q and paging are ignored'),
  ...pagingQuery,
});
export type ClientsQuery = z.infer<typeof clientsQuery>;

export const clientsPageSchema = z.object({
  items: z.array(clientSchema),
  total: z.number().int().describe('All matches, not just this page'),
});
export type ClientsPageDto = z.infer<typeof clientsPageSchema>;

// 409: `phoneTaken` — the phone has a holder already (`clientId`, so the form can offer them);
// `notHolder` — the guardian is not an account holder.
export const clientConflictCode = z.enum(['phoneTaken', 'notHolder']);

export const clientConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.literal('Conflict'),
  message: z.string(),
  code: clientConflictCode,
  clientId: z.uuid().optional().describe('With phoneTaken: the holder of the phone'),
});

export const pagingSchema = z.object(pagingQuery);
export type Paging = z.infer<typeof pagingSchema>;
