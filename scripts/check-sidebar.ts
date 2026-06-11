import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const userId = '982e892e-03ea-4e84-aedd-25e6221eaa7d';
  console.log(`Checking sidebar for user: ${userId}`);
  
  const folders = await prisma.sidebar_folders.findMany({
    where: { user_id: userId },
    orderBy: { order_key: 'asc' }
  });
  console.log('Folders:');
  folders.forEach(f => {
    console.log(`- [${f.id}] ${f.name} (order: ${f.order_key})`);
  });

  const items = await prisma.sidebar_items.findMany({
    where: { user_id: userId },
    orderBy: { order_key: 'asc' }
  });
  console.log('Items:');
  for (const item of items) {
    const netdoc = await prisma.netdoc.findUnique({
      where: { id: item.netdoc_id },
      select: { name: true }
    });
    console.log(`- [${item.id}] ${netdoc?.name} (folder: ${item.folder_id}, order: ${item.order_key})`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
