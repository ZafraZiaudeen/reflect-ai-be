export const asyncHandler = (handler) => (request, response, next) => {
    void handler(request, response, next).catch(next);
};
