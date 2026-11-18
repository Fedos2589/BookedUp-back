import { CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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

import type { AuthUser } from '../auth/auth-types.js';
import { MemberOfBusiness } from '../business/business.policy.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { type ClientAppointmentsPageDto, clientAppointmentsPageSchema } from './client-appointments.schema.js';
import {
  type ClientCardDto,
  clientCardSchema,
  type ClientDto,
  type ClientPatch,
  clientPatch,
  type ClientInput,
  type ClientsPageDto,
  type ClientsQuery,
  type Paging,
  pagingSchema,
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

  @Get(':clientId')
  @ApiOkResponse({ description: 'The client with their dependents and counters', schema: openApi(clientCardSchema) })
  @ApiNotFoundResponse({ description: 'No such client in this business' })
  card(
    @Param('businessId', uuid) businessId: string,
    @Param('clientId', uuid) clientId: string,
  ): Promise<ClientCardDto> {
    return this.clients.card(businessId, clientId);
  }

  @Patch(':clientId')
  @ApiOkResponse({ description: 'The client as changed', schema: openApi(clientSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No such client in this business' })
  @ApiConflictResponse({
    description:
      'The phone has a holder already (code phoneTaken, with their clientId), or the client is a dependent and has no phone of their own (code notHolder)',
    schema: openApi(clientConflictSchema),
  })
  update(
    @Param('businessId', uuid) businessId: string,
    @Param('clientId', uuid) clientId: string,
    @Body({ schema: clientPatch }) body: ClientPatch,
  ): Promise<ClientDto> {
    return this.clients.update(businessId, clientId, body);
  }

  @Get(':clientId/appointments')
  @ApiOkResponse({
    description:
      "The client's bookings, newest first, cancelled too; a master gets only their own. A page and the total",
    schema: openApi(clientAppointmentsPageSchema),
  })
  @ApiBadRequestResponse({ description: 'A query field is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No such client in this business' })
  appointments(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('clientId', uuid) clientId: string,
    @Query({ schema: pagingSchema }) paging: Paging,
  ): Promise<ClientAppointmentsPageDto> {
    return this.clients.appointments(actor, businessId, clientId, paging);
  }
}
