import { createApp } from './app.js';

const PORT = process.env.PORT || 4173;

const server = createApp();
server.listen(PORT, () => {
  console.log(`Canopy running at http://localhost:${PORT}`);
});
