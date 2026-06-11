import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const folderId = '099fefc7-3ca1-4329-bb03-3ceab7f71d66';
  console.log(`Checking folder: ${folderId}`);
  
  const folder = await prisma.sidebar_folders.findUnique({
    where: { id: folderId }
  });
  console.log('Folder:', folder);

  const items = await prisma.sidebar_items.findMany({
    where: { folder_id: folderId }
  });
  
  console.log('Items in folder:');
  for (const item of items) {
    const netdoc = await prisma.netdoc.findUnique({
      where: { id: item.netdoc_id },
      select: { name: true }
    });
    console.log(`- [${item.netdoc_id}] ${netdoc?.name}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
