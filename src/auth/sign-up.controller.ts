import { Body, Controller, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { openApi, validationErrorSchema } from '../common/api-errors.js';
import {
  signUpConflictSchema,
  type SignUpInput,
  type SignUpResult,
  signUpResultSchema,
  signUpSchema,
} from './sign-up.schema.js';
import { SignUpService } from './sign-up.service.js';

@ApiTags('auth')
@Controller('auth')
export class SignUpController {
  constructor(private readonly signUpService: SignUpService) {}

  // Registers an owner with their business. Signing in comes with sessions (next step).
  @Post('sign-up')
  @ApiCreatedResponse({
    description: 'The owner and the business are created',
    schema: openApi(signUpResultSchema),
  })
  @ApiBadRequestResponse({
    description: 'A field is invalid; messages are prefixed with its path',
    schema: openApi(validationErrorSchema),
  })
  @ApiConflictResponse({
    description: 'The email or the slug is taken; `field` says which',
    schema: openApi(signUpConflictSchema),
  })
  signUp(@Body({ schema: signUpSchema }) body: SignUpInput): Promise<SignUpResult> {
    return this.signUpService.signUp(body);
  }
}
