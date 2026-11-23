import { Public } from '@nestjs/authentication';
import { Controller, Get, Param } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { slugSchema } from '../auth/sign-up.schema.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { type PublicBusinessDto, publicBusinessSchema } from './public-booking.schema.js';
import { PublicBookingService } from './public-booking.service.js';

// What a client does on a business's page, without an account. Never under /businesses/:businessId:
// the slug or a token is what finds the business, and the service filters everything by its id.
@ApiTags('public-booking')
@Public()
@Controller('public')
export class PublicBookingController {
  constructor(private readonly service: PublicBookingService) {}

  @Get('businesses/:slug')
  @ApiOkResponse({
    description: 'The business and the masters who take clients',
    schema: openApi(publicBusinessSchema),
  })
  @ApiBadRequestResponse({ description: 'The slug is malformed', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No business with this slug' })
  business(@Param('slug', { schema: slugSchema }) slug: string): Promise<PublicBusinessDto> {
    return this.service.business(slug);
  }
}
