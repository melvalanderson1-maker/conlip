import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';

type Estado = 'pendiente' | 'pagada' | 'error_aprovision' | 'cancelada';
type Filtro = Estado | 'todas';
type Pestana = 'pedidos' | 'ajustes';

interface Orden {
  id: string; codigo: string; estado: Estado; total: number; moneda: string; tipo_cuenta: string; periodo: string;
  comprador: { nombre: string; doc_tipo: string; doc_numero: string; correo: string; telefono: string };
  proveedor: string | null; metodo_pago: string; ref_externa: string | null; nota_pago: string; confirmado_por: string;
  contactado_en: string | null; creado_en: string; pagado_en: string | null; empresa_id: number | null;
  items: { descripcion: string; cantidad: number; monto_unit: number }[]; whatsapp_cliente: string;
}
interface Ajustes {
  clave_ok: boolean; modo: 'whatsapp' | 'pasarela'; pasarela: 'culqi' | 'demo'; demo_permitido: boolean;
  whatsapp: { numero: string; mensaje: string; flotante: boolean; enlace_prueba: string };
  culqi: { publica: string; secreta_guardada: boolean; origen: '' | 'panel' | 'entorno'; entorno: '' | 'prueba' | 'produccion' };
  funciones: { crm: boolean; facturacion: boolean };
}

const FILTROS: { id: Filtro; label: string }[] = [
  { id: 'pendiente', label: 'Pendientes de pago' }, { id: 'pagada', label: 'Pagados' },
  { id: 'error_aprovision', label: 'Con error de activación' }, { id: 'cancelada', label: 'Cancelados' }, { id: 'todas', label: 'Todos' },
];
const ESTADO_TXT: Record<string, string> = {
  pendiente: 'Pendiente de pago', pagada: 'Pagado y activado', error_aprovision: 'Pagado, falló la activación', cancelada: 'Cancelado',
};
const METODOS = [
  { id: 'yape', label: 'Yape' }, { id: 'plin', label: 'Plin' }, { id: 'transferencia', label: 'Transferencia bancaria' },
  { id: 'deposito', label: 'Depósito en agencia' }, { id: 'efectivo', label: 'Efectivo' }, { id: 'otro', label: 'Otro' },
];

@Injectable({ providedIn: 'root' })
export class VentasAdminService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly base = `${API}/ventas/admin`;
  ordenes(estado: string): Observable<Orden[]> { return this.http.get<Orden[]>(`${this.base}/ordenes${estado ? `?estado=${estado}` : ''}`); }
  confirmar(id: string, d: Record<string, unknown>): Observable<unknown> { return this.http.post(`${this.base}/ordenes/${id}/confirmar`, d); }
  reintentar(id: string): Observable<unknown> { return this.http.post(`${this.base}/ordenes/${id}/reintentar`, {}); }
  cancelar(id: string): Observable<unknown> { return this.http.post(`${this.base}/ordenes/${id}/cancelar`, {}); }
  ajustes(): Observable<Ajustes> { return this.http.get<Ajustes>(`${this.base}/ajustes`); }
  guardar(d: Record<string, unknown>): Observable<unknown> { return this.http.put(`${this.base}/ajustes`, d); }
  probar(): Observable<{ ok: boolean; detalle: string }> { return this.http.post<{ ok: boolean; detalle: string }>(`${this.base}/pasarela/probar`, {}); }
}

@Component({
  selector: 'app-ventas-admin',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Comercial</span>
          <h2>Ventas</h2>
          <p class="sub">Pedidos de tus clientes, confirmación de pagos y cómo se vende: por WhatsApp o con pasarela de pagos.</p>
        </div>
      </header>

      @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'pedidos'" (click)="irA('pedidos')">
          <app-icon name="receipt" [size]="16" /> Pedidos
          @if (pendientes() > 0) { <span class="cnt">{{ pendientes() }}</span> }
        </button>
        <button type="button" [class.on]="pestana() === 'ajustes'" (click)="irA('ajustes')"><app-icon name="layers" [size]="16" /> Ajustes</button>
      </div>

      <!-- ================= PEDIDOS ================= -->
      @if (pestana() === 'pedidos') {
        <div class="chips">
          @for (f of filtros; track f.id) {
            <button type="button" class="chip" [class.on]="filtro() === f.id" (click)="cambiarFiltro(f.id)">{{ f.label }}</button>
          }
        </div>
        <div class="tabla-wrap">
          <table class="tabla">
            <thead><tr><th>Pedido</th><th>Cliente</th><th>Detalle</th><th>Total</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              @for (o of ordenes(); track o.id) {
                <tr>
                  <td><b>{{ o.codigo }}</b><small>{{ hace(o.creado_en) }}@if (o.contactado_en) { · escribió por WhatsApp }</small></td>
                  <td>
                    <b>{{ o.comprador.nombre }}</b>
                    <small>{{ o.comprador.doc_tipo }} {{ o.comprador.doc_numero }}</small>
                    <small>{{ o.comprador.correo }}@if (o.comprador.telefono) { · {{ o.comprador.telefono }} }</small>
                  </td>
                  <td>
                    @for (i of o.items; track $index) { <small class="it">{{ i.descripcion }}@if (i.cantidad > 1) { ×{{ i.cantidad }} }</small> }
                    <small>{{ o.tipo_cuenta === 'empresa' ? 'Empresa' : 'Persona natural' }} · {{ o.periodo }}</small>
                  </td>
                  <td><b>{{ soles(o.total) }}</b></td>
                  <td>
                    <span class="estado" [class.ok]="o.estado === 'pagada'" [class.bad]="o.estado === 'error_aprovision' || o.estado === 'cancelada'">{{ estadoTxt(o.estado) }}</span>
                    @if (o.estado === 'pagada' && o.metodo_pago) { <small>{{ metodoTxt(o.metodo_pago) }}@if (o.ref_externa) { · {{ o.ref_externa }} }</small> }
                  </td>
                  <td class="btns">
                    @if (o.whatsapp_cliente) {
                      <a class="btn" [href]="o.whatsapp_cliente" target="_blank" rel="noopener"><app-icon name="phone" [size]="15" /> WhatsApp</a>
                    }
                    @if (o.estado === 'pendiente') {
                      <button type="button" class="btn primary" (click)="abrirConfirmar(o)"><app-icon name="circle-check" [size]="15" /> Confirmar pago</button>
                      <button type="button" class="btn peligro" (click)="cancelar(o)">Cancelar</button>
                    }
                    @if (o.estado === 'error_aprovision') {
                      <button type="button" class="btn primary" (click)="reintentar(o)">Reintentar activación</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="vacio">No hay pedidos en esta vista.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ================= AJUSTES ================= -->
      @if (pestana() === 'ajustes' && aj(); as a) {
        <section class="card">
          <h3>Modo de venta</h3>
          <p class="nota">Define qué ve el cliente al terminar su pedido. Puedes cambiarlo cuando quieras; los pedidos ya hechos no se pierden.</p>
          <div class="modos">
            <button type="button" class="modo" [class.on]="modo() === 'whatsapp'" (click)="modo.set('whatsapp'); marcar()">
              <b>Por WhatsApp</b><small>El cliente envía su pedido por WhatsApp, un asesor cobra y tú confirmas el pago aquí. Recomendado para empezar.</small>
            </button>
            <button type="button" class="modo" [class.on]="modo() === 'pasarela'" (click)="modo.set('pasarela'); marcar()">
              <b>Pasarela de pagos</b><small>El cliente paga con tarjeta en línea y la cuenta se activa sola.</small>
            </button>
          </div>
        </section>

        <section class="card">
          <h3>WhatsApp de ventas</h3>
          <div class="grid2">
            <label>Número de WhatsApp (con código de país)
              <input placeholder="+51 999 888 777" [value]="wNumero()" (input)="wNumero.set($any($event.target).value); marcar()" />
            </label>
            <label class="chk"><input type="checkbox" [checked]="wFlotante()" (change)="wFlotante.set($any($event.target).checked); marcar()" /> Mostrar el botón flotante de WhatsApp en la portada</label>
          </div>
          <label>Mensaje de consulta (lo que se escribe al pulsar el botón flotante)
            <input maxlength="300" placeholder="Hola, quiero información sobre los planes" [value]="wMensaje()" (input)="wMensaje.set($any($event.target).value); marcar()" />
          </label>
          <p class="nota">Este número es el mismo de Catálogo → textos del sitio. Los pedidos llevan su propio mensaje con el código y el total.</p>
          @if (a.whatsapp.enlace_prueba) { <a class="btn" [href]="a.whatsapp.enlace_prueba" target="_blank" rel="noopener">Probar mi enlace de WhatsApp</a> }
        </section>

        <section class="card">
          <h3>Pasarela de pagos</h3>
          <p class="nota">Se usa cuando el modo de venta es «Pasarela de pagos». Las llaves se guardan cifradas y nunca vuelven al navegador.</p>
          @if (!a.clave_ok) {
            <p class="error"><app-icon name="alert" [size]="18" /> Falta SECRETS_KEY en el servidor: no se pueden guardar llaves hasta configurarla.</p>
          }
          <div class="grid2">
            <label>Proveedor
              <select (change)="pasarela.set($any($event.target).value); marcar()">
                <option value="culqi" [selected]="pasarela() === 'culqi'">Culqi (tarjetas reales)</option>
                @if (a.demo_permitido) { <option value="demo" [selected]="pasarela() === 'demo'">Pago de prueba (solo para probar)</option> }
              </select>
            </label>
            <div class="estado-llaves">
              <span class="estado" [class.ok]="a.culqi.secreta_guardada">{{ a.culqi.secreta_guardada ? 'Llaves guardadas' : 'Sin llaves' }}</span>
              @if (a.culqi.entorno) { <span class="estado" [class.azul]="a.culqi.entorno === 'prueba'" [class.ok]="a.culqi.entorno === 'produccion'">{{ a.culqi.entorno === 'prueba' ? 'Modo prueba' : 'Modo producción' }}</span> }
              @if (a.culqi.origen === 'entorno') { <small>(vienen del archivo .env; si las guardas aquí tienen prioridad)</small> }
            </div>
            <label>Llave pública
              <input autocomplete="off" [placeholder]="a.culqi.publica || 'pk_test_… o pk_live_…'" [value]="cPublica()" (input)="cPublica.set($any($event.target).value); marcar()" />
            </label>
            <label>Llave secreta
              <input type="password" autocomplete="new-password" [placeholder]="a.culqi.secreta_guardada ? 'Guardada. Escribe solo para cambiarla' : 'sk_test_… o sk_live_…'" [value]="cSecreta()" (input)="cSecreta.set($any($event.target).value); marcar()" />
            </label>
          </div>
          <div class="fila acciones"><button type="button" class="btn" [disabled]="!a.culqi.secreta_guardada || sucio()" (click)="probar()">Probar llaves</button></div>
          <details class="pasos">
            <summary>Cómo activar la pasarela cuando gerencia lo decida</summary>
            <ol>
              <li>En tu CulqiPanel, modo <b>Integración</b>, copia las llaves de prueba y pégalas arriba. Guarda y pulsa <b>Probar llaves</b>.</li>
              <li>Cambia el modo de venta a <b>Pasarela de pagos</b> y guarda. Haz una compra con las tarjetas de prueba de Culqi.</li>
              <li>Cuando Culqi apruebe tu comercio, reemplaza por las llaves de <b>producción</b> (pk_live y sk_live), prueba y guarda.</li>
            </ol>
          </details>
        </section>

        <section class="card">
          <h3>Funciones</h3>
          <label class="chk"><input type="checkbox" [checked]="fCrm()" (change)="fCrm.set($any($event.target).checked); marcar()" /> CRM: clientes potenciales y seguimiento comercial por asesor</label>
          <p class="nota">Al activarlo aparece el botón CRM para ti y la pestaña CRM en el panel de cada asesor. Los leads se guardan siempre, aunque esté apagado.</p>
          <label class="chk off"><input type="checkbox" disabled /> Facturación electrónica <small>(aún no disponible: se activará cuando gerencia defina el proveedor)</small></label>
        </section>

        <div class="fila">
          <button type="button" class="btn primary" [disabled]="guardando()" (click)="guardar()">{{ guardando() ? 'Guardando…' : 'Guardar ajustes' }}</button>
          @if (sucio()) { <small class="nota">Tienes cambios sin guardar.</small> }
        </div>
      }
    </div>

    <!-- ================= CONFIRMAR PAGO ================= -->
    @if (conf(); as o) {
      <div class="overlay" (click)="conf.set(null)">
        <div class="modal" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>Confirmar pago del pedido {{ o.codigo }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="conf.set(null)"><app-icon name="x" [size]="18" /></button>
          </header>
          <p class="nota"><b>{{ o.comprador.nombre }}</b> · {{ soles(o.total) }}. Al confirmar se crea o amplía su cuenta y se le envía el correo para crear su clave. Confírmalo solo cuando el dinero ya llegó.</p>
          <div class="grid2">
            <label>Cómo pagó
              <select (change)="metodo.set($any($event.target).value)">
                @for (m of metodos; track m.id) { <option [value]="m.id" [selected]="metodo() === m.id">{{ m.label }}</option> }
              </select>
            </label>
            <label>N.º de operación (opcional)
              <input maxlength="80" [value]="referencia()" (input)="referencia.set($any($event.target).value)" />
            </label>
          </div>
          <label>Nota interna (opcional)
            <input maxlength="300" [value]="nota()" (input)="nota.set($any($event.target).value)" />
          </label>
          <div class="pie">
            <button type="button" class="btn" (click)="conf.set(null)">Cancelar</button>
            <button type="button" class="btn primary" [disabled]="guardando()" (click)="confirmar()">{{ guardando() ? 'Activando…' : 'Confirmar y activar' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .cnt { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: #f59e0b; color: #fff; font-size: .7rem; font-weight: 700; }
    .it { display: block; } .estado.azul { background: #dbeafe; color: #1d4ed8; }
    .modos { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .modo { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 16px; text-align: left; border: 2px solid var(--line); border-radius: 14px; background: #fff; font: inherit; cursor: pointer; }
    .modo small { color: var(--muted); line-height: 1.45; } .modo.on { border-color: var(--brand); background: var(--soft); }
    .chk { display: flex; flex-direction: row; align-items: center; gap: 10px; font-weight: 600; cursor: pointer; } .chk input { width: 18px; height: 18px; accent-color: var(--brand); } .chk.off { opacity: .55; cursor: not-allowed; }
    .estado-llaves { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; align-self: end; padding-bottom: 8px; }
    .pasos { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; } .pasos summary { cursor: pointer; font-weight: 600; color: var(--brand); }
    .pasos ol { margin: 10px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; color: #334155; font-size: .88rem; line-height: 1.5; }
  `],
})
export class VentasAdminPage implements OnInit {
  private readonly api: VentasAdminService = inject(VentasAdminService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly filtros = FILTROS;
  readonly metodos = METODOS;

  readonly pestana = signal<Pestana>('pedidos');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly guardando = signal<boolean>(false);

  // Pedidos
  readonly filtro = signal<Filtro>('pendiente');
  readonly ordenes = signal<Orden[]>([]);
  readonly pendientes = signal<number>(0);
  readonly conf = signal<Orden | null>(null);
  readonly metodo = signal<string>('yape');
  readonly referencia = signal<string>('');
  readonly nota = signal<string>('');

  // Ajustes
  readonly aj = signal<Ajustes | null>(null);
  readonly modo = signal<'whatsapp' | 'pasarela'>('whatsapp');
  readonly pasarela = signal<'culqi' | 'demo'>('culqi');
  readonly wNumero = signal<string>('');
  readonly wMensaje = signal<string>('');
  readonly wFlotante = signal<boolean>(true);
  readonly cPublica = signal<string>('');
  readonly cSecreta = signal<string>('');
  readonly fCrm = signal<boolean>(false);
  readonly sucio = signal<boolean>(false);  // hay cambios sin guardar: un aviso en vivo no los pisa

  readonly hayPedidos = computed<boolean>(() => this.ordenes().length > 0);

  ngOnInit(): void {
    this.cargarOrdenes();
    this.cargarAjustes();
    // Tiempo real: pedidos nuevos, pagos confirmados y cambios de cuentas aparecen sin recargar
    this.rt.cambios('pedido', 'acceso').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargarOrdenes());
  }

  // ---------------- Utilidades ----------------
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void {
    this.mensaje.set('');
    this.guardando.set(false);
    const d = e.error?.detail;
    this.error.set(typeof d === 'string' ? d : 'No se pudo conectar con el servidor');
  }
  irA(p: Pestana): void { this.pestana.set(p); this.mensaje.set(''); this.error.set(''); }
  estadoTxt(e: string): string { return ESTADO_TXT[e] ?? e; }
  metodoTxt(m: string): string { return METODOS.find((x) => x.id === m)?.label ?? m; }
  soles(n: number): string { return `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
  hace(iso: string): string {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
    return `hace ${Math.floor(min / 1440)} d`;
  }
  marcar(): void { this.sucio.set(true); }

  // ---------------- Pedidos ----------------
  cambiarFiltro(f: Filtro): void { this.filtro.set(f); this.cargarOrdenes(); }

  cargarOrdenes(): void {
    this.api.ordenes(this.filtro() === 'todas' ? '' : this.filtro()).subscribe({
      next: (l) => this.ordenes.set(l), error: (e: HttpErrorResponse) => this.fallo(e),
    });
    this.api.ordenes('pendiente').subscribe({ next: (l) => this.pendientes.set(l.length), error: () => undefined });
  }

  abrirConfirmar(o: Orden): void { this.metodo.set('yape'); this.referencia.set(''); this.nota.set(''); this.conf.set(o); }

  confirmar(): void {
    const o = this.conf();
    if (!o || this.guardando()) return;
    this.guardando.set(true);
    this.api.confirmar(o.id, { metodo: this.metodo(), referencia: this.referencia(), nota: this.nota() }).subscribe({
      next: () => { this.guardando.set(false); this.conf.set(null); this.ok(`Pago confirmado. El cliente recibirá el correo para crear su clave.`); this.cargarOrdenes(); },
      error: (e: HttpErrorResponse) => { this.fallo(e); this.cargarOrdenes(); },
    });
  }

  reintentar(o: Orden): void {
    this.api.reintentar(o.id).subscribe({
      next: () => { this.ok('Compra activada'); this.cargarOrdenes(); }, error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  cancelar(o: Orden): void {
    if (!confirm(`¿Cancelar el pedido ${o.codigo} de ${o.comprador.nombre}?`)) return;
    this.api.cancelar(o.id).subscribe({
      next: () => { this.ok('Pedido cancelado'); this.cargarOrdenes(); }, error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Ajustes ----------------
  cargarAjustes(): void {
    this.api.ajustes().subscribe({
      next: (a) => {
        this.aj.set(a);
        if (!this.sucio()) {
          this.modo.set(a.modo); this.pasarela.set(a.pasarela); this.wNumero.set(a.whatsapp.numero); this.wMensaje.set(a.whatsapp.mensaje);
          this.wFlotante.set(a.whatsapp.flotante); this.fCrm.set(a.funciones.crm); this.cPublica.set(''); this.cSecreta.set('');
        }
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  guardar(): void {
    this.guardando.set(true);
    this.api.guardar({
      modo: this.modo(), pasarela: this.pasarela(),
      whatsapp: { numero: this.wNumero(), mensaje: this.wMensaje(), flotante: this.wFlotante() },
      culqi: { publica: this.cPublica(), secreta: this.cSecreta() },
      funciones: { crm: this.fCrm() },
    }).subscribe({
      next: () => {
        this.guardando.set(false); this.sucio.set(false); this.ok('Ajustes guardados. La portada ya los usa.'); this.cargarAjustes();
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  probar(): void {
    this.api.probar().subscribe({ next: (r) => this.ok(r.detalle), error: (e: HttpErrorResponse) => this.fallo(e) });
  }
}