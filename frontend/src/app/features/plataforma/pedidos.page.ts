import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { HttpErrorResponse } from '@angular/common/http';
import { IconComponent } from '../../shared/icon.component';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { EstadoPedido, OrdenFila, PedidoFila, PedidosService, Pendientes } from './pedidos.service';

type Pestana = 'compras' | 'solicitudes';

const ESTADOS: { id: EstadoPedido; label: string }[] = [
  { id: 'nuevo', label: 'Nuevo' }, { id: 'en_curso', label: 'En curso' },
  { id: 'entregado', label: 'Entregado' }, { id: 'cancelado', label: 'Cancelado' },
];
const ESTADO_ORDEN: Record<string, string> = {
  pagada: 'Pagada', error_aprovision: 'Pagada sin activar', pendiente: 'Sin pagar', cancelada: 'Cancelada',
};

@Component({
  selector: 'app-pedidos',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Operación</span>
          <h1>Pedidos</h1>
          <p class="sub">Compras realizadas en el sitio y solicitudes de servicios. Cada compra aparece aquí al instante.</p>
        </div>
      </header>

      @if (error()) { <p class="banner bad"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }
      @if (pend().ordenes_error > 0) {
        <p class="banner bad">
          <app-icon name="alert" [size]="18" />
          Hay {{ pend().ordenes_error }} {{ pend().ordenes_error === 1 ? 'pago recibido que no se activó' : 'pagos recibidos que no se activaron' }}.
          Revisa los datos del comprador y actívalo en Plataforma → Clientes → Agregar / renovar.
        </p>
      }

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'compras'" (click)="irA('compras')">
          <app-icon name="receipt" [size]="16" /> Compras
          @if (pend().ordenes_error > 0) { <span class="num bad">{{ pend().ordenes_error }}</span> }
        </button>
        <button type="button" [class.on]="pestana() === 'solicitudes'" (click)="irA('solicitudes')">
          <app-icon name="inbox" [size]="16" /> Solicitudes de servicio
          @if (pend().pedidos_nuevos > 0) { <span class="num">{{ pend().pedidos_nuevos }}</span> }
        </button>
      </div>

      <!-- ================= COMPRAS ================= -->
      @if (pestana() === 'compras') {
        <div class="chips">
          <button type="button" class="chip" [class.on]="filtroOrden() === ''" (click)="setFiltroOrden('')">Pagadas</button>
          <button type="button" class="chip" [class.on]="filtroOrden() === 'error_aprovision'" (click)="setFiltroOrden('error_aprovision')">Sin activar</button>
          <button type="button" class="chip" [class.on]="filtroOrden() === 'pendiente'" (click)="setFiltroOrden('pendiente')">Sin pagar</button>
        </div>

        <div class="tabla-wrap">
          <table class="tabla">
            <thead>
              <tr><th>Fecha</th><th>Cliente</th><th>Detalle</th><th>Total</th><th>Estado</th><th>Pago</th></tr>
            </thead>
            <tbody>
              @for (o of ordenes(); track o.id) {
                <tr>
                  <td class="nw">{{ fechaHora(o.pagado_en ?? o.creado_en) }}</td>
                  <td>
                    <b>{{ o.comprador.nombre }}</b>
                    <small>{{ o.comprador.doc_tipo }} {{ o.comprador.doc_numero }} · {{ o.tipo_cuenta === 'empresa' ? 'Empresa' : 'Persona' }}</small>
                    <small class="ct"><app-icon name="mail" [size]="12" /> {{ o.comprador.correo }}</small>
                    @if (o.comprador.telefono) { <small class="ct"><app-icon name="phone" [size]="12" /> {{ o.comprador.telefono }}</small> }
                  </td>
                  <td>
                    <ul>
                      @for (i of o.items; track $index) { <li>{{ i.descripcion }}@if (i.cantidad > 1) { × {{ i.cantidad }} }</li> }
                    </ul>
                    <small>{{ o.periodo === 'anual' ? 'Periodo anual' : 'Periodo mensual' }}</small>
                  </td>
                  <td class="nw"><b>{{ soles(o.total) }}</b></td>
                  <td>
                    <span class="estado" [class.ok]="o.estado === 'pagada'" [class.bad]="o.estado === 'error_aprovision'">
                      {{ estadoOrden(o.estado) }}
                    </span>
                  </td>
                  <td class="nw">
                    <small>{{ o.proveedor ?? '—' }}</small>
                    <small>{{ o.ref_externa ?? '' }}</small>
                    <small class="id">#{{ o.id.slice(0, 8).toUpperCase() }}</small>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="vacio">{{ cargando() ? 'Cargando…' : 'No hay compras en esta vista.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ================= SOLICITUDES ================= -->
      @if (pestana() === 'solicitudes') {
        <div class="chips">
          <button type="button" class="chip" [class.on]="filtroPedido() === ''" (click)="setFiltroPedido('')">Todas</button>
          @for (e of estados; track e.id) {
            <button type="button" class="chip" [class.on]="filtroPedido() === e.id" (click)="setFiltroPedido(e.id)">{{ e.label }}</button>
          }
        </div>

        <div class="cards">
          @for (p of pedidos(); track p.id) {
            <article class="card" [class.nuevo]="p.estado === 'nuevo'">
              <div class="c-top">
                <div>
                  <h3>{{ p.servicio_nombre }}</h3>
                  <small>{{ fechaHora(p.creado_en) }}</small>
                </div>
                <span class="chip">{{ p.origen === 'compra' ? 'Compra' : 'Cotización' }}</span>
              </div>
              <div class="datos">
                <span><app-icon name="user" [size]="14" /> {{ p.nombre }}@if (p.empresa) { · {{ p.empresa }} }</span>
                <span><app-icon name="mail" [size]="14" /> {{ p.correo }}</span>
                @if (p.telefono) { <span><app-icon name="phone" [size]="14" /> {{ p.telefono }}</span> }
              </div>
              @if (p.mensaje) { <p class="msg">{{ p.mensaje }}</p> }
              <label class="est">Estado
                <select (change)="cambiar(p, $any($event.target).value)">
                  @for (e of estados; track e.id) {
                    <option [value]="e.id" [selected]="p.estado === e.id">{{ e.label }}</option>
                  }
                </select>
              </label>
            </article>
          } @empty {
            <p class="vacio-b">{{ cargando() ? 'Cargando…' : 'No hay solicitudes en esta vista.' }}</p>
          }
        </div>
      }
    </div>
  `,
  styles: [ESTILOS_ADMIN],
})
export class PedidosPage implements OnInit {
  private readonly api: PedidosService = inject(PedidosService);
  readonly estados = ESTADOS;
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly pestana = signal<Pestana>('compras');
  readonly pend = signal<Pendientes>({ pedidos_nuevos: 0, ordenes_error: 0 });
  readonly ordenes = signal<OrdenFila[]>([]);
  readonly pedidos = signal<PedidoFila[]>([]);
  readonly filtroOrden = signal<string>('');
  readonly filtroPedido = signal<string>('');
  readonly cargando = signal<boolean>(false);
  readonly error = signal<string>('');

  ngOnInit(): void {
    this.cargarTodo();
    // Tiempo real: cada compra o solicitud aparece aquí al instante
    this.rt.cambios('pedido').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarTodo());
  }

  irA(p: Pestana): void { this.pestana.set(p); }
  setFiltroOrden(f: string): void { this.filtroOrden.set(f); this.cargarOrdenes(); }
  setFiltroPedido(f: string): void { this.filtroPedido.set(f); this.cargarPedidos(); }

  private cargarTodo(): void {
    this.cargarPendientes();
    this.cargarOrdenes();
    this.cargarPedidos();
  }

  private cargarPendientes(): void {
    this.api.pendientes().subscribe({ next: (p) => this.pend.set(p), error: () => undefined });
  }

  private cargarOrdenes(): void {
    this.cargando.set(true);
    this.api.ordenes(this.filtroOrden()).subscribe({
      next: (l) => { this.ordenes.set(l); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.cargando.set(false); this.error.set(this.msg(e)); },
    });
  }

  private cargarPedidos(): void {
    this.cargando.set(true);
    this.api.pedidos(this.filtroPedido()).subscribe({
      next: (l) => { this.pedidos.set(l); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.cargando.set(false); this.error.set(this.msg(e)); },
    });
  }

  cambiar(p: PedidoFila, estado: EstadoPedido): void {
    this.api.cambiarPedido(p.id, estado).subscribe({
      next: () => {
        this.pedidos.update((l) => l.map((x) => (x.id === p.id ? { ...x, estado } : x)));
        this.cargarPendientes();
      },
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
  }

  estadoOrden(e: string): string { return ESTADO_ORDEN[e] ?? e; }
  soles(n: number): string { return 'S/ ' + n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : 'No se pudo conectar con el servidor';
  }
}