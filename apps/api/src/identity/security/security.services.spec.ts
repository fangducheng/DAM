import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';

import { IdentityTokenService } from './identity-token.service.js';
import { PasswordService } from './password.service.js';
import { SecurityCryptoService } from './security-crypto.service.js';
import { TotpService } from './totp.service.js';

const configuration = {
  PASSWORD_PEPPER: 'test-password-pepper',
  TOKEN_HASH_SECRET: 'test-token-hash-secret-with-32-characters',
  TOTP_ENCRYPTION_KEY: 'test-totp-encryption-key-with-32-characters',
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
  PASSWORD_MIN_LENGTH: 12,
  JWT_ISSUER: 'enterprise-dam-test',
  JWT_AUDIENCE: 'enterprise-dam-test-api',
  JWT_ACCESS_SECRET: 'test-jwt-access-secret-with-32-characters',
  MFA_CHALLENGE_TTL_MINUTES: 5,
};

function config(): ConfigService {
  return new ConfigService(configuration);
}

describe('identity security services', () => {
  it('hashes and verifies passwords with Argon2id', async () => {
    const service = new PasswordService(config());
    const passwordHash = await service.hash('correct horse battery staple');

    expect(passwordHash).toContain('$argon2id$');
    await expect(service.verify(passwordHash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(service.verify(passwordHash, 'incorrect password')).resolves.toBe(false);
    expect(() => service.assertAcceptable('too-short')).toThrow();
  });

  it('encrypts secrets and hashes opaque tokens', () => {
    const service = new SecurityCryptoService(config());
    const encrypted = service.encryptSecret('JBSWY3DPEHPK3PXP');

    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(service.decryptSecret(encrypted)).toBe('JBSWY3DPEHPK3PXP');
    expect(service.hashToken('token')).toHaveLength(64);
    expect(service.hashToken('token')).toBe(service.hashToken('token'));
    expect(service.generateRecoveryCodes()).toHaveLength(10);
  });

  it('verifies TOTP codes once per time step', async () => {
    const service = new TotpService(config());
    const setup = service.createSetup('admin@example.test');
    const epoch = 1_800_000_000;
    const token = await generate({ secret: setup.secret, epoch });
    const timeStep = await service.verifyCode(setup.secret, token, null, epoch);

    expect(setup.provisioningUri).toContain('otpauth://totp/');
    expect(timeStep).not.toBeNull();
    await expect(service.verifyCode(setup.secret, token, timeStep, epoch)).resolves.toBeNull();
  });

  it('separates access tokens from MFA challenges', async () => {
    const service = new IdentityTokenService(new JwtService(), config());
    const accessToken = await service.signAccessToken(
      {
        userId: '00000000-0000-7000-8000-000000000001',
        tenantId: '00000000-0000-7000-8000-000000000002',
        sessionId: '00000000-0000-7000-8000-000000000003',
        authenticationMethods: ['password', 'totp'],
      },
      15,
    );
    const challenge = await service.signMfaChallenge(
      '00000000-0000-7000-8000-000000000001',
      '00000000-0000-7000-8000-000000000002',
      '00000000-0000-7000-8000-000000000003',
    );

    await expect(service.verifyAccessToken(accessToken)).resolves.toMatchObject({
      purpose: 'access',
      amr: ['password', 'totp'],
    });
    await expect(service.verifyMfaChallenge(challenge)).resolves.toMatchObject({ purpose: 'mfa' });
    await expect(service.verifyAccessToken(challenge)).rejects.toThrow();
  });
});
