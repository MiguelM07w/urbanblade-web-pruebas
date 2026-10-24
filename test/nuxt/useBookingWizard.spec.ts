/**
 * Pruebas unitarias del ViewModel de reserva, useBookingWizard (T085).
 *
 * El ViewModel no llama a la API por su cuenta: recibe los catálogos y una
 * función fetchSlots. Aquí se le pasan datos de ejemplo y un vi.fn() en lugar de
 * la API real, así que las pruebas no necesitan servidor ni internet y siempre
 * dan el mismo resultado. Cada prueba sigue el patrón Preparar -> Ejecutar -> Verificar.
 */
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useBookingWizard, type BookingWizardOptions } from '~/composables/useBookingWizard'
import type { BarberRow, ProductRow, ServiceRow, Slot } from '~/types/booking'

// ── Datos de ejemplo ────────────────────────────────────────────────────────
const corte: ServiceRow = { id: 'corte', nombre: 'Corte clásico', categoria: 'Cortes', precio: 250, duracion_min: 45, descripcion: null, imagen: null }
const barba: ServiceRow = { id: 'barba', nombre: 'Arreglo de barba', categoria: 'Barba', precio: 150, duracion_min: 30, descripcion: null, imagen: null }
const luis: BarberRow = { id: 'b1', slug: 'luis', user: { id: 'u1', name: 'Luis' }, especialidades: null, foto: null, avg_rating: null, total_reviews: 0, citas_conmigo: null, es_favorito: false }
const cera: ProductRow = { id: 'p1', nombre: 'Cera mate', categoria: null, descripcion: null, precio_venta: 100, stock_actual: 5, imagen: null }
const aceite: ProductRow = { id: 'p2', nombre: 'Aceite para barba', categoria: null, descripcion: null, precio_venta: 50, stock_actual: 3, imagen: null }

/** Arma un horario como los que regresa la API: { time: '10:00', label: '10:00' }. */
const horario = (time: string): Slot => ({ time, label: time })

/**
 * Crea el ViewModel con los datos de ejemplo. Por defecto la "API" de horarios
 * responde sin horarios; cada prueba cambia solo lo que necesita.
 */
function crearViewModel(cambios: Partial<BookingWizardOptions> = {}) {
  return useBookingWizard({
    services: ref([corte, barba]),
    barbers: ref([luis]),
    suggestedProducts: ref([cera, aceite]),
    discountPct: ref(0),
    fetchSlots: vi.fn().mockResolvedValue({ slots: [] }),
    ...cambios,
  })
}

/** Selección completa, como si el cliente llegara de un enlace con todo elegido. */
const seleccionCompleta = { serviceId: 'corte', barberId: 'b1', date: '2026-10-23', time: '10:00' }

afterEach(() => {
  // Regresa el reloj real por si alguna prueba lo detuvo.
  vi.useRealTimers()
})

describe('useBookingWizard', () => {
  describe('pasos del asistente', () => {
    it('avanza de paso al elegir servicio, barbero y horario', () => {
      const vm = crearViewModel()
      expect(vm.step.value).toBe(0) // 0 = Servicio

      vm.pickService('corte')
      expect(vm.step.value).toBe(1) // 1 = Barbero

      vm.pickBarber('b1')
      expect(vm.step.value).toBe(2) // 2 = Horario

      vm.date.value = '2026-10-23'
      vm.time.value = '10:00'
      expect(vm.step.value).toBe(3) // 3 = Confirmar
    })

    it('cambiar de servicio o de barbero borra la hora elegida', () => {
      const vm = crearViewModel({ initial: seleccionCompleta })

      // Otro servicio puede durar distinto, así que la hora ya no sirve.
      vm.pickService('barba')
      expect(vm.time.value).toBe('')

      vm.time.value = '10:00'
      vm.pickBarber('b1')
      expect(vm.time.value).toBe('')
    })

    it('regresar a un paso para revisarlo no borra lo ya elegido', () => {
      const vm = crearViewModel({ initial: seleccionCompleta })
      expect(vm.step.value).toBe(3)

      vm.goToStep(0)

      expect(vm.step.value).toBe(0)
      expect(vm.serviceId.value).toBe('corte')
      expect(vm.time.value).toBe('10:00')
    })
  })

  describe('precio, propina y total', () => {
    it('aplica el descuento de la membresía al precio del servicio', () => {
      const discountPct = ref(10)
      const vm = crearViewModel({ discountPct, initial: { serviceId: 'corte' } })

      // $250 menos el 10 % = $225.
      expect(vm.discountedServicePrice.value).toBe(225)

      // Sin membresía se cobra el precio normal. El cálculo es reactivo: se actualiza solo.
      discountPct.value = 0
      expect(vm.discountedServicePrice.value).toBe(250)
    })

    it('calcula la propina sobre el precio con descuento y un monto inválido cuenta como $0', () => {
      const vm = crearViewModel({ discountPct: ref(10), initial: { serviceId: 'corte' } })

      // 15 % de $225 = $33.75, que se redondea a $34.
      vm.pickTipPreset(0.15)
      expect(vm.tipAmount.value).toBe(34)

      // Monto escrito a mano.
      vm.customTip.value = '50'
      expect(vm.tipAmount.value).toBe(50)
      vm.customTip.value = '-5'
      expect(vm.tipAmount.value).toBe(0)
      vm.customTip.value = 'abc'
      expect(vm.tipAmount.value).toBe(0)

      // Elegir un porcentaje borra el monto escrito a mano.
      vm.pickTipPreset(0.20)
      expect(vm.customTip.value).toBe('')
      expect(vm.tipAmount.value).toBe(45)
    })

    it('el total suma el servicio con descuento, los productos y la propina', () => {
      const vm = crearViewModel({ discountPct: ref(10), initial: { serviceId: 'corte' } })

      vm.toggleProduct('p1') // cera, $100
      vm.toggleProduct('p2') // aceite, $50
      vm.pickTipPreset(0.20) // 20 % de $225 = $45

      // $225 + $150 + $45 = $420.
      expect(vm.grandTotal.value).toBe(420)
      // Si paga ahora solo se cobran servicio y propina: $225 + $45 = $270.
      expect(vm.payAmountToCharge.value).toBe(270)

      // Volver a tocar un producto lo quita: $420 - $50 = $370.
      vm.toggleProduct('p2')
      expect(vm.grandTotal.value).toBe(370)
    })
  })

  describe('días y horarios', () => {
    it('ofrece 14 días desde hoy usando la fecha local', () => {
      // Se detiene el reloj en el 21 de octubre de 2026 a las 23:30, hora local.
      // En México (UTC-6) en UTC ya sería el día 22; con toISOString() saldría mal.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 9, 21, 23, 30))

      const vm = crearViewModel()

      expect(vm.days.value).toHaveLength(14)
      expect(vm.days.value[0]).toMatchObject({ iso: '2026-10-21', isToday: true })
      expect(vm.days.value[13]?.iso).toBe('2026-11-03')
    })

    it('agrupa los horarios en mañana, tarde y noche sin mostrar grupos vacíos', () => {
      const vm = crearViewModel()

      vm.slots.value = [horario('10:00'), horario('12:00'), horario('18:30')]
      expect(vm.groupedSlots.value.map(g => g.key)).toEqual(['manana', 'tarde', 'noche'])

      // Sin horarios de tarde, ese grupo no aparece.
      vm.slots.value = [horario('09:00'), horario('19:00')]
      expect(vm.groupedSlots.value.map(g => g.key)).toEqual(['manana', 'noche'])
    })

    it('no pide horarios a la API mientras falte el servicio, el barbero o la fecha', async () => {
      const fetchSlots = vi.fn().mockResolvedValue({ slots: [] })
      const vm = crearViewModel({ fetchSlots, initial: { serviceId: 'corte', barberId: 'b1' } })
      await flushPromises() // espera a que terminen las tareas pendientes de Vue

      expect(fetchSlots).not.toHaveBeenCalled()

      // Al elegir la fecha ya está todo: ahora sí se piden los horarios de ese día.
      vm.date.value = '2026-10-23'
      await flushPromises()

      expect(fetchSlots).toHaveBeenCalledTimes(1)
      expect(fetchSlots).toHaveBeenCalledWith({ barber_id: 'b1', service_id: 'corte', date: '2026-10-23' })
    })

    it('borra la hora elegida si ya no está libre', async () => {
      // La API responde que solo queda libre las 11:00, pero el cliente traía las 10:00.
      const fetchSlots = vi.fn().mockResolvedValue({ slots: [horario('11:00')] })
      const vm = crearViewModel({ fetchSlots, initial: seleccionCompleta })
      await flushPromises()

      expect(vm.slots.value).toHaveLength(1)
      expect(vm.time.value).toBe('')
      expect(vm.slotsPending.value).toBe(false)
    })

    it('marca el error si la API de horarios falla', async () => {
      const fetchSlots = vi.fn().mockRejectedValue(new Error('Error 500'))
      const vm = crearViewModel({ fetchSlots, initial: seleccionCompleta })
      await flushPromises()

      expect(vm.slotsFailed.value).toBe(true)
      expect(vm.slots.value).toEqual([])
    })

    it('ignora una respuesta vieja que llega después de la nueva', async () => {
      // 1.ª petición (día 23): se queda esperando hasta que la resolvamos a mano.
      // 2.ª petición (día 24): responde de inmediato.
      let responderPrimera: (respuesta: { slots: Slot[] }) => void = () => {}
      const fetchSlots = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { responderPrimera = resolve }))
        .mockResolvedValueOnce({ slots: [horario('16:00')] })
      const vm = crearViewModel({ fetchSlots, initial: { serviceId: 'corte', barberId: 'b1', date: '2026-10-23' } })

      // El cliente cambia de día antes de que llegue la 1.ª respuesta.
      vm.date.value = '2026-10-24'
      await flushPromises()

      // Ahora llega tarde la respuesta del día 23: no debe pisar los horarios del 24.
      responderPrimera({ slots: [horario('09:00')] })
      await flushPromises()

      expect(fetchSlots).toHaveBeenCalledTimes(2)
      expect(vm.slots.value.map(s => s.time)).toEqual(['16:00'])
    })
  })
})
