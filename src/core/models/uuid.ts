import { z } from 'zod';

/**
 * A UUID that comes from outside (a path, a request body, a GraphQL argument, the subject of a
 * JWT), lower-cased. PostgreSQL compares UUIDs without case, but a string comparison and a Map
 * lookup do not, so every id is brought to the form PostgreSQL returns where it enters. One
 * schema for all of them: they accept the same form, and none passes a malformed id on to
 * PostgreSQL (SQLSTATE 22P02).
 */
export const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
