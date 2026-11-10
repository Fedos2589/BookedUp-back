import { Public } from '@nestjs/authentication';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ description: 'The API process is up' })
  check() {
    return { status: 'ok' } as const;
  }
}
