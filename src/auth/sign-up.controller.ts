import { Body, Controller, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type SignUpInput, type SignUpResult, signUpResultSchema, signUpSchema } from './sign-up.schema.js';
import { SignUpService } from './sign-up.service.js';

@ApiTags('auth')
@Controller('auth')
export class SignUpController {
  constructor(private readonly signUpService: SignUpService) {}

  // Registers an owner with their business. Signing in comes with sessions (next step).
  @Post('sign-up')
  @ApiCreatedResponse({
    description: 'The owner and the business are created',
    schema: z.toJSONSchema(signUpResultSchema, { target: 'openapi-3.0' }) as object,
  })
  @ApiBadRequestResponse({ description: 'A field is invalid; messages are prefixed with its path' })
  @ApiConflictResponse({ description: 'The email or the slug is taken; `field` says which' })
  signUp(@Body({ schema: signUpSchema }) body: SignUpInput): Promise<SignUpResult> {
    return this.signUpService.signUp(body);
  }
}
