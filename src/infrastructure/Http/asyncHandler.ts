import type { NextFunction, Request, Response } from 'express';

export const asyncHandler =
  (
    handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
  ) =>
  (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
