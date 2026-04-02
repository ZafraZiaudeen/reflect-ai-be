import { Router } from 'express';
import { MODEL_CATALOG } from '../../domain/Types/mirror.js';
export const modelsRouter = Router();
modelsRouter.get('/', (_request, response) => {
    response.json(MODEL_CATALOG);
});
