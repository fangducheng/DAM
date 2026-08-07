export function assertLocalIntegrationRunner(integrationEnabled: boolean): void {
  if (integrationEnabled && process.env['DAM_LOCAL_INTEGRATION_RUNNER'] !== '1') {
    throw new Error(
      'Direct integration test execution is blocked. Use `pnpm test:integration:local` so the dedicated test database safety checks run first.',
    );
  }
}
