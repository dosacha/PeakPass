import { z } from 'zod';

/**
 * The id of a row that comes from outside, lower-cased: the subject of a JWT, an id in a path,
 * the id fields of a request body (reservation, checkout with its Idempotency-Key, settlement,
 * demo settlement, the admission join and the admission fields of a purchase) and the id argument
 * of the GraphQL event query.
 *
 * PostgreSQL compares UUIDs without case, but a string comparison and a Map lookup do not, so an
 * id is brought to the form PostgreSQL returns where it enters. All of them go through this one
 * schema: they accept the same form, and none passes a malformed id on to PostgreSQL (SQLSTATE
 * 22P02).
 *
 * Not for an Idempotency-Key of a settlement. That key is stored as text and is the string as it
 * was sent; the demo settlement checks its shape only.
 */
export const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
