/**
 * Centralised toast-duration constants.
 *
 * Values match the existing literals at call sites — adopting them is a
 * pure rename, not a behaviour change. Toast.showToast itself defaults
 * `info`/`success`/`warning` to DEFAULT (3000 ms) and `error` to
 * PERSISTENT (0 ms = don't auto-dismiss). Pass an explicit value here
 * only when the default is wrong for the message.
 */
export const TOAST_DURATION = {
  /** Quick acknowledgments — "Copied to clipboard", small confirmations. */
  SHORT: 1500,
  /** Default for info/success/warning toasts. Matches showToast's implicit default. */
  DEFAULT: 3000,
  /** Slightly longer notices — operations that completed but the user
   *  should glance at the result. */
  MEDIUM: 5000,
  /** Detail-rich results (lookup output, multi-line summaries). */
  LONG: 8000,
  /** Extra-long for important results that need re-reading. */
  EXTRA_LONG: 10000,
  /** Stays until dismissed — same effect as showToast's error default. */
  PERSISTENT: 0,
} as const;

export type ToastDurationBucket = keyof typeof TOAST_DURATION;
