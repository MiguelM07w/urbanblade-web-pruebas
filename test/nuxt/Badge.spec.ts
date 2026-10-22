/**
 * Prueba unitaria de un componente visual con Vue Test Utils (T084).
 *
 * UiBadge es la etiqueta de color que muestra estados como "Confirmada" o
 * "Pendiente". Recibe dos props: tone (el color) y dot (si muestra el punto de
 * la izquierda). mount() lo dibuja en un navegador simulado (happy-dom) para
 * revisar el HTML que genera, sin abrir Chrome.
 */
import { describe, expect, it } from 'vitest'
// mount() viene de Vue Test Utils: monta el componente y regresa un "wrapper" para inspeccionarlo.
import { mount } from '@vue/test-utils'
import Badge from '~/components/ui/Badge.vue'

describe('UiBadge', () => {
  it('muestra el texto con el tono pedido', () => {
    // Monta el componente con tone="success" y el texto "Confirmada" en su slot
    // (el slot es el contenido que va entre <UiBadge> y </UiBadge>).
    const wrapper = mount(Badge, { props: { tone: 'success' }, slots: { default: 'Confirmada' } })

    // Debe mostrar exactamente el texto que se le pasó...
    expect(wrapper.text()).toBe('Confirmada')
    // ...y llevar la clase CSS del tono verde de éxito.
    expect(wrapper.classes()).toContain('text-success')
  })

  it('oculta el punto cuando dot es false', () => {
    const wrapper = mount(Badge, { props: { dot: false }, slots: { default: 'Pendiente' } })

    // El punto es un <span aria-hidden="true">; con dot=false no debe existir en el HTML.
    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(false)
  })
})
