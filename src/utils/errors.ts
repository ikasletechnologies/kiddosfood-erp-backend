export class PaymentValidationError extends Error {
  public readonly statusCode: number = 400;
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentValidationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
