/**
 * Basic configuration loader
 */
require('dotenv').config();
module.exports = {
  httpPort: process.env.HTTP_PORT || 3000,
  wsPort: process.env.WS_PORT || 8080,
};

