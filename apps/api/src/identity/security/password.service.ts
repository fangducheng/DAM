import { createHmac } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { argon2id, hash, verify } from 'argon2';

@Injectable()
export class PasswordService {
  private readonly pepper: string;
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;
  private readonly minimumLength: number;

  constructor(config: ConfigService) {
    this.pepper = config.getOrThrow<string>('PASSWORD_PEPPER');
    this.memoryCost = config.getOrThrow<number>('ARGON2_MEMORY_KIB');
    this.timeCost = config.getOrThrow<number>('ARGON2_TIME_COST');
    this.parallelism = config.getOrThrow<number>('ARGON2_PARALLELISM');
    this.minimumLength = config.getOrThrow<number>('PASSWORD_MIN_LENGTH');
  }

  async hash(password: string): Promise<string> {
    this.assertAcceptable(password);

    return hash(this.peppered(password), {
      type: argon2id,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
      parallelism: this.parallelism,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, this.peppered(password));
    } catch {
      return false;
    }
  }

  assertAcceptable(password: string): void {
    if (password.length < this.minimumLength || password.length > 128) {
      throw new Error(`Password must contain ${this.minimumLength} to 128 characters`);
    }
  }

  private peppered(password: string): string {
    return createHmac('sha256', this.pepper).update(password, 'utf8').digest('base64url');
  }
}
