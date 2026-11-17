import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
const server = app.listen(config.port, () => console.log(`Asset tracker running at http://localhost:${config.port}`));

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
