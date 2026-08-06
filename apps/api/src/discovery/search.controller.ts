import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '@dam/contracts';

import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import { CurrentUser } from '../identity/auth/current-user.decorator.js';
import { SearchAssetsQueryDto } from './dto/discovery.dto.js';
import { SearchService } from './search.service.js';

@ApiTags('search')
@ApiBearerAuth()
@Controller('spaces/:spaceId/search')
@UseGuards(AccessTokenGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search viewable assets within one space' })
  search(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: SearchAssetsQueryDto,
  ) {
    return this.searchService.search(actor, spaceId, query);
  }
}
