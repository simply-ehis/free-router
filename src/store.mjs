// @body:organ=blood type=store role="platform IO seam: text read/write/append — Node fs default, Workers KV override via setStore"
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

let impl = {
  read(p) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  write(p, text) {
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, p);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  },
  append(p, line) {
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, line);
  },
};

const defaultImpl = { ...impl };

// Workers entrypoint swaps implementations before first use.
export function setStore(overrides) {
  impl = { ...defaultImpl, ...overrides };
}

export function resetStore() {
  impl = { ...defaultImpl };
}

export const store = {
  read: (p) => impl.read(p),
  write: (p, text) => impl.write(p, text),
  writeDurable: (p, text) => impl.writeDurable ? impl.writeDurable(p, text) : Promise.resolve(impl.write(p, text)),
  append: (p, line) => impl.append(p, line),
};
