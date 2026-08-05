import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const encryptionVersion = 'v1';
const recoveryAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

@Injectable()
export class SecurityCryptoService {
  private readonly encryptionKey: Buffer;
  private readonly tokenHashSecret: string;

  constructor(config: ConfigService) {
    this.encryptionKey = createHash('sha256')
      .update(config.getOrThrow<string>('TOTP_ENCRYPTION_KEY'), 'utf8')
      .digest();
    this.tokenHashSecret = config.getOrThrow<string>('TOKEN_HASH_SECRET');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  hashToken(token: string): string {
    return createHmac('sha256', this.tokenHashSecret).update(token, 'utf8').digest('hex');
  }

  encryptSecret(secret: string): string {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, initializationVector);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

    return [
      encryptionVersion,
      initializationVector.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decryptSecret(encryptedSecret: string): string {
    const [version, initializationVector, authenticationTag, ciphertext] =
      encryptedSecret.split('.');

    if (
      version !== encryptionVersion ||
      initializationVector === undefined ||
      authenticationTag === undefined ||
      ciphertext === undefined
    ) {
      throw new Error('Unsupported encrypted secret format');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(initializationVector, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  generateRecoveryCodes(count = 10): Array<{ code: string; codeHash: string }> {
    return Array.from({ length: count }, () => {
      const bytes = randomBytes(10);
      const characters = Array.from(
        bytes,
        (value) => recoveryAlphabet[value % recoveryAlphabet.length],
      );
      const code = `${characters.slice(0, 5).join('')}-${characters.slice(5).join('')}`;

      return { code, codeHash: this.hashToken(this.normalizeRecoveryCode(code)) };
    });
  }

  hashRecoveryCode(code: string): string {
    return this.hashToken(this.normalizeRecoveryCode(code));
  }

  private normalizeRecoveryCode(code: string): string {
    return code.replaceAll('-', '').trim().toUpperCase();
  }
}
