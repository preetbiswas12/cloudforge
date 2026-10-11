/** An error with an HTTP status code attached, thrown by route/service code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, message, 'bad_request');
export const notFound = (message: string) => new HttpError(404, message, 'not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');
export const tooLarge = (message: string) => new HttpError(413, message, 'payload_too_large');
export const forbidden = (message: string) => new HttpError(403, message, 'forbidden');