import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('system')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Describe the API service' })
  describe(): { name: string; version: string; documentation: string } {
    return {
      name: 'Enterprise DAM API',
      version: '0.1.0',
      documentation: '/api/docs',
    };
  }
}
