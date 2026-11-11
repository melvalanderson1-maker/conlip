import { Injectable, computed, effect, signal } from '@angular/core';
import { CatalogoPub, PlanPub } from '../features/publico/publico.service';

export type ModoPlan = 'ver' | 'cotizar';
export interface ItemPlan { plan_id: number; modo: ModoPlan; }
export interface LineaCarrito { clave: string; tipo: 'plan' | 'servicio' | 'extra'; id: number; texto: string; monto: number | null; }

const KEY = 'coti_carrito';

@Injectable({ providedIn: 'root' })
export class CarritoService {
  readonly tipo = signal<'persona' | 'empresa'>('persona');
  readonly periodo = signal<'mensual' | 'anual'>('mensual');
  readonly planes = signal<ItemPlan[]>([]);
  readonly servicios = signal<number[]>([]);
  readonly extras = signal<number>(0);
  readonly cantidad = computed<number>(() => this.planes().length + this.servicios().length + (this.extras() > 0 ? 1 : 0));

  constructor() {
    this.cargar();
    effect(() => {
      const datos = {
        tipo: this.tipo(), periodo: this.periodo(), planes: this.planes(),
        servicios: this.servicios(), extras: this.extras(),
      };
      try { sessionStorage.setItem(KEY, JSON.stringify(datos)); } catch { /* sin almacenamiento */ }
    });
  }

  private cargar(): void {
    try {
      const s = sessionStorage.getItem(KEY);
      if (!s) return;
      const d = JSON.parse(s) as Record<string, unknown>;
      if (d['tipo'] === 'empresa' || d['tipo'] === 'persona') this.tipo.set(d['tipo']);
      if (d['periodo'] === 'anual' || d['periodo'] === 'mensual') this.periodo.set(d['periodo']);
      if (Array.isArray(d['planes'])) this.planes.set(d['planes'] as ItemPlan[]);
      if (Array.isArray(d['servicios'])) this.servicios.set(d['servicios'] as number[]);
      if (typeof d['extras'] === 'number') this.extras.set(d['extras']);
    } catch { /* carrito corrupto: se ignora */ }
  }

  enCarrito(planId: number, modo: ModoPlan): boolean {
    return this.planes().some((p) => p.plan_id === planId && p.modo === modo);
  }

  alternarPlan(planId: number, modo: ModoPlan): void {
    if (this.enCarrito(planId, modo)) {
      this.planes.update((l) => l.filter((p) => p.plan_id !== planId));
    } else {
      this.planes.update((l) => [...l.filter((p) => p.plan_id !== planId), { plan_id: planId, modo }]);
    }
  }

  quitarPlan(planId: number): void { this.planes.update((l) => l.filter((p) => p.plan_id !== planId)); }

  alternarServicio(id: number): void {
    this.servicios.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  }

  quitarServicio(id: number): void { this.servicios.update((l) => l.filter((x) => x !== id)); }

  vaciar(): void { this.planes.set([]); this.servicios.set([]); this.extras.set(0); }

  /** Estimación para mostrar en pantalla. El monto real lo calcula siempre el servidor. */
  resumen(cat: CatalogoPub, activos: PlanPub[] = []): { lineas: LineaCarrito[]; total: number; ok: boolean } {
    const tipo = this.tipo();
    const periodo = this.periodo();
    const precio = (p: PlanPub, concepto: string): number | null =>
      p.precios.find((x) => x.tipo_cuenta === tipo && x.concepto === concepto && x.periodo === periodo)?.monto ?? null;

    const lineas: LineaCarrito[] = [];
    const elegidos: PlanPub[] = [];
    for (const it of this.planes()) {
      const p = cat.planes.find((x) => x.id === it.plan_id);
      if (!p) continue;
      elegidos.push(p);
      lineas.push({
        clave: `p${p.id}`, tipo: 'plan', id: p.id, monto: precio(p, it.modo),
        texto: `${p.nombre} · ${it.modo === 'cotizar' ? 'Visualizar y cotizar' : 'Solo visualizar'}`,
      });
    }
    for (const id of this.servicios()) {
      const s = cat.servicios.find((x) => x.id === id);
      if (!s) continue;
      lineas.push({ clave: `s${s.id}`, tipo: 'servicio', id: s.id, texto: `${s.categoria} · ${s.nombre}`, monto: s.precio });
    }
    if (tipo === 'empresa' && this.extras() > 0) {
      const unit = Math.max(0, ...[...elegidos, ...activos].map((p) => precio(p, 'usuario_extra') ?? 0));
      lineas.push({
        clave: 'x', tipo: 'extra', id: 0, texto: `Usuarios adicionales (${this.extras()})`,
        monto: unit > 0 ? unit * this.extras() : null,
      });
    }
    return {
      lineas,
      total: lineas.reduce((a, l) => a + (l.monto ?? 0), 0),
      ok: lineas.length > 0 && lineas.every((l) => l.monto !== null),
    };
  }
}