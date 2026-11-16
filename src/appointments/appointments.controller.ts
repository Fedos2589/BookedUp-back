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
import {
  type AppointmentDto,
  type AppointmentInput,
  appointmentInput,
  appointmentsQuery,
  statusConflictSchema,
  statusInput,
  type StatusInput,
  type AppointmentsQuery,
  appointmentSchema,
  bookingConflictSchema,
} from './appointments.schema.js';
import { AppointmentsService } from './appointments.service.js';

const uuid = { schema: z.uuid() };

// Bookings of the masters. Who may book whom follows the staff rules (StaffService.authorizeChangeOf):
// one's own master always, others' as roles.ts allows.
@ApiTags('appointments')
@MemberOfBusiness()
@ApiUnauthorizedResponse({ description: 'No live session' })
@ApiForbiddenResponse({
  description: 'Not a member of this business (or no such business), or the role may not book this master',
})
@ApiNotFoundResponse({ description: 'No such master in this business' })
@ApiTooManyRequestsResponse({ description: 'Too many requests; try again later' })
@Controller('businesses/:businessId/appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  @ApiCreatedResponse({ description: 'Booked', schema: openApi(appointmentSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiConflictResponse({
    description:
      'The time is not a free slot of the master (code notFree: not a slot at all, or taken) or the meeting has no seat left (code full)',
    schema: openApi(bookingConflictSchema),
  })
  create(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Body({ schema: appointmentInput }) body: AppointmentInput,
  ): Promise<AppointmentDto> {
    return this.appointments.create(actor, businessId, body, new Date());
  }

  @Get()
  @ApiOkResponse({
    description: 'Bookings that start on these days of the business clock, by start; a master gets only their own',
    schema: openApi(z.array(appointmentSchema)),
  })
  @ApiBadRequestResponse({ description: 'A query field is invalid', schema: openApi(validationErrorSchema) })
  list(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Query({ schema: appointmentsQuery }) query: AppointmentsQuery,
  ): Promise<AppointmentDto[]> {
    return this.appointments.list(actor, businessId, query);
  }

  @Patch(':appointmentId/status')
  @ApiNotFoundResponse({ description: 'No such booking in this business' })
  @ApiOkResponse({ description: 'The booking with its new status', schema: openApi(appointmentSchema) })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiConflictResponse({
    description:
      'Not an allowed move from the current status (code badTransition), or DONE / NO_SHOW before the booking starts (code notStarted)',
    schema: openApi(statusConflictSchema),
  })
  changeStatus(
    @CurrentUser() actor: AuthUser,
    @Param('businessId', uuid) businessId: string,
    @Param('appointmentId', uuid) appointmentId: string,
    @Body({ schema: statusInput }) body: StatusInput,
  ): Promise<AppointmentDto> {
    return this.appointments.changeStatus(actor, businessId, appointmentId, body, new Date());
  }
}
