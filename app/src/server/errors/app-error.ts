export class AppError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode = 400,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
  }
}
