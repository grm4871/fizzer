
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkIPs() {
  try {
    const tosAcceptances = await prisma.tos_acceptance.groupBy({
      by: ['ip_address'],
      _count: {
        ip_address: true,
      },
      orderBy: {
        _count: {
          ip_address: 'desc',
        },
      },
      take: 10,
    });

    console.log('Top IPs by registration count:');
    tosAcceptances.forEach((item) => {
      console.log(`IP: ${item.ip_address}, Count: ${item._count.ip_address}`);
    });
  } catch (error) {
    console.error('Error querying database:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkIPs();
