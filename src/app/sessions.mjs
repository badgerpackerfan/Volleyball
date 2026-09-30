import { dispatch, replaySet } from '../engine/set-engine.mjs';

/** One in-flight action. Only committed state is exposed to the renderer. */
export class SetSession {
  constructor(store, record, metadata = () => ({ id: crypto.randomUUID(), occurredAt: new Date().toISOString() })) {
    this.store = store;
    this.record = structuredClone(record);
    this.state = replaySet(record);
    this.metadata = metadata;
    this.busy = false;
  }
  async run(command) {
    if (this.busy) throw new Error('Wait for the current action to finish saving.');
    this.busy = true;
    try {
      const next = dispatch(this.record, command, { ...this.metadata(), expectedRevision: this.state.revision });
      await this.store.save(next.record, this.state.revision);
      this.record = next.record;
      this.state = next.state;
      return this.state;
    } finally { this.busy = false; }
  }
}
