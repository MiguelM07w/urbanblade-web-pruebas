/**
 * Configuración de Vitest, el ejecutor de pruebas unitarias de la web (T084).
 *
 * defineVitestConfig viene de @nuxt/test-utils: lee nuxt.config.ts para que las
 * pruebas entiendan lo mismo que la app (el alias "~", los componentes y los
 * auto-imports como ref o computed).
 */
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    // Ejecuta cada prueba dentro de una app Nuxt simulada, con happy-dom como navegador.
    environment: 'nuxt',
    // Solo busca pruebas en test/nuxt/. Es la carpeta que el tsconfig de Nuxt 4 ya
    // incluye, y así Vitest no toma las pruebas de Playwright que viven en e2e/.
    include: ['test/nuxt/**/*.spec.ts'],
    // El entorno de Nuxt tarda más de 10 s en arrancar la primera vez (y en CI siempre es la primera).
    hookTimeout: 60_000,
  },
})
