import { HttpError } from '../Errors/HttpError.js';
export const errorMiddleware = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
        response.status(error.statusCode).json({
            message: error.message,
            details: error.details,
        });
        return;
    }
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    response.status(500).json({ message });
};
