<script setup lang="ts">
import { loadStripe, type Stripe, type StripeCardElement, type StripeElements } from '@stripe/stripe-js'
import type { ChoiceOption } from '~/types/choice'
import type { BarberRow, ProductRow, ServiceRow, Slot } from '~/types/booking'

const props = withDefaults(defineProps<{ initialBarber?: string, embedded?: boolean }>(), { initialBarber: '', embedded: false })
const emit = defineEmits<{ confirmed: [code: string], busy: [value: boolean] }>()

interface Barbershop {
  nombre: string | null
  direccion: string | null
  telefono: string | null
  horario_apertura: string | null
  horario_cierre: string | null
  politica_cancelacion: number | null
}

const { apiFetch } = useApi()
const { isAuthenticated, hasRole, user, fetchMe } = useAuth()
const runtimeConfig = useRuntimeConfig()
const route = useRoute()

// /reservar es pública y no pasa por el middleware 'auth', así que nadie
// carga el usuario: con la cookie puesta pero user en null, hasRole() da
// false para TODO y el cliente legítimo veía "tu cuenta es de personal de la
// barbería" sin poder confirmar. Mismo patrón que equipo/[slug].vue.
if (isAuthenticated.value && !user.value) {
  await fetchMe()
}

const notes = ref('')

// ── Datos públicos ────────────────────────────────────────────────────────
const { data: shopData } = await useAsyncData<{ data: Barbershop }>(
  'reservar-barbershop',
  () => apiFetch('/barbershop'),
)
const shop = computed(() => shopData.value?.data ?? null)

const { data: servicesData, pending: servicesPending, error: servicesError } = await useAsyncData<{ data: ServiceRow[] }>(
  'reservar-services',
  () => apiFetch('/services'),
)
const services = computed(() => servicesData.value?.data ?? [])

const { data: barbersData, pending: barbersPending, error: barbersError } = await useAsyncData<{ data: BarberRow[] }>(
  'reservar-barbers',
  () => apiFetch('/barbers'),
)
const barbers = computed(() => barbersData.value?.data ?? [])

// ── Productos sugeridos (paso de confirmar) ──────────────────────────────
// Reutiliza el mismo catalogo publico de la tienda (GET /products) -- no es
// un catalogo aparte, solo se sugieren 4 con stock disponible para no
// abrumar el paso de confirmar con la tienda completa.
const { data: productsData } = await useAsyncData<{ data: ProductRow[] }>(
  'reservar-products',
  () => apiFetch('/products'),
)
const suggestedProducts = computed(() =>
  (productsData.value?.data ?? []).filter(p => p.stock_actual > 0).slice(0, 4),
)

// Descuento de membresía/lealtad del cliente (0 si es invitado); el cálculo del
// precio con descuento vive en el ViewModel.
const membershipDiscountPct = computed(() => user.value?.client?.descuento_activo_pct ?? 0)

// ── ViewModel del asistente (T085) ───────────────────────────────────────
// La selección, los pasos, los precios y los horarios viven en
// useBookingWizard (app/composables/useBookingWizard.ts) para poder probarlos
// sin montar esta página. Aquí se le pasan los catálogos ya cargados y la API
// real; las pruebas le pasan datos de ejemplo y una API falsa.
//
// La query SOLO se lee al entrar (enlace/QR con ?servicio=, y el regreso del
// login) y se vuelve a escribir UNA vez, al saltar al login (ver currentUrl()).
// Deliberadamente NO se espeja en la URL en cada selección: app.vue monta la
// página con :key="route.fullPath", así que cada cambio de query remonta el
// componente completo, vuelve a pedir los catálogos y reproduce la transición
// de página -- un remonte por cada toque del visitante.
function queryParam(key: string) {
  const value = route.query[key]
  return typeof value === 'string' ? value : ''
}
const {
  serviceId, barberId, date, time, activeStep,
  selectedService, selectedBarber, step, pickService, pickBarber, goToStep,
  selectedProductIds, selectedProducts, toggleProduct,
  discountedServicePrice, TIP_PRESETS, tipPreset, customTip, usingCustomTip, tipAmount, pickTipPreset,
  grandTotal, payAmountToCharge,
  days, slots, slotsPending, slotsFailed, loadSlots, groupedSlots,
} = useBookingWizard({
  services,
  barbers,
  suggestedProducts,
  discountPct: membershipDiscountPct,
  initial: {
    serviceId: queryParam('servicio'),
    barberId: props.initialBarber || queryParam('barbero'),
    date: queryParam('fecha'),
    time: queryParam('hora'),
  },
  fetchSlots: query => apiFetch<{ slots: Slot[] }>('/availability/slots', { query }),
})

// ── Pagar ahora vs pagar despues (Fase 7) ────────────────────────────────
// "Pagar ahora" reutiliza el mecanismo de deposito anti-no-show tal cual
// (mismo backend, mismo webhook de Stripe) pero por el monto completo -- ver
// AppointmentController::store() en barber. Default 'despues' para no
// forzar el cambio de comportamiento a nadie que solo quiera reservar.
type PayChoice = 'despues' | 'ahora_tarjeta' | 'ahora_transferencia'
const payChoice = ref<PayChoice>('despues')

let stripe: Stripe | null = null
let elements: StripeElements | null = null
let cardElement: StripeCardElement | null = null
const cardElementRef = ref<HTMLDivElement | null>(null)
const stripeConfigured = Boolean(runtimeConfig.public.stripeKey)
// Mismos tres valores de siempre (el backend no cambia); solo se presentan como tarjetas.
const payOptions = computed<ChoiceOption<PayChoice>[]>(() => [
  { value: 'despues', title: 'Pagar en el salón', detail: 'Efectivo, tarjeta o transferencia el día de tu cita', icon: 'salon' },
  ...(stripeConfigured
    ? [{ value: 'ahora_tarjeta' as const, title: 'Pagar ahora con tarjeta', detail: 'Se cobra al instante de forma segura', icon: 'tarjeta' as const }]
    : []),
  { value: 'ahora_transferencia', title: 'Pagar ahora por transferencia', detail: 'Sube tu comprobante para confirmar', icon: 'transferencia' },
])
const cardError = ref('')
// `stripe` es una variable normal (no reactiva) a proposito, para no meter
// el objeto Stripe en un Proxy de Vue; este ref es lo que el template observa.
const stripeReady = ref(false)

async function ensureStripeMounted() {
  if (!stripeConfigured || cardElement) return
  stripe = await loadStripe(runtimeConfig.public.stripeKey as string)
  if (!stripe) return
  elements = stripe.elements()
  // El iframe de Stripe es de otro origen: no puede heredar el color del tema
  // ("inherit" lo dejaba oscuro sobre fondo oscuro), asi que se le pasa el
  // color ya calculado del contenedor.
  const textColor = cardElementRef.value ? getComputedStyle(cardElementRef.value).color : '#ffffff'
  cardElement = elements.create('card', {
    style: { base: { fontFamily: 'Figtree, sans-serif', fontSize: '15px', color: textColor, '::placeholder': { color: '#8a8a8a' } }, invalid: { color: '#f87171' } },
  })
  if (cardElementRef.value) cardElement.mount(cardElementRef.value)
  cardElement.on('change', ({ error: elError }) => { cardError.value = elError?.message ?? '' })
  stripeReady.value = true
}
function teardownStripe() {
  cardElement?.unmount()
  cardElement = null
  elements = null
  cardError.value = ''
  stripeReady.value = false
}
watch(payChoice, async (choice) => {
  if (choice === 'ahora_tarjeta') await nextTick().then(ensureStripeMounted)
  else teardownStripe()
})
onUnmounted(() => teardownStripe())

// Transferencia: el cliente sube su comprobante DESPUES de que la cita ya
// existe (mismo flujo que el deposito anti-no-show) -- se guarda el archivo
// aqui y se sube en confirm(), una vez se tiene el codigo de la cita.
const transferReceipt = ref<File | null>(null)
function onTransferFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  transferReceipt.value = input.files?.[0] ?? null
}

// ── Barbero favorito ─────────────────────────────────────────────────────
// Solo preferencia de UI (pre-destacarlo), nunca bloquea reservar con otro.
// Optimista: actualiza el heart al instante y revierte si el PUT falla, en
// vez de esperar el round-trip antes de reflejar el click.
const favoriteSaving = ref(false)
async function toggleFavorite(barber: BarberRow) {
  if (!isAuthenticated.value || favoriteSaving.value) return
  const next = !barber.es_favorito
  const previous = barbers.value.map(b => ({ id: b.id, es_favorito: b.es_favorito }))
  for (const b of barbers.value) b.es_favorito = b.id === barber.id ? next : false
  favoriteSaving.value = true
  try {
    await apiFetch('/profile/favorite-barber', {
      method: 'PUT',
      body: { barber_id: next ? barber.id : null },
    })
  }
  catch {
    for (const b of barbers.value) {
      const found = previous.find(p => p.id === b.id)
      if (found) b.es_favorito = found.es_favorito
    }
  }
  finally {
    favoriteSaving.value = false
  }
}

// ── Lista de espera (cuando el día elegido ya no tiene horarios) ──────────
// Mismo criterio de quién puede reservar (canBookHere, definido más abajo)
// -- solo cliente o invitado, nunca staff/barbero.
const joiningWaitlist = ref(false)
const waitlistJoined = ref(false)
const waitlistError = ref('')
watch([serviceId, barberId, date], () => {
  waitlistJoined.value = false
  waitlistError.value = ''
})

async function joinWaitlist() {
  if (joiningWaitlist.value || !barberId.value || !serviceId.value || !date.value) return

  if (!isAuthenticated.value) {
    await navigateTo(`/login?redirect=${encodeURIComponent(currentUrl())}`)

    return
  }

  joiningWaitlist.value = true
  waitlistError.value = ''
  try {
    await apiFetch('/waitlist', {
      method: 'POST',
      body: { barber_id: barberId.value, service_id: serviceId.value, fecha: date.value },
    })
    waitlistJoined.value = true
  }
  catch (err: unknown) {
    waitlistError.value = (err as { data?: { message?: string } })?.data?.message
      ?? 'No se pudo anotar en la lista de espera.'
  }
  finally {
    joiningWaitlist.value = false
  }
}

// ── Pasos ─────────────────────────────────────────────────────────────────
// Solo los nombres que se muestran; en qué paso va el cliente lo decide el ViewModel.
const STEPS = ['Servicio', 'Barbero', 'Horario', 'Confirmar'] as const

// ── Confirmación ──────────────────────────────────────────────────────────
// El backend solo deja reservar para sí mismo al rol cliente; admin y
// recepción necesitan client_id (lo hacen desde /appointments) y un barbero
// recibe 403. Se detecta antes de enviar para no mostrar un error críptico.
const canBookHere = computed(() => !isAuthenticated.value || hasRole('cliente'))

const saving = ref(false)
watch(saving, value => emit('busy', value))
const submitError = ref('')
const confirmedCode = ref('')
const productsWarning = ref('')
// El cliente acepta el cargo por inasistencia en el último paso (el backend guarda cuándo lo aceptó).
const acceptsNoShowFee = ref(false)

function currentUrl() {
  const q = new URLSearchParams({
    servicio: serviceId.value,
    barbero: barberId.value,
    fecha: date.value,
    hora: time.value,
  }).toString()

  return `/reservar?${q}`
}

const paymentWarning = ref('')
const paymentConfirming = ref(false)

async function confirm() {
  if (saving.value || slotsPending.value || !selectedService.value || !selectedBarber.value || !time.value) return
  submitError.value = ''
  if (!isAuthenticated.value) {
    // Única puerta de sesión del flujo, y solo al final: la selección viaja
    // en ?redirect para volver exactamente a este punto.
    await navigateTo(`/login?redirect=${encodeURIComponent(currentUrl())}`)

    return
  }
  if (!acceptsNoShowFee.value) {
    submitError.value = 'Para reservar acepta el cargo por inasistencia.'

    return
  }
  if (payChoice.value === 'ahora_tarjeta' && (!stripe || !cardElement)) {
    submitError.value = 'El formulario de tarjeta todavía no está listo. Espera un momento e intenta de nuevo.'

    return
  }
  if (payChoice.value === 'ahora_transferencia' && !transferReceipt.value) {
    submitError.value = 'Sube tu comprobante de transferencia para continuar.'

    return
  }

  saving.value = true
  try {
    const res = await apiFetch<{ data: { code: string }, productos_error?: string | null }>('/appointments', {
      method: 'POST',
      body: {
        barber_id: barberId.value,
        service_id: serviceId.value,
        fecha: date.value,
        hora_inicio: time.value,
        notas: notes.value || undefined,
        productos: selectedProducts.value.length
          ? selectedProducts.value.map(p => ({ product_id: p.id, cantidad: 1 }))
          : undefined,
        propina_sugerida: tipAmount.value > 0 ? tipAmount.value : undefined,
        pagar_ahora: payChoice.value !== 'despues' || undefined,
        acepta_cargo_inasistencia: acceptsNoShowFee.value || undefined,
      },
    })
    const code = res.data?.code ?? ''
    // La cita ya quedo creada aunque los productos fallen (ver backend): se
    // avisa aparte en vez de tratarlo como un error de la reserva completa.
    productsWarning.value = res.productos_error ?? ''

    // El cobro (si eligio pagar ahora) va DESPUES de crear la cita: reutiliza
    // los mismos endpoints del deposito anti-no-show. Si el cobro falla, la
    // cita ya quedo reservada -- se avisa aparte, nunca se revierte la cita.
    // IMPORTANTE: confirmedCode se asigna DESPUES de cobrar. Asignarlo antes
    // cambia la vista a "cita registrada", que desmonta el campo de tarjeta
    // de Stripe y el confirmCardPayment falla con "Element not mounted"
    // (detectado en una prueba real en AWS).
    if (code && payChoice.value !== 'despues') {
      await chargeBookingPayment(code)
    }

    confirmedCode.value = code
    if (code) emit('confirmed', code)
  }
  catch (err: unknown) {
    // El 422 del backend trae el motivo real ("El barbero ya tiene una cita
    // en ese horario.") y es la autoridad sobre conflictos: se muestra tal
    // cual y se refrescan los horarios para que el usuario reelija.
    submitError.value = (err as { data?: { message?: string } })?.data?.message
      ?? 'No se pudo confirmar la cita. Intenta con otro horario.'
    await loadSlots()
    time.value = ''
    activeStep.value = null
  }
  finally {
    saving.value = false
  }
}

async function chargeBookingPayment(code: string) {
  paymentConfirming.value = true
  paymentWarning.value = ''
  try {
    if (payChoice.value === 'ahora_tarjeta') {
      if (!stripe || !cardElement) throw new Error('Stripe no está listo.')
      const intentRes = await apiFetch<{ data: { client_secret: string } }>(
        `/appointments/${code}/deposit/stripe-intent`,
        { method: 'POST' },
      )
      const result = await stripe.confirmCardPayment(intentRes.data.client_secret, {
        payment_method: { card: cardElement },
      })
      if (result.error) throw new Error(result.error.message ?? 'Error al procesar el pago.')
    }
    else if (payChoice.value === 'ahora_transferencia' && transferReceipt.value) {
      const form = new FormData()
      form.append('comprobante', transferReceipt.value)
      await apiFetch(`/appointments/${code}/deposit/receipt`, { method: 'POST', body: form })
    }
  }
  catch (err: unknown) {
    // La cita ya esta reservada -- un fallo aqui NUNCA la cancela, solo se
    // avisa para que el cliente pague despues (tarjeta de nuevo o en el salon).
    paymentWarning.value = (err as { message?: string, data?: { message?: string } })?.data?.message
      ?? (err as Error)?.message
      ?? 'No se pudo procesar el pago. Podrás pagar en el salón.'
  }
  finally {
    paymentConfirming.value = false
  }
}

function currency(n: number) {
  return `$${Math.round(n).toLocaleString('es-MX')}`
}
function prettyDate(iso: string) {
  // Sin guarda, un iso vacío produce "Invalid Date" visible en pantalla.
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return ''

  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl" :class="embedded ? 'p-1' : 'px-4 py-8 sm:px-6 sm:py-12'">
    <!-- Confirmación -->
    <section v-if="confirmedCode" class="ui-card p-6 text-center sm:p-10">
      <BrandMascot mascot="bladebot" state="success" size="md" class="mx-auto" />
      <h1 class="mt-4 text-2xl font-black uppercase tracking-tight text-ink">
        Solicitud de cita registrada
      </h1>
      <p class="mt-2 text-sm text-muted">
        Tu código de cita es
        <strong class="font-black tracking-widest text-gold">{{ confirmedCode }}</strong>
      </p>
      <dl class="mx-auto mt-6 max-w-sm space-y-2 text-left text-sm">
        <div class="flex justify-between gap-4 border-b border-line pb-2">
          <dt class="text-muted">Servicio</dt>
          <dd class="text-right font-bold text-ink">{{ selectedService?.nombre }}</dd>
        </div>
        <div class="flex justify-between gap-4 border-b border-line pb-2">
          <dt class="text-muted">Barbero</dt>
          <dd class="text-right font-bold text-ink">{{ selectedBarber?.user?.name }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">Cuándo</dt>
          <dd class="text-right font-bold text-ink">{{ prettyDate(date) }} · {{ time }}</dd>
        </div>
      </dl>
      <p v-if="productsWarning" role="alert" class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
        Tu cita quedó confirmada, pero no pudimos agregar los productos: {{ productsWarning }}
      </p>
      <p v-if="paymentWarning" role="alert" class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
        Tu cita quedó confirmada, pero no pudimos procesar el pago: {{ paymentWarning }} Podrás pagar en el salón.
      </p>
      <p v-else-if="payChoice === 'ahora_tarjeta'" class="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
        Pago con tarjeta procesado correctamente.
      </p>
      <p v-else-if="payChoice === 'ahora_transferencia'" class="mt-4 rounded-xl border border-gold/30 bg-gold/10 p-3 text-xs text-gold">
        Recibimos tu comprobante de transferencia. Te avisaremos cuando se verifique.
      </p>
      <p v-if="shop?.politica_cancelacion" class="mt-6 text-xs leading-5 text-muted">
        Puedes cancelar o reprogramar hasta {{ shop.politica_cancelacion }} horas antes de tu cita.
      </p>
      <div class="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <NuxtLink to="/my/appointments" class="ui-btn px-8 py-3">Ver mis citas</NuxtLink>
        <NuxtLink to="/" class="ui-btn-secondary px-8 py-3">Volver al inicio</NuxtLink>
      </div>
    </section>

    <template v-else>
      <header class="mb-8">
        <p class="text-[10px] font-black uppercase tracking-[0.2em] text-gold">
          {{ shop?.nombre || 'UrbanBlade' }}
        </p>
        <h1 class="mt-2 text-3xl font-black uppercase tracking-tight text-ink">
          Reserva tu cita
        </h1>
        <p v-if="shop?.direccion || shop?.horario_apertura" class="mt-2 text-sm text-muted">
          <span v-if="shop?.direccion">{{ shop.direccion }}</span>
          <span v-if="shop?.direccion && shop?.horario_apertura" aria-hidden="true"> · </span>
          <span v-if="shop?.horario_apertura && shop?.horario_cierre">
            {{ shop.horario_apertura }} a {{ shop.horario_cierre }}
          </span>
        </p>
      </header>

      <!-- El error del backend vive FUERA de los pasos a propósito: cuando el
           422 es por horario ocupado se limpia la hora y el asistente vuelve
           al paso 3, así que un mensaje dentro del paso 4 se desmontaba junto
           con él y el visitante volvía al selector sin saber por qué. -->
      <p
        v-if="submitError"
        role="alert"
        class="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm font-bold text-red-300"
      >
        {{ submitError }}
      </p>

      <!-- Progreso -->
      <ol class="mb-6 grid grid-cols-2 gap-2 text-[10px] font-black tracking-wide sm:grid-cols-4">
        <li v-for="(label, i) in STEPS" :key="label" class="flex flex-1 items-center gap-1 sm:gap-2">
          <button
            type="button"
            class="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border px-2 py-2 transition-colors sm:px-3"
            :class="i === step
              ? 'border-gold/40 bg-gold/10 text-gold'
              : i < step ? 'border-line text-ink hover:border-gold/30' : 'border-line text-muted'"
            :disabled="saving || (i > 0 && !selectedService) || (i > 1 && !selectedBarber) || (i > 2 && (!date || !time))"
            :aria-current="i === step ? 'step' : undefined"
            @click="goToStep(i)"
          >
            <span class="grid h-5 w-5 place-items-center rounded-full border border-current text-[9px]">{{ i + 1 }}</span>
            <span>{{ label }}</span>
          </button>
        </li>
      </ol>

      <div v-if="selectedService" class="ui-card mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs text-muted">
        <strong class="text-ink">{{ selectedService.nombre }}</strong>
        <span>{{ selectedService.duracion_min }} min · {{ currency(selectedService.precio) }}</span>
        <span v-if="selectedBarber">{{ selectedBarber.user?.name }}</span>
        <span v-if="date">{{ prettyDate(date) }} {{ time }}</span>
      </div>

      <!-- Paso 1: servicio -->
      <section v-if="step === 0" aria-labelledby="paso-servicio">
        <h2 id="paso-servicio" class="mb-4 text-sm font-black uppercase tracking-widest text-ink">
          1. Elige tu servicio
        </h2>
        <BrandStatePanel v-if="servicesPending" mascot="bladebot" state="waiting" title="Cargando servicios…" />
        <BrandStatePanel
          v-else-if="servicesError" mascot="bruno" state="error" tone="danger"
          title="No se pudo cargar el catálogo" description="Revisa tu conexión e inténtalo nuevamente."
        />
        <BrandStatePanel
          v-else-if="!services.length" mascot="nava" state="empty"
          title="Aún no hay servicios publicados" description="Vuelve pronto o comunícate con la barbería."
        />
        <div v-else class="grid gap-3 sm:grid-cols-2">
          <button
            v-for="service in services" :key="service.id" type="button"
            class="ui-card flex min-h-11 items-center gap-4 p-4 text-left transition-colors hover:border-gold/40"
            @click="pickService(service.id)"
          >
            <img
              v-if="service.imagen" :src="service.imagen" :alt="service.nombre"
              class="h-14 w-14 shrink-0 rounded-lg border border-line object-cover"
            >
            <span v-else class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-line bg-gold/10 text-gold" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="h-6 w-6">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 6a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm0 12a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm2-10 10 8m0-8L8 16" />
              </svg>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-black text-ink">{{ service.nombre }}</span>
              <span class="mt-0.5 block text-xs text-muted">{{ service.duracion_min }} min</span>
            </span>
            <span class="shrink-0 text-sm font-black text-gold">{{ currency(service.precio) }}</span>
          </button>
        </div>
      </section>

      <!-- Paso 2: barbero -->
      <section v-if="step === 1" aria-labelledby="paso-barbero">
        <h2 id="paso-barbero" class="mb-4 text-sm font-black uppercase tracking-widest text-ink">
          2. Elige tu barbero
        </h2>
        <BrandStatePanel v-if="barbersPending" mascot="bladebot" state="waiting" title="Cargando barberos…" />
        <BrandStatePanel
          v-else-if="barbersError" mascot="bruno" state="error" tone="danger"
          title="No se pudo cargar el equipo" description="Revisa tu conexión e inténtalo nuevamente."
        />
        <BrandStatePanel
          v-else-if="!barbers.length" mascot="nava" state="empty"
          title="Aún no hay barberos activos" description="Vuelve pronto o comunícate con la barbería."
        />
        <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="barber in barbers" :key="barber.id"
            class="ui-card relative flex flex-col gap-3 p-4 transition-colors hover:border-gold/40"
            :class="barber.es_favorito && 'border-gold/50'"
          >
            <button
              v-if="isAuthenticated" type="button"
              class="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full transition-colors"
              :class="barber.es_favorito ? 'text-gold' : 'text-muted hover:text-gold'"
              :aria-pressed="barber.es_favorito"
              :aria-label="barber.es_favorito ? `Quitar a ${barber.user?.name} de favoritos` : `Marcar a ${barber.user?.name} como favorito`"
              :disabled="favoriteSaving"
              @click.stop="toggleFavorite(barber)"
            >
              <svg viewBox="0 0 24 24" :fill="barber.es_favorito ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.5" class="h-5 w-5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 20.5s-7.5-4.6-10-9.3C.5 8 2 4.5 5.5 4c2-.3 3.8.7 4.9 2.2l1.6 2 1.6-2C14.7 4.7 16.5 3.7 18.5 4c3.5.5 5 4 3.5 7.2-2.5 4.7-10 9.3-10 9.3Z" />
              </svg>
            </button>
            <button type="button" class="flex min-h-11 items-center gap-3 pr-8 text-left" @click="pickBarber(barber.id)">
              <img
                v-if="barber.foto" :src="barber.foto" :alt="`Foto de ${barber.user?.name}`"
                class="h-12 w-12 shrink-0 rounded-full object-cover" loading="lazy" decoding="async"
              >
              <span v-else class="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gold/15 text-xs font-black text-gold" aria-hidden="true">
                {{ (barber.user?.name ?? '?').slice(0, 1) }}
              </span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-black text-ink">{{ barber.user?.name }}</span>
                <span class="mt-0.5 block truncate text-xs text-muted">{{ barber.especialidades || 'Barbero' }}</span>
              </span>
            </button>

            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span v-if="barber.avg_rating" class="flex items-center gap-1 font-bold text-gold">
                <svg viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
                  <path d="M10 1.5l2.6 5.27 5.82.85-4.21 4.1 1 5.8L10 14.9l-5.21 2.74 1-5.8-4.21-4.1 5.82-.85L10 1.5Z" />
                </svg>
                {{ barber.avg_rating }} <span class="font-normal text-muted">({{ barber.total_reviews }})</span>
              </span>
              <span v-else class="text-muted">Sin reseñas todavía</span>
              <span v-if="barber.citas_conmigo" class="rounded-full bg-gold/10 px-2 py-0.5 font-bold text-gold">
                Ya te cortaste {{ barber.citas_conmigo }}x con él
              </span>
            </div>

            <NuxtLink
              v-if="barber.slug" :to="`/equipo/${barber.slug}`" target="_blank"
              class="text-xs font-bold text-muted underline decoration-dotted hover:text-gold"
            >
              Ver perfil y portafolio →
            </NuxtLink>
          </div>
        </div>
      </section>

      <!-- Paso 3: horario -->
      <section v-if="step === 2" aria-labelledby="paso-horario">
        <h2 id="paso-horario" class="mb-4 text-sm font-black uppercase tracking-widest text-ink">
          3. Elige día y hora
        </h2>

        <div class="mb-5 grid grid-cols-4 gap-2 sm:grid-cols-7" role="group" aria-label="Elegir día">
          <button
            v-for="d in days" :key="d.iso" type="button"
            class="flex min-h-11 min-w-0 flex-col items-center justify-center rounded-xl border py-3 transition-colors"
            :class="date === d.iso ? 'border-gold bg-gold/10 text-gold' : 'border-line text-muted hover:border-gold/30'"
            :aria-pressed="date === d.iso"
            @click="date = d.iso; time = ''; activeStep = null"
          >
            <span class="text-[9px] font-black uppercase tracking-widest">{{ d.isToday ? 'Hoy' : d.weekday }}</span>
            <span class="text-lg font-black leading-none text-ink" :class="date === d.iso && 'text-gold'">{{ d.day }}</span>
            <span class="text-[9px] uppercase">{{ d.month }}</span>
          </button>
        </div>

        <BrandStatePanel
          v-if="!date" mascot="nava" state="empty"
          title="Elige un día" description="Te mostramos los horarios libres de ese día."
        />
        <BrandStatePanel v-else-if="slotsPending" mascot="bladebot" state="waiting" title="Buscando horarios libres…" />
        <BrandStatePanel
          v-else-if="slotsFailed" mascot="bruno" state="error" tone="danger"
          title="No se pudieron cargar los horarios" description="Revisa tu conexión e inténtalo nuevamente."
        />
        <template v-else-if="!slots.length">
          <BrandStatePanel
            mascot="nava" state="empty"
            title="Sin horarios libres ese día"
            description="Prueba con otra fecha o con otro barbero del equipo."
          />
          <div v-if="canBookHere" class="ui-card mt-4 p-4 text-center">
            <template v-if="waitlistJoined">
              <p class="text-sm font-bold text-emerald-400">
                Te anotamos en la lista de espera. Te avisaremos si se libera un horario ese día.
              </p>
            </template>
            <template v-else>
              <p class="text-sm text-muted">
                ¿Prefieres esperar a que se libere un horario en vez de cambiar de día?
              </p>
              <button
                type="button" class="ui-btn-secondary mt-3 px-6 py-2.5 text-xs"
                :disabled="joiningWaitlist" @click="joinWaitlist"
              >
                {{ joiningWaitlist ? 'Anotando…' : 'Anotarme en lista de espera' }}
              </button>
              <p v-if="waitlistError" role="alert" class="mt-2 text-xs text-red-400">{{ waitlistError }}</p>
            </template>
          </div>
        </template>
        <template v-else>
          <p class="mb-4 text-xs font-bold text-muted">
            {{ slots.length }} horario{{ slots.length === 1 ? '' : 's' }} disponible{{ slots.length === 1 ? '' : 's' }} para
            {{ prettyDate(date) }}
          </p>
          <div v-for="group in groupedSlots" :key="group.key" class="mb-5 last:mb-0">
            <h3 class="mb-2 text-[10px] font-black uppercase tracking-widest text-muted">
              {{ group.label }} <span class="text-ink/40">· {{ group.slots.length }}</span>
            </h3>
            <div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
              <button
                v-for="slot in group.slots" :key="slot.time" type="button"
                class="min-h-11 rounded-xl border px-2 py-2 text-sm font-bold transition-colors"
                :class="time === slot.time ? 'border-gold bg-gold/10 text-gold' : 'border-line text-ink hover:border-gold/30'"
                :aria-pressed="time === slot.time"
                @click="time = slot.time; activeStep = null"
              >
                {{ slot.time }}
              </button>
            </div>
          </div>
        </template>
      </section>

      <!-- Paso 4: confirmar -->
      <section v-if="step === 3" aria-labelledby="paso-confirmar">
        <h2 id="paso-confirmar" class="mb-4 text-sm font-black uppercase tracking-widest text-ink">
          4. Confirma tu cita
        </h2>
        <div class="ui-card p-5">
          <dl class="space-y-3 text-sm">
            <div class="flex items-start justify-between gap-4">
              <dt class="text-muted">Servicio</dt>
              <dd class="text-right font-bold text-ink">
                {{ selectedService?.nombre }}
                <span class="block text-xs font-normal text-muted">{{ selectedService?.duracion_min }} min</span>
              </dd>
            </div>
            <div class="flex items-start justify-between gap-4">
              <dt class="text-muted">Barbero</dt>
              <dd class="text-right font-bold text-ink">{{ selectedBarber?.user?.name }}</dd>
            </div>
            <div class="flex items-start justify-between gap-4">
              <dt class="text-muted">Cuándo</dt>
              <dd class="text-right font-bold text-ink">{{ prettyDate(date) }} · {{ time }}</dd>
            </div>
            <div v-if="membershipDiscountPct > 0" class="flex items-start justify-between gap-4 text-xs">
              <dt class="text-emerald-400">Descuento de membresía ({{ membershipDiscountPct }}%)</dt>
              <dd class="text-right text-emerald-400">-{{ currency((selectedService?.precio ?? 0) - discountedServicePrice) }}</dd>
            </div>
            <div v-for="p in selectedProducts" :key="p.id" class="flex items-start justify-between gap-4 text-xs">
              <dt class="text-muted">+ {{ p.nombre }}</dt>
              <dd class="text-right text-ink">{{ currency(p.precio_venta) }}</dd>
            </div>
            <div v-if="tipAmount > 0" class="flex items-start justify-between gap-4 text-xs">
              <dt class="text-muted">+ Propina</dt>
              <dd class="text-right text-ink">{{ currency(tipAmount) }}</dd>
            </div>
            <div class="flex items-start justify-between gap-4 border-t border-line pt-3">
              <dt class="font-black uppercase tracking-widest text-ink">Total</dt>
              <dd class="text-right text-lg font-black text-gold">{{ currency(grandTotal) }}</dd>
            </div>
          </dl>

          <div v-if="suggestedProducts.length" class="mt-5 border-t border-line pt-5">
            <p class="mb-3 text-xs font-bold text-ink">¿Se te antoja algo para llevar a tu cita?</p>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                v-for="p in suggestedProducts" :key="p.id" type="button"
                class="rounded-xl border p-2 text-left transition-colors"
                :class="selectedProductIds.has(p.id) ? 'border-gold bg-gold/10' : 'border-line hover:border-gold/30'"
                :aria-pressed="selectedProductIds.has(p.id)"
                @click="toggleProduct(p.id)"
              >
                <img
                  v-if="p.imagen" :src="p.imagen" :alt="p.nombre"
                  class="mb-2 h-16 w-full rounded-lg object-cover"
                >
                <span v-else class="mb-2 flex h-16 w-full items-center justify-center rounded-lg bg-gold/10 text-[10px] text-muted">
                  Sin foto
                </span>
                <span class="block truncate text-xs font-bold text-ink">{{ p.nombre }}</span>
                <span class="mt-0.5 flex items-center justify-between text-xs">
                  <span class="font-bold text-gold">{{ currency(p.precio_venta) }}</span>
                  <span v-if="selectedProductIds.has(p.id)" class="font-black text-gold">✓ Agregado</span>
                </span>
              </button>
            </div>
          </div>

          <div v-if="selectedService" class="mt-5 border-t border-line pt-5">
            <p class="mb-3 text-xs font-bold text-ink">¿Quieres dejar propina para {{ selectedBarber?.user?.name || 'tu barbero' }}?</p>
            <div class="grid grid-cols-4 gap-2">
              <button
                v-for="pct in TIP_PRESETS" :key="pct" type="button"
                class="min-h-11 rounded-xl border text-sm font-bold transition-colors"
                :class="!usingCustomTip && tipPreset === pct ? 'border-gold bg-gold/10 text-gold' : 'border-line text-ink hover:border-gold/30'"
                :aria-pressed="!usingCustomTip && tipPreset === pct"
                @click="pickTipPreset(pct)"
              >
                {{ pct === 0 ? 'Sin propina' : `${pct * 100}%` }}
              </button>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <span class="text-xs text-muted">Otro monto:</span>
              <input
                v-model="customTip" type="number" min="0" step="10" placeholder="$"
                class="ui-input w-24 py-1.5 text-sm"
                @focus="customTip = customTip || String(tipAmount || '')"
              >
            </div>
          </div>

          <div v-if="canBookHere" class="mt-5 border-t border-line pt-5">
            <UiChoiceCards v-model="payChoice" label="¿Cuándo prefieres pagar?" :options="payOptions" />


            <p v-if="payChoice !== 'despues'" class="mt-3 text-xs text-muted">
              Pagarás {{ currency(payAmountToCharge) }} ahora (servicio con tu descuento + propina). Los productos que
              agregaste se pagan aparte, en el salón.
            </p>

            <div v-if="payChoice === 'ahora_tarjeta'" class="mt-3">
              <!-- Sin flex: en un contenedor flex el iframe de Stripe se colapsaba a 1px de ancho -->
              <div ref="cardElementRef" class="ui-input block w-full px-3 py-3" />
              <p v-if="cardError" role="alert" class="mt-2 text-xs text-red-400">{{ cardError }}</p>
              <p v-if="!stripeReady" class="mt-2 text-xs text-muted">Cargando formulario de tarjeta…</p>
            </div>

            <div v-if="payChoice === 'ahora_transferencia'" class="mt-3">
              <label for="transfer-receipt" class="mb-1 block text-xs font-bold text-ink">
                Sube tu comprobante de transferencia
              </label>
              <input
                id="transfer-receipt" type="file" accept=".jpg,.jpeg,.png,.pdf"
                class="ui-input w-full text-xs" @change="onTransferFileChange"
              >
              <p class="mt-2 text-xs text-muted">Tu cita queda reservada mientras revisamos el comprobante.</p>
            </div>
          </div>

          <div class="mt-5">
            <label for="booking-notes" class="mb-1 block text-xs font-bold text-ink">Notas para tu cita (opcional)</label>
            <textarea id="booking-notes" v-model="notes" class="ui-input w-full" rows="2" maxlength="1000" />
          </div>

          <p v-if="shop?.politica_cancelacion" class="mt-4 border-t border-line pt-4 text-xs leading-5 text-muted">
            Puedes cancelar o reprogramar sin costo hasta
            {{ shop.politica_cancelacion }} horas antes de tu cita.
          </p>

          <!-- Staff y barberos no pueden reservar para sí mismos en el backend -->
          <div v-if="!canBookHere" class="mt-5 rounded-xl border border-dashed border-line p-4 text-center">
            <p class="text-sm text-muted">
              Tu cuenta es de personal de la barbería. Las citas a nombre de un cliente se agendan desde la agenda del panel.
            </p>
            <NuxtLink to="/appointments" class="ui-btn mt-3 inline-flex px-6 py-2.5">Ir a la agenda</NuxtLink>
          </div>

          <template v-else>
            <label class="mt-5 flex items-start gap-3 rounded-xl border border-line p-3 text-xs leading-5 text-muted">
              <input v-model="acceptsNoShowFee" type="checkbox" class="mt-1 h-4 w-4 shrink-0 accent-[var(--color-gold,#d4af37)]">
              <span>
                Acepto el <strong class="text-ink">cargo por inasistencia</strong>: si no llego a mi cita sin cancelar a tiempo,
                se cobra un porcentaje del servicio a mi tarjeta guardada o queda como adeudo que debo pagar en la
                barbería para volver a reservar.
              </span>
            </label>
            <button
              type="button" class="ui-btn mt-3 w-full py-4 text-[12px] tracking-[0.15em]"
              :disabled="saving || paymentConfirming || slotsPending || slotsFailed || !time || !selectedService || !selectedBarber || !acceptsNoShowFee"
              @click="confirm"
            >
              {{ paymentConfirming ? 'Procesando pago…' : saving ? 'Confirmando…' : isAuthenticated ? 'Confirmar cita' : 'Continuar y confirmar' }}
            </button>
            <p v-if="!isAuthenticated" class="mt-3 text-center text-xs text-muted">
              Te pediremos iniciar sesión o crear tu cuenta solo para guardar esta cita. No perderás lo que elegiste.
            </p>
          </template>
        </div>
      </section>
    </template>
  </div>
</template>
