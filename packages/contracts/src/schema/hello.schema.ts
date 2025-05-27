import { z } from 'zod';

export const HelloResponseSchema = z.object({
  message: z.string(),
});

export type HelloResponse = z.infer<typeof HelloResponseSchema>; 