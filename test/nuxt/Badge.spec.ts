import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Badge from '~/components/ui/Badge.vue'

describe('UiBadge', () => {
  it('muestra el texto con el tono pedido', () => {
    const wrapper = mount(Badge, { props: { tone: 'success' }, slots: { default: 'Confirmada' } })
    expect(wrapper.text()).toBe('Confirmada')
    expect(wrapper.classes()).toContain('text-success')
  })

  it('oculta el punto cuando dot es false', () => {
    const wrapper = mount(Badge, { props: { dot: false }, slots: { default: 'Pendiente' } })
    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(false)
  })
})
