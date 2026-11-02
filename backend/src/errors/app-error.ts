export type ErrorCode =
  | 'LINK_NOT_FOUND'
  | 'LINK_EXPIRED'
  | 'DOWNLOADS_EXHAUSTED'
  | 'PASSWORD_REQUIRED'
  | 'WRONG_PASSWORD'
  | 'RATE_LIMITED'
  | 'FILE_TOO_LARGE'
  | 'VALIDATION_ERROR'
  | 'UPLOAD_NOT_FOUND';

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static linkNotFound(message: string = 'The requested share link does not exist.'): AppError {
    return new AppError('LINK_NOT_FOUND', message, 404);
  }

  static uploadNotFound(message: string = 'The upload session was not found.'): AppError {
    return new AppError('UPLOAD_NOT_FOUND', message, 404);
  }

  static linkExpired(message: string = 'This file share link has expired and is no longer accessible.'): AppError {
    return new AppError('LINK_EXPIRED', message, 410);
  }

  static downloadsExhausted(message: string = 'This file share link has reached its maximum download limit and has been destroyed.'): AppError {
    return new AppError('DOWNLOADS_EXHAUSTED', message, 410);
  }

  static passwordRequired(message: string = 'This file is password-protected. Password is required.'): AppError {
    return new AppError('PASSWORD_REQUIRED', message, 401);
  }

  static wrongPassword(message: string = 'The provided password is incorrect.'): AppError {
    return new AppError('WRONG_PASSWORD', message, 401);
  }

  static rateLimited(message: string = 'Too many requests. Please try again later.'): AppError {
    return new AppError('RATE_LIMITED', message, 429);
  }

  static fileTooLarge(message: string = 'File size exceeds allowed maximum limit.'): AppError {
    return new AppError('FILE_TOO_LARGE', message, 413);
  }

  static validationError(message: string): AppError {
    return new AppError('VALIDATION_ERROR', message, 400);
  }
}
