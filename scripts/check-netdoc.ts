import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const netdoc = await prisma.netdoc.findUnique({
    where: { id: BigInt(24) }
  });
  console.log('Netdoc 24:', netdoc);
}

main().catch(console.error).finally(() => prisma.$disconnect());
