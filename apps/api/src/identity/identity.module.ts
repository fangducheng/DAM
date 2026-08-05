import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';

import { AccessTokenGuard } from './auth/access-token.guard.js';
import { MfaGuard } from './auth/mfa.guard.js';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { InvitationService } from './invitation.service.js';
import { IdentityTokenService } from './security/identity-token.service.js';
import { PasswordService } from './security/password.service.js';
import { SecurityCryptoService } from './security/security-crypto.service.js';
import { TotpService } from './security/totp.service.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: 60_000,
          limit: config.getOrThrow<number>('AUTH_RATE_LIMIT_MAX'),
        },
      ],
    }),
  ],
  controllers: [IdentityController],
  providers: [
    AccessTokenGuard,
    MfaGuard,
    IdentityService,
    InvitationService,
    SessionService,
    IdentityTokenService,
    PasswordService,
    SecurityCryptoService,
    TotpService,
  ],
  exports: [AccessTokenGuard, MfaGuard, IdentityTokenService],
})
export class IdentityModule {}
