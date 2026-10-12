import { z } from 'zod';

/**
 * A UUID taken from a path or an argument, lower-cased. One schema for every route, so that all
 * of them accept the same form and none passes a malformed id on to PostgreSQL (SQLSTATE 22P02).
 */
export const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
