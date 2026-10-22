import { describe, expect, it } from 'vitest'
import { computeLoyaltyCharge } from '~/utils/loyaltyCharge'

describe('computeLoyaltyCharge', () => {
  it('aplica el descuento de nivel y limita los puntos al 50 %', () => {
    const r = computeLoyaltyCharge({ monto: 200, nivelPct: 10, puntosDisponibles: 500, puntosCanjear: 500, propina: 20, usarPremioRifa: false })
    expect(r.montoConNivel).toBe(180)
    expect(r.descuentoPuntos).toBe(90)
    expect(r.total).toBe(110)
  })

  it('con premio de rifa solo se cobra la propina', () => {
    const r = computeLoyaltyCharge({ monto: 300, nivelPct: 15, puntosDisponibles: 100, puntosCanjear: 50, propina: 40, usarPremioRifa: true })
    expect(r.total).toBe(40)
    expect(r.descuentoPuntos).toBe(0)
  })
})
