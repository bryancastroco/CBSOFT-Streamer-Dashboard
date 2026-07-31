import type { TokenValidation } from "@/lib/meta/token-status";

/**
 * The shape a Server Action returns, and its resting value.
 *
 * ## Why this is not in the action files
 *
 * A `use server` module may export **async functions and nothing else**. Next
 * enforces that at module evaluation, and the failure is total:
 *
 *     A "use server" file can only export async functions, found object
 *
 * is thrown before a single line of the module runs, so every page importing it
 * fails to render. One exported constant took down the streamer roster, the
 * streamer detail page, post detail and video detail simultaneously.
 *
 * The type alias was never the problem — types are erased before Next sees the
 * module. The `idleState` object was.
 *
 * `tests/use-server-exports.test.ts` enforces the rule across every action file
 * now, because nothing else did: it typechecks, it lints, it builds, and it
 * fails only when the route is actually requested.
 */

export type ActionState = {
  status: "idle" | "success" | "error";
  message: string | null;
  /** Field-level messages, keyed by form field name. */
  fieldErrors?: Record<string, string>;
  /** Populated after a token operation, so the UI can show the verdict. */
  validation?: TokenValidation | null;
};

/** Initial value for `useActionState`, before anything has been submitted. */
export const idleState: ActionState = { status: "idle", message: null };
