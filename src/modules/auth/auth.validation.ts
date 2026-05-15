import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    identifier: z.string({
      required_error: 'Email or phone is required',
    }),
    password: z.string({
      required_error: 'Password is required',
    }).min(6, 'Password must be at least 6 characters'),
  }),
});

export const registerSchema = z.object({
  body: z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
    role: z.enum(['SUPER_ADMIN', 'FRANCHISE_ADMIN']).optional(),
  }),
});
