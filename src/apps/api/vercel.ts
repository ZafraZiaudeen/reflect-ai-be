import { createApiApp } from './app.js';

const app = createApiApp({
  connectDatabasePerRequest: true,
});

export default app;
