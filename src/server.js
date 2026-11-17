import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Asset tracker listening on port ${config.port}`));

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
