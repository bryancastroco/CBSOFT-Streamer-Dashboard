import { z } from "zod";

/**
 * Input contracts for the auth surface. Shared by the Server Action and by
 * tests; the client form does no validation the server does not repeat.
 */

export const signInSchema = z.object({
  email: z.string().trim().min(1, "Email is required").pipe(z.email("Enter a valid email address")),
  // Length only. Composition rules belong to Supabase Auth, which owns the
  // password policy; duplicating them here would drift.
  password: z.string().min(1, "Password is required"),
  next: z.string().optional(),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const roleChangeSchema = z.object({
  userId: z.uuid("A valid user is required"),
  role: z.enum(["admin", "viewer"]),
});

export type RoleChangeInput = z.infer<typeof roleChangeSchema>;
