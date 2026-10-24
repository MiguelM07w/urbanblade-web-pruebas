/**
 * Datos del asistente de reserva, tal como los regresa la API de barber
 * (GET /services, /barbers, /products y /availability/slots). Los usan
 * Wizard.vue (la vista) y useBookingWizard (el ViewModel, T085).
 */
export interface ServiceRow {
  id: string
  nombre: string
  categoria: string | null
  precio: number
  duracion_min: number
  descripcion: string | null
  imagen: string | null
}

export interface BarberRow {
  id: string
  slug: string | null
  user: { id: string, name: string } | null
  especialidades: string | null
  foto: string | null
  avg_rating: number | null
  total_reviews: number
  citas_conmigo: number | null
  es_favorito: boolean
}

export interface ProductRow {
  id: string
  nombre: string
  categoria: string | null
  descripcion: string | null
  precio_venta: number
  stock_actual: number
  imagen: string | null
}

/** Un horario libre: time en formato 24 h ("16:30") y label para mostrarlo. */
export interface Slot {
  time: string
  label: string
}
