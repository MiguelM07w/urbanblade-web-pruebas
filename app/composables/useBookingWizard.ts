/**
 * ViewModel del asistente de reserva (T085).
 *
 * Guarda lo que el cliente va eligiendo (servicio, barbero, fecha y hora), en qué
 * paso va, cuánto pagará y qué horarios hay libres. No dibuja nada ni llama a la
 * API por su cuenta: Wizard.vue (la vista) le pasa los catálogos y la función que
 * pide los horarios. Así las pruebas pueden pasarle datos y una API falsa y
 * revisar toda la lógica sin abrir la página. Es el equivalente web del
 * BookingViewModel de la app Android.
 */
import { computed, ref, watch, type Ref } from 'vue'
import type { BarberRow, ProductRow, ServiceRow, Slot } from '~/types/booking'

/** Lo que el ViewModel necesita de afuera. */
export interface BookingWizardOptions {
  /** Catálogos que Wizard.vue ya cargó de la API. */
  services: Ref<ServiceRow[]>
  barbers: Ref<BarberRow[]>
  suggestedProducts: Ref<ProductRow[]>
  /** % de descuento de la membresía del cliente (0 si no tiene o es invitado). */
  discountPct: Ref<number>
  /** Selección con la que se entra, p. ej. de un enlace ?servicio=... o al volver del login. */
  initial?: { serviceId?: string, barberId?: string, date?: string, time?: string }
  /** Pide los horarios libres; en la página es GET /availability/slots, en las pruebas un vi.fn(). */
  fetchSlots: (query: { barber_id: string, service_id: string, date: string }) => Promise<{ slots?: Slot[] }>
}

// Se calcula sobre el precio YA con descuento (mismo criterio que loyaltyCharge.ts
// usa en recepción: descuento primero, propina después).
const TIP_PRESETS = [0, 0.10, 0.15, 0.20] as const

// Agrupar horarios por franja del día -- una sola lista plana de 20+ botones se
// siente vacía/monótona aunque haya bastante disponibilidad; agruparlos con un
// encabezado da la sensación de "hay opciones organizadas". max = minuto del día
// en que termina la franja (12 * 60 = 12:00).
const SLOT_GROUPS = [
  { key: 'manana', label: 'Mañana', max: 12 * 60 },
  { key: 'tarde', label: 'Tarde', max: 18 * 60 },
  { key: 'noche', label: 'Noche', max: Infinity },
] as const

// Fechas armadas en horario local, nunca con toISOString(): el backend valida
// 'after_or_equal:today' contra America/Mexico_City, y en UTC-6 el ISO de
// "hoy por la noche" ya cae en mañana.
function localISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "16:30" -> 990 minutos desde la medianoche. */
function slotMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export function useBookingWizard(opts: BookingWizardOptions) {
  // ── Selección del cliente ─────────────────────────────────────────────────
  const serviceId = ref(opts.initial?.serviceId ?? '')
  const barberId = ref(opts.initial?.barberId ?? '')
  const date = ref(opts.initial?.date ?? '')
  const time = ref(opts.initial?.time ?? '')
  // Paso que el cliente abrió a mano para revisarlo; null = el paso lo decide la selección.
  const activeStep = ref<number | null>(null)

  const selectedService = computed(() => opts.services.value.find(s => s.id === serviceId.value) ?? null)
  const selectedBarber = computed(() => opts.barbers.value.find(b => b.id === barberId.value) ?? null)

  // ── Pasos: 0 Servicio, 1 Barbero, 2 Horario, 3 Confirmar ─────────────────
  // El paso sale de lo que falta por elegir: sin servicio se queda en 0, sin
  // barbero en 1, sin fecha u hora en 2, y con todo listo pasa a confirmar.
  const step = computed(() => {
    if (activeStep.value !== null) return activeStep.value
    if (!serviceId.value) return 0
    if (!barberId.value) return 1
    if (!date.value || !time.value) return 2

    return 3
  })

  function pickService(id: string) {
    activeStep.value = null
    serviceId.value = id
    time.value = ''
  }
  function pickBarber(id: string) {
    activeStep.value = null
    barberId.value = id
    time.value = ''
  }
  function goToStep(target: number) {
    // Revisar un paso no destruye el borrador. Cambiar la selección invalida la hora.
    activeStep.value = target
  }

  // ── Productos sugeridos (paso de confirmar) ──────────────────────────────
  const selectedProductIds = ref<Set<string>>(new Set())
  function toggleProduct(id: string) {
    // Se crea un Set nuevo en vez de modificar el actual para que Vue detecte el cambio.
    const next = new Set(selectedProductIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selectedProductIds.value = next
  }
  const selectedProducts = computed(() =>
    opts.suggestedProducts.value.filter(p => selectedProductIds.value.has(p.id)),
  )
  const productsTotal = computed(() => selectedProducts.value.reduce((sum, p) => sum + p.precio_venta, 0))

  // ── Descuento de membresía/lealtad ───────────────────────────────────────
  // El mismo % que ya calcula PaymentService al cobrar (ver
  // LoyaltyService::bestDiscountPct) -- se muestra aquí solo como referencia
  // honesta de cuánto va a pagar realmente, sea que pague ahora o después.
  const discountedServicePrice = computed(() => {
    const base = selectedService.value?.precio ?? 0
    return opts.discountPct.value > 0
      ? Math.round(base * (1 - opts.discountPct.value / 100) * 100) / 100
      : base
  })

  // ── Propina sugerida ──────────────────────────────────────────────────────
  const tipPreset = ref<number>(0)
  const customTip = ref<string>('')
  const usingCustomTip = computed(() => customTip.value !== '')
  const tipAmount = computed(() => {
    if (usingCustomTip.value) {
      // Lo que el cliente escribe a mano: si no es un número válido o es negativo, cuenta como $0.
      const parsed = Number(customTip.value)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
    }
    return Math.round(discountedServicePrice.value * tipPreset.value)
  })
  function pickTipPreset(pct: number) {
    tipPreset.value = pct
    customTip.value = ''
  }

  // Total que ve el cliente: servicio con descuento + productos + propina.
  const grandTotal = computed(() => discountedServicePrice.value + productsTotal.value + tipAmount.value)
  // Lo que se cobra si elige "pagar ahora": servicio + propina (los productos se pagan en el salón).
  const payAmountToCharge = computed(() => discountedServicePrice.value + tipAmount.value)

  // ── Días ofrecidos: hoy y los 13 siguientes ──────────────────────────────
  const days = computed(() => Array.from({ length: 14 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() + i)

    return {
      iso: localISO(d),
      weekday: d.toLocaleDateString('es-MX', { weekday: 'short' }),
      day: d.getDate(),
      month: d.toLocaleDateString('es-MX', { month: 'short' }),
      isToday: i === 0,
    }
  }))

  // ── Horarios reales ───────────────────────────────────────────────────────
  const slots = ref<Slot[]>([])
  const slotsPending = ref(false)
  const slotsFailed = ref(false)
  // Número de la última petición. Si el cliente cambia de día rápido, una
  // respuesta vieja puede llegar después de la nueva; con este contador se ignora.
  let slotsRequest = 0

  async function loadSlots() {
    const request = ++slotsRequest
    if (!serviceId.value || !barberId.value || !date.value) {
      slots.value = []
      slotsPending.value = false
      return
    }
    slotsPending.value = true
    slotsFailed.value = false
    try {
      const res = await opts.fetchSlots({ barber_id: barberId.value, service_id: serviceId.value, date: date.value })
    if (request !== slotsRequest) return
      slots.value = res.slots ?? []
      // La hora que traía el cliente (p. ej. de un enlace) ya no está libre: se borra para que elija otra.
      if (time.value && !slots.value.some(s => s.time === time.value)) {
        time.value = ''
      }
    }
    catch {
      if (request !== slotsRequest) return
      slotsFailed.value = true
      slots.value = []
    }
    finally {
      if (request === slotsRequest) slotsPending.value = false
    }
  }
  // Cada vez que cambia el servicio, el barbero o la fecha se vuelven a pedir los horarios.
  watch([serviceId, barberId, date], loadSlots, { immediate: true })

  const groupedSlots = computed(() => {
    const groups = SLOT_GROUPS.map(g => ({ ...g, slots: [] as Slot[] }))
    for (const slot of slots.value) {
      const minutes = slotMinutes(slot.time)
      const group = groups.find(g => minutes < g.max) ?? groups[groups.length - 1]!
      group.slots.push(slot)
    }
    return groups.filter(g => g.slots.length)
  })

  return {
    serviceId,
    barberId,
    date,
    time,
    activeStep,
    selectedService,
    selectedBarber,
    step,
    pickService,
    pickBarber,
    goToStep,
    selectedProductIds,
    selectedProducts,
    toggleProduct,
    productsTotal,
    discountedServicePrice,
    TIP_PRESETS,
    tipPreset,
    customTip,
    usingCustomTip,
    tipAmount,
    pickTipPreset,
    grandTotal,
    payAmountToCharge,
    days,
    slots,
    slotsPending,
    slotsFailed,
    loadSlots,
    groupedSlots,
  }
}
