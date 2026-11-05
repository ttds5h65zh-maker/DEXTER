// Tool registry. Risk levels:
//   read     — reads data (may be untrusted external content)
//   organize — changes Dexter's own records (tasks, memory, schedules, documents)
//   prepare  — prepares something externally without sending it (e.g. a Gmail draft)
//   act      — sends, submits, changes or deletes something; needs approval
import { localTools } from './local.js';
import { googleTools } from './google.js';
import { browserTools } from './browser.js';

export function createToolRegistry(app) {
  const all = [...localTools(app), ...googleTools(app), ...browserTools(app)];
  const byName = new Map();
  for (const t of all) {
    if (byName.has(t.name)) throw new Error(`Duplicate tool ${t.name}`);
    if (t.risk === 'act' && !t.approval) throw new Error(`Tool ${t.name} is an action and must require approval`);
    if (t.approval && typeof t.preview !== 'function') throw new Error(`Tool ${t.name} needs a preview for its approval card`);
    byName.set(t.name, t);
  }
  // Deterministic order keeps the request prefix identical between turns.
  const defs = all.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  return {
    get: (name) => byName.get(name),
    list: () => all,
    definitions: () => defs,
  };
}
