import { prisma } from '../../data-utils.js';

export async function findEarliestId(table: 'genus' | 'spaces'): Promise<string> {
  if (table === 'spaces') {
    const result = await prisma.$queryRaw<any[]>`SELECT find_earliest_space_id() AS id`;
    return result[0].id;
  } else {
    const result = await prisma.$queryRaw<any[]>`SELECT find_earliest_genus_id() AS id`;
    return result[0].id;
  }
}
