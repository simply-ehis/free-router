// @body:organ=blood role="in-process event bus: route events feed the SSE monitor"
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);
