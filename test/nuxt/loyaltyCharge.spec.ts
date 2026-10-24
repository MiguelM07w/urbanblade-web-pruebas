/**
 * Prueba unitaria de lógica pura (T084).
 *
 * computeLoyaltyCharge() calcula cuánto paga un cliente: primero aplica el
 * descuento de su nivel de lealtad, después resta los puntos que quiera canjear
 * (1 punto = $1, como máximo la mitad del monto) y al final suma la propina.
 * No dibuja nada en pantalla, así que basta con llamarla y revisar lo que regresa.
 */
import { describe, expect, it } from 'vitest'
// "~" es un alias de Nuxt que apunta a la carpeta app/ del proyecto.
import { computeLoyaltyCharge } from '~/utils/loyaltyCharge'

// describe() agrupa todas las pruebas de una misma función o componente.
describe('computeLoyaltyCharge', () => {
  // it() es un caso de prueba; su nombre se escribe como la frase de lo que se espera.
  it('aplica el descuento de nivel y limita los puntos al 50 %', () => {
    // Preparar y ejecutar: servicio de $200, nivel con 10 % de descuento,
    // el cliente quiere canjear 500 puntos y deja $20 de propina.
    const r = computeLoyaltyCharge({ monto: 200, nivelPct: 10, puntosDisponibles: 500, puntosCanjear: 500, propina: 20, usarPremioRifa: false })

    // Verificar: $200 menos el 10 % = $180.
    expect(r.montoConNivel).toBe(180)
    // Pidió 500 puntos, pero solo puede canjear la mitad de $180: 90 puntos.
    expect(r.descuentoPuntos).toBe(90)
    // Total = $180 - $90 + $20 de propina = $110.
    expect(r.total).toBe(110)
  })

  it('con premio de rifa solo se cobra la propina', () => {
    // Si el cliente ganó la rifa, el servicio es gratis: no se aplican descuentos
    // ni puntos, solo se cobra la propina que deje.
    const r = computeLoyaltyCharge({ monto: 300, nivelPct: 15, puntosDisponibles: 100, puntosCanjear: 50, propina: 40, usarPremioRifa: true })

    expect(r.total).toBe(40)
    expect(r.descuentoPuntos).toBe(0)
  })
})
