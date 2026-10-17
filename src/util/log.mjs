// @body:organ=muscle role="structured JSON-line logger (console)"
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  debug: (msg, fields = {}) => emit('debug', msg, fields),
  info: (msg, fields = {}) => emit('info', msg, fields),
  warn: (msg, fields = {}) => emit('warn', msg, fields),
  error: (msg, fields = {}) => emit('error', msg, fields),
};
