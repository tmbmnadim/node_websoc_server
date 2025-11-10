// src/config/index.js
require('dotenv').config();

const HTTP_PORT = process.env.HTTP_PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

module.exports = {
  httpPort: Number(HTTP_PORT),
  wsPath: WS_PATH,
};
