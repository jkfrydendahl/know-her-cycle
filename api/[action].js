import { createHandler } from '../server/http.js';

export const config = { api: { bodyParser: { sizeLimit: '12kb' } } };
export default createHandler();
