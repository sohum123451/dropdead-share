import { Request, Response } from 'express';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'LINK_NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
}
