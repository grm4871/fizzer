'use strict';

const crypto = require('crypto');

/**
 * Main-process run/event registry. Renderer reloads must not erase ownership of
 * a still-running child or lose events produced while Chromium is unavailable.
 */
class AgentRunState {
  constructor({ maxEvents = 4000 } = {}) {
    this.instanceId = crypto.randomUUID();
    this.maxEvents = maxEvents;
    this.nextSeq = 1;
    this.active = new Set();
    this.events = [];
  }

  start(runId) {
    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('Invalid run id');
    if (this.active.has(id)) return false;
    this.active.add(id);
    return true;
  }

  record(payload) {
    const runId = Number(payload?.runId);
    if (!Number.isFinite(runId)) return null;
    const event = { ...payload, bridgeSeq: this.nextSeq++ };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (payload?.type === 'status') {
      try {
        const status = JSON.parse(payload.payload_json || '{}')?.status;
        if (status === 'completed' || status === 'failed' || status === 'canceled') {
          this.active.delete(runId);
        }
      } catch { /* malformed status is forwarded but cannot settle ownership */ }
    }
    return event;
  }

  cancel(runId) {
    this.active.delete(Number(runId));
  }

  snapshot(afterSeq = 0) {
    const cursor = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
    return {
      instanceId: this.instanceId,
      activeRunIds: [...this.active],
      events: this.events.filter((event) => event.bridgeSeq > cursor),
      cursor: this.nextSeq - 1,
    };
  }
}

module.exports = { AgentRunState };
