import { z } from 'zod';

export interface User {
  id: string;
  email: string;
  name?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
