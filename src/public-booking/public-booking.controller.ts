import { Public } from '@nestjs/authentication';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { hours, Throttle } from '@nestjs/throttler';

import type { Response } from 'express';
import { z } from 'zod';

import { type LocaleBody, localeBodySchema } from '../account/locale.js';
import { type MoveInput, moveInput } from '../appointments/appointments.schema.js';
import {
  telegramLinkInput,
  type TelegramLinkInput,
  telegramLinkSchema,
  type TelegramLinkDto,
  bookingOrChannelNotFoundSchema,
} from '../notifications/link.schema.js';
import { type EmailOnInput, emailOnInput } from '../notifications/email.schema.js';
import { type PushOffInput, pushOffInput, type PushOnInput, pushOnInput } from '../notifications/push.schema.js';
import { slugSchema } from '../business/business.schema.js';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import { type PublicSlotsQuery, publicSlotsQuery, type SlotDto, slotSchema } from '../schedule/schedule.schema.js';
import {
  type PublicBookingInput,
  publicBookingConflictSchema,
  publicBookingInput,
  type PublicBookingResult,
  publicBookingResultSchema,
  type ManagedBookingDto,
  managedBookingConflictSchema,
  publicMoveConflictSchema,
  type BusinessManifestDto,
  businessManifestSchema,
  managedBookingSchema,
  manageTokenSchema,
  type PublicBusinessDto,
  publicBusinessSchema,
} from './public-booking.schema.js';
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
    description: 'The business and its masters who are still on the team (a master with no schedule yet has no slots)',
    schema: openApi(publicBusinessSchema),
  })
  @ApiBadRequestResponse({ description: 'The slug is malformed', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No business with this slug' })
  business(@Param('slug', { schema: slugSchema }) slug: string): Promise<PublicBusinessDto> {
    return this.service.business(slug);
  }

  @Get('businesses/:slug/manifest.webmanifest')
  @ApiOkResponse({
    description: "The business's web app manifest: installing /book/<slug> makes an app of its own",
    schema: openApi(businessManifestSchema),
  })
  @ApiBadRequestResponse({ description: 'The slug is malformed', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No business with this slug' })
  // The headers are set after the business is found: @Header would put them on the 404 too, and a
  // browser would keep «no such business» for an hour.
  async manifest(
    @Param('slug', { schema: slugSchema }) slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BusinessManifestDto> {
    const manifest = await this.service.manifest(slug);
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return manifest;
  }

  @Get('businesses/:slug/slots')
  @ApiOkResponse({
    description:
      "Free slots starting on the days asked (business's clock), earliest first, from now on: hours slots and meetings with `capacity` and `booked`. Nothing about who booked.",
    schema: openApi(z.array(slotSchema)),
  })
  @ApiBadRequestResponse({
    description: 'The slug is malformed, from or to is not a date, to is before from, or more than 31 days are asked',
    schema: openApi(validationErrorSchema),
  })
  @ApiNotFoundResponse({ description: 'No business with this slug' })
  slots(
    @Param('slug', { schema: slugSchema }) slug: string,
    @Query({ schema: publicSlotsQuery }) query: PublicSlotsQuery,
  ): Promise<SlotDto[]> {
    return this.service.slots(slug, query);
  }

  @Post('businesses/:slug/bookings')
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiCreatedResponse({
    description: 'Booked. `manageLink` is shown once: it is how the booker sees, cancels or moves it',
    schema: openApi(publicBookingResultSchema),
  })
  @ApiBadRequestResponse({ description: 'A field is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No business with this slug' })
  @ApiConflictResponse({
    description:
      'The time is not a free slot of the master (notFree), the meeting has no seat left (full), or this phone already has 3 bookings to come (tooManyBookings)',
    schema: openApi(publicBookingConflictSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many bookings from this address; try again later' })
  book(
    @Param('slug', { schema: slugSchema }) slug: string,
    @Body({ schema: publicBookingInput }) input: PublicBookingInput,
  ): Promise<PublicBookingResult> {
    return this.service.book(slug, input);
  }

  @Get('bookings/:token')
  @ApiOkResponse({ description: 'The booking the private link belongs to', schema: openApi(managedBookingSchema) })
  @ApiBadRequestResponse({ description: 'The token is malformed', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No booking with this token' })
  managed(@Param('token', { schema: manageTokenSchema }) token: string): Promise<ManagedBookingDto> {
    return this.service.managed(token);
  }

  @Post('bookings/:token/cancel')
  @ApiCreatedResponse({ description: 'Cancelled: the booking as it is now', schema: openApi(managedBookingSchema) })
  @ApiBadRequestResponse({ description: 'The token is malformed', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No booking with this token' })
  @ApiConflictResponse({
    description: 'The booking has started or is not BOOKED / CONFIRMED any more (badTransition)',
    schema: openApi(managedBookingConflictSchema),
  })
  cancel(@Param('token', { schema: manageTokenSchema }) token: string): Promise<ManagedBookingDto> {
    return this.service.cancel(token);
  }

  @Patch('bookings/:token')
  @ApiOkResponse({ description: 'Moved: the booking as it is now', schema: openApi(managedBookingSchema) })
  @ApiBadRequestResponse({ description: 'The token or a field is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No booking with this token' })
  @ApiConflictResponse({
    description:
      'The new place is not a free slot (notFree) or has no seat left (full), or the booking has started or is not BOOKED / CONFIRMED (badTransition)',
    schema: openApi(publicMoveConflictSchema),
  })
  move(
    @Param('token', { schema: manageTokenSchema }) token: string,
    @Body({ schema: moveInput }) input: MoveInput,
  ): Promise<ManagedBookingDto> {
    return this.service.move(token, input);
  }

  @Post('bookings/:token/telegram-link')
  @ApiCreatedResponse({
    description:
      'Open the link in Telegram and press Start: this booking gets its messages there. Valid for an hour. `locale` is the language of those messages.',
    schema: openApi(telegramLinkSchema),
  })
  @ApiBadRequestResponse({ description: 'The token or the locale is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({
    description: 'No booking with this token, or Telegram is not turned on here (channelOff)',
    schema: openApi(bookingOrChannelNotFoundSchema),
  })
  @ApiConflictResponse({
    description: 'The booking has started or is not BOOKED / CONFIRMED any more (badTransition)',
    schema: openApi(managedBookingConflictSchema),
  })
  telegramLink(
    @Param('token', { schema: manageTokenSchema }) token: string,
    @Body({ schema: telegramLinkInput }) { locale }: TelegramLinkInput,
  ): Promise<TelegramLinkDto> {
    return this.service.telegramLink(token, locale);
  }

  @Put('bookings/:token/push')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiNoContentResponse({
    description:
      'Web Push is on for this booking: its messages come to this browser, in `locale`. The same subscription again changes nothing; one that was turned off comes back on.',
  })
  @ApiBadRequestResponse({
    description: 'The token or a field is invalid, or the endpoint is not a known push service',
    schema: openApi(validationErrorSchema),
  })
  @ApiNotFoundResponse({
    description: 'No booking with this token, or Web Push is not turned on here (channelOff)',
    schema: openApi(bookingOrChannelNotFoundSchema),
  })
  @ApiConflictResponse({
    description: 'The booking has started or is not BOOKED / CONFIRMED any more (badTransition)',
    schema: openApi(managedBookingConflictSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this address; try again later' })
  pushOn(
    @Param('token', { schema: manageTokenSchema }) token: string,
    @Body({ schema: pushOnInput }) input: PushOnInput,
  ): Promise<void> {
    return this.service.pushOn(token, input);
  }

  @Put('bookings/:token/whatsapp')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiNoContentResponse({
    description:
      'WhatsApp is on for this client: the messages of every booking of their phone (their guardian’s, for a dependent) come there, in `locale`. Again changes nothing; a switched-off one comes back on.',
  })
  @ApiBadRequestResponse({ description: 'The token or the locale is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({
    description: 'No booking with this token, or WhatsApp is not turned on here (channelOff)',
    schema: openApi(bookingOrChannelNotFoundSchema),
  })
  @ApiConflictResponse({
    description: 'The booking has started or is not BOOKED / CONFIRMED any more (badTransition)',
    schema: openApi(managedBookingConflictSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this address; try again later' })
  whatsappOn(
    @Param('token', { schema: manageTokenSchema }) token: string,
    @Body({ schema: localeBodySchema }) { locale }: LocaleBody,
  ): Promise<void> {
    return this.service.whatsappOn(token, locale);
  }

  @Delete('bookings/:token/whatsapp')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'WhatsApp is off for this client (also when it was not on, or is not turned on here)',
  })
  @ApiBadRequestResponse({ description: 'The token is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No booking with this token' })
  whatsappOff(@Param('token', { schema: manageTokenSchema }) token: string): Promise<void> {
    return this.service.whatsappOff(token);
  }

  @Put('bookings/:token/email')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: hours(1) } })
  @ApiNoContentResponse({
    description:
      'Email is on for this booking: its messages come to this address, in `locale`. Another address replaces the old one; the same again changes nothing; a switched-off one comes back on.',
  })
  @ApiBadRequestResponse({
    description: 'The token or a field is invalid',
    schema: openApi(validationErrorSchema),
  })
  @ApiNotFoundResponse({
    description: 'No booking with this token, or email is not turned on here (channelOff)',
    schema: openApi(bookingOrChannelNotFoundSchema),
  })
  @ApiConflictResponse({
    description: 'The booking has started or is not BOOKED / CONFIRMED any more (badTransition)',
    schema: openApi(managedBookingConflictSchema),
  })
  @ApiTooManyRequestsResponse({ description: 'Too many requests from this address; try again later' })
  emailOn(
    @Param('token', { schema: manageTokenSchema }) token: string,
    @Body({ schema: emailOnInput }) input: EmailOnInput,
  ): Promise<void> {
    return this.service.emailOn(token, input);
  }

  @Delete('bookings/:token/email')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Email is off for this booking (also when it was not on, or is not turned on here)',
  })
  @ApiBadRequestResponse({ description: 'The token is invalid', schema: openApi(validationErrorSchema) })
  @ApiNotFoundResponse({ description: 'No booking with this token' })
  emailOff(@Param('token', { schema: manageTokenSchema }) token: string): Promise<void> {
    return this.service.emailOff(token);
  }

  @Delete('bookings/:token/push')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Web Push is off for this booking in that browser (also when it was not on, or is not turned on here)',
  })
  @ApiBadRequestResponse({
    description: 'The token or the endpoint is invalid',
    schema: openApi(validationErrorSchema),
  })
  @ApiNotFoundResponse({ description: 'No booking with this token' })
  pushOff(
    @Param('token', { schema: manageTokenSchema }) token: string,
    @Body({ schema: pushOffInput }) { endpoint }: PushOffInput,
  ): Promise<void> {
    return this.service.pushOff(token, endpoint);
  }
}
