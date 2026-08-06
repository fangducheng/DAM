import { Injectable, type OnModuleDestroy } from '@nestjs/common';

import { PrismaClient } from '@dam/database';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
