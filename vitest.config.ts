import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'nuxt',
    include: ['test/nuxt/**/*.spec.ts'],
    // El entorno de Nuxt tarda más de 10 s en arrancar la primera vez (y en CI siempre es la primera).
    hookTimeout: 60_000,
  },
})
