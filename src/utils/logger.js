// src/utils/logger.js
const pad = (s) => (s < 10 ? `0${s}` : `${s}`);
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  info: (...args) => console.log(`[INFO ] ${timestamp()} `, ...args),
  warn: (...args) => console.warn(`[WARN ] ${timestamp()} `, ...args),
  error: (...args) => console.error(`[ERROR] ${timestamp()} `, ...args),
};
