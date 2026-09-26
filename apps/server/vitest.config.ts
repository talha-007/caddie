import { defineConfig } from 'vitest/config';

/*
 * Tests never touch a real Redis. With REDIS_URL in the developer's .env they
 * were writing into it: the guard tests' deliberate off-topic messages showed
 * up as 120 "declined" customers on the usage dashboard. Set before env.ts
 * loads the .env, and dotenv never overrides a variable that is already set.
 *
 * Nor OpenAI: a test that dropped its fake embedding provider once made a
 * live, paid embeddings call through the key in .env. Tests use fakes; with
 * no key, nothing can reach the real API by accident.
 */
export default defineConfig({
  test: {
    env: { REDIS_URL: '', OPENAI_API_KEY: '' },
  },
});
