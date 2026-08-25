import type { SessionResumeErrorCode } from './types.ts'

/** Stable service error for provider-neutral session registry operations. */
export class SessionResumeError extends Error {
  /**
   * @param code - Stable machine-readable failure code.
   * @param message - Human-readable diagnostic.
   * @param detail - Optional structured context for logs and adapters.
   * @param options - Optional native error cause.
   */
  constructor(
    readonly code: SessionResumeErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionResumeError'
  }
}
