// @body:organ=nerve role="runtime platform flag for capability-specific dashboard behavior"
let platform = 'node';

export function setRuntimePlatform(value) {
  platform = value;
}

export function isWorkerRuntime() {
  return platform === 'worker';
}
