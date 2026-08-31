export type ForceVec = { x: number; y: number };

export type ForceBody = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
  mass?: number;
};

export type ForceLink = { from: string; to: string };

const REPULSION = 2800;
const SPRING = 0.045;
const REST_LENGTH = 118;
const GRAVITY = 0.012;
const DAMPING = 0.86;
const MAX_SPEED = 9;

export function neighborIds(edges: ForceLink[], id: string) {
  const next = new Set<string>();
  for (const edge of edges) {
    if (edge.from === id) next.add(edge.to);
    else if (edge.to === id) next.add(edge.from);
  }
  return next;
}

export function stepForce(bodies: ForceBody[], links: ForceLink[]): ForceBody[] {
  const byId = new Map(bodies.map((body) => [body.id, { ...body }]));
  const next = bodies.map((body) => ({ ...body }));

  for (let i = 0; i < next.length; i += 1) {
    for (let j = i + 1; j < next.length; j += 1) {
      const a = next[i];
      const b = next[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 16) {
        dx = dx || 1;
        dy = dy || 1;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const force = REPULSION / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.pinned) {
        a.vx -= fx / (a.mass || 1);
        a.vy -= fy / (a.mass || 1);
      }
      if (!b.pinned) {
        b.vx += fx / (b.mass || 1);
        b.vy += fy / (b.mass || 1);
      }
    }
  }

  for (const link of links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b) continue;
    const left = next.find((body) => body.id === a.id);
    const right = next.find((body) => body.id === b.id);
    if (!left || !right) continue;
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const dist = Math.max(8, Math.hypot(dx, dy));
    const stretch = dist - REST_LENGTH;
    const fx = (dx / dist) * stretch * SPRING;
    const fy = (dy / dist) * stretch * SPRING;
    if (!left.pinned) {
      left.vx += fx;
      left.vy += fy;
    }
    if (!right.pinned) {
      right.vx -= fx;
      right.vy -= fy;
    }
  }

  for (const body of next) {
    if (body.pinned) {
      body.vx = 0;
      body.vy = 0;
      continue;
    }
    body.vx -= body.x * GRAVITY;
    body.vy -= body.y * GRAVITY;
    body.vx *= DAMPING;
    body.vy *= DAMPING;
    const speed = Math.hypot(body.vx, body.vy);
    if (speed > MAX_SPEED) {
      body.vx = (body.vx / speed) * MAX_SPEED;
      body.vy = (body.vy / speed) * MAX_SPEED;
    }
    body.x += body.vx;
    body.y += body.vy;
  }

  return next;
}

export function kineticEnergy(bodies: ForceBody[]) {
  return bodies.reduce((sum, body) => sum + body.vx * body.vx + body.vy * body.vy, 0);
}
