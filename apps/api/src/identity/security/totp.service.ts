import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify } from 'otplib';

export interface TotpSetup {
  secret: string;
  provisioningUri: string;
}

@Injectable()
export class TotpService {
  private readonly issuer: string;

  constructor(config: ConfigService) {
    this.issuer = config.getOrThrow<string>('JWT_ISSUER');
  }

  createSetup(label: string): TotpSetup {
    const secret = generateSecret({ length: 20 });

    return {
      secret,
      provisioningUri: generateURI({ issuer: this.issuer, label, secret }),
    };
  }

  provisioningUri(label: string, secret: string): string {
    return generateURI({ issuer: this.issuer, label, secret });
  }

  async verifyCode(
    secret: string,
    token: string,
    lastUsedTimeStep: bigint | null = null,
    epoch?: number,
  ): Promise<bigint | null> {
    if (!/^\d{6}$/.test(token)) {
      return null;
    }

    const result = await verify({
      secret,
      token,
      epochTolerance: 30,
      ...(lastUsedTimeStep === null ? {} : { afterTimeStep: Number(lastUsedTimeStep) }),
      ...(epoch === undefined ? {} : { epoch }),
    });

    return result.valid && 'timeStep' in result ? BigInt(result.timeStep) : null;
  }
}
