const { isVercelRuntime } = require('./runtimeScope');
function runBackgroundTask(task) {
  if (isVercelRuntime()) {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(Promise.resolve().then(task));
  } else {
    process.nextTick(task);
  }
}

module.exports = { runBackgroundTask };
