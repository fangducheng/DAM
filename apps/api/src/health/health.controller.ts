import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import type { LivenessResponse, ReadinessResponse } from '@dam/contracts';

import { HealthService } from './health.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Process liveness probe' })
  @ApiResponse({ status: 200, description: 'The API process is alive.' })
  live(): LivenessResponse {
    return this.healthService.liveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Dependency readiness probe' })
  @ApiResponse({ status: 200, description: 'All required dependencies are available.' })
  @ApiResponse({ status: 503, description: 'One or more required dependencies are unavailable.' })
  async ready(): Promise<ReadinessResponse> {
    const readiness = await this.healthService.readiness();
    if (readiness.status === 'degraded') {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
