import { describe, expect, it } from 'vitest';
import { kineticEnergy, neighborIds, stepForce, type ForceBody } from '../orbitForce';

function body(id: string, x: number, y: number): ForceBody {
  return { id, x, y, vx: 0, vy: 0 };
}

describe('orbit force layout', () => {
  it('repels unlinked nodes away from each other', () => {
    let nodes = [body('a', 0, 0), body('b', 12, 0)];
    for (let i = 0; i < 40; i += 1) nodes = stepForce(nodes, []);
    expect(Math.abs(nodes[1].x - nodes[0].x)).toBeGreaterThan(40);
  });

  it('pulls linked nodes toward a rest length', () => {
    let nodes = [body('a', 0, 0), body('b', 280, 0)];
    for (let i = 0; i < 80; i += 1) nodes = stepForce(nodes, [{ from: 'a', to: 'b' }]);
    const dist = Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y);
    expect(dist).toBeGreaterThan(70);
    expect(dist).toBeLessThan(180);
  });

  it('leaves pinned nodes in place', () => {
    let nodes: ForceBody[] = [
      { id: 'pin', x: 10, y: 10, vx: 4, vy: -3, pinned: true },
      body('free', 20, 10),
    ];
    nodes = stepForce(nodes, []);
    expect(nodes[0].x).toBe(10);
    expect(nodes[0].y).toBe(10);
    expect(nodes[0].vx).toBe(0);
  });

  it('reports neighbors and energy', () => {
    expect([...neighborIds([{ from: 'a', to: 'b' }, { from: 'c', to: 'a' }], 'a')].sort()).toEqual(['b', 'c']);
    expect(kineticEnergy([body('a', 0, 0)])).toBe(0);
  });
});
