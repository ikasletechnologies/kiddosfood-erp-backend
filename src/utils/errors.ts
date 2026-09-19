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

export class TransferValidationError extends Error {
  public readonly statusCode: number = 400;
  public readonly details: any;

  constructor(message: string, details: any) {
    super(message);
    this.name = 'TransferValidationError';
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
