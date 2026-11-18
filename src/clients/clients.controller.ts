import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';

import { MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  type ClientDto,
  type ClientInput,
  type ClientsPageDto,
  type ClientsQuery,
  clientConflictSchema,
  clientInput,
  clientsPageSchema,
  clientsQuery,
  clientSchema,
} from './clients.schema.js';
import { ClientsService } from './clients.service.js';

const uuid = { schema: z.uuid() };

// The people of a business who book. Every member sees and adds them: a master books their own clients.
@ApiTags('clients')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({ description: 'Not a member of this business (or no such business)' })
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Post()
  @ApiCreatedResponse({ description: 'The new client', schema: openApi(clientSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No such guardian in this business' })
  @ApiConflictResponse({
    description:
      'The phone has a holder already (code phoneTaken, with their clientId), or the guardian has no phone of their own (code notHolder)',
    schema: openApi(clientConflictSchema),
  })
  create(
    @Param('businessId', uuid) businessId: string,
    @Body({ schema: clientInput }) body: ClientInput,
  ): Promise<ClientDto> {
    return this.clients.create(businessId, body);
  }

  @Get()
  @ApiOkResponse({
    description:
      'Clients by name; with phone, the holder of that phone and their dependents (holder first). A page and the total',
    schema: openApi(clientsPageSchema),
  })
  @ApiBadRequestResponse({ description: 'A query field is invalid', schema: openApi(validationErrorSchema) })
  list(
    @Param('businessId', uuid) businessId: string,
    @Query({ schema: clientsQuery }) query: ClientsQuery,
  ): Promise<ClientsPageDto> {
    return this.clients.list(businessId, query);
  }
}
