import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const netdocs = await prisma.netdoc.findMany({
    where: { name: 'Timeline' }
  });
  console.log('Netdocs named Timeline:', netdocs.map(nd => ({ id: nd.id.toString(), name: nd.name })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
