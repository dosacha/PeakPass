import { z } from 'zod';

/**
 * A UUID that comes from outside, lower-cased.
 *
 * PostgreSQL compares UUIDs without case, but a string comparison and a Map lookup do not. A
 * value this schema has parsed is in the form PostgreSQL returns, and is one PostgreSQL accepts
 * as a UUID. A field of a path, a body or a GraphQL argument that is validated as a UUID is
 * parsed here, and the subject of a JWT is read through it.
 *
 * What stays as sent:
 * - a JWT subject this schema does not accept (see `extractUserFromToken`);
 * - the Idempotency-Key header. The Redis lock and the cached answer of the idempotency
 *   middleware use the header as sent, and so does a settlement. A checkout parses its key here
 *   before the key reaches PostgreSQL;
 * - a field that is not validated as a UUID, such as `tierId` (an entry of an event's pricing,
 *   not a row) and the transaction id of a payment provider. It is compared as sent even when it
 *   has the shape of a UUID.
 */
export const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
