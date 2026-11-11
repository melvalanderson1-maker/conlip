import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API } from '../../core/api';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { MiCalendarioComponent, SesionAgenda } from '../cuenta/mi-calendario.component';
import { CrmPanelComponent } from '../crm/crm-panel.component';
import { CrmFlagService } from '../crm/crm.service';
import {
  Bloqueo, Entregable, EstadoEntregable, EstadoServicio, EstadoSesion, Horario, PedidoDetalle, PedidoSeg, SesionFila,
} from './agenda-admin.service';

export interface PerfilAsesor {
  id: number; nombre: string; correo: string; plataforma: string; modo_enlace: string; enlace: string; color: string;
  horarios: Horario[]; bloqueos: Bloqueo[];
}
export interface SesionAse {
  id: number; pedido_id: number; inicio: string; fin: string; estado: EstadoSesion; enlace: string; nota: string;
  cliente: string; correo: string; telefono: string; servicio_nombre: string;
}

@Injectable({ providedIn: 'root' })
export class AsesorService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly base = `${API}/asesor`;

  yo(): Observable<PerfilAsesor> { return this.http.get<PerfilAsesor>(`${this.base}/yo`); }
  guardarEnlace(enlace: string): Observable<unknown> { return this.http.patch(`${this.base}/perfil`, { enlace }); }
  fijarHorarios(horarios: Horario[]): Observable<unknown> { return this.http.put(`${this.base}/horarios`, { horarios }); }
  crearBloqueo(d: { desde: string; hasta: string; motivo: string }): Observable<unknown> { return this.http.post(`${this.base}/bloqueos`, d); }
  borrarBloqueo(id: number): Observable<unknown> { return this.http.delete(`${this.base}/bloqueos/${id}`); }
  sesiones(desde: string, hasta: string): Observable<SesionAse[]> {
    return this.http.get<SesionAse[]>(`${this.base}/sesiones`, { params: new HttpParams().set('desde', desde).set('hasta', hasta) });
  }
  marcarSesion(id: number, d: { estado?: 'realizada' | 'no_asistio'; nota?: string }): Observable<unknown> {
    return this.http.patch(`${this.base}/sesiones/${id}`, d);
  }
  pedidos(): Observable<PedidoSeg[]> { return this.http.get<PedidoSeg[]>(`${this.base}/pedidos`); }
  pedido(id: number): Observable<PedidoDetalle> { return this.http.get<PedidoDetalle>(`${this.base}/pedidos/${id}`); }
  editarEntregable(id: number, d: { estado?: EstadoEntregable; nota?: string }): Observable<unknown> {
    return this.http.patch(`${this.base}/entregables/${id}`, d);
  }
}

type Pestana = 'agenda' | 'clientes' | 'disponibilidad' | 'crm';

const ZONA = 'America/Lima';
const DIAS = [
  { i: 0, n: 'Lunes' }, { i: 1, n: 'Martes' }, { i: 2, n: 'Miércoles' }, { i: 3, n: 'Jueves' },
  { i: 4, n: 'Viernes' }, { i: 5, n: 'Sábado' }, { i: 6, n: 'Domingo' },
];
const ESTADO_SERVICIO: Record<string, string> = { nuevo: 'Sin iniciar', en_curso: 'En curso', entregado: 'Completado', cancelado: 'Cancelado' };
const ESTADO_SESION: Record<string, string> = { programada: 'Programada', realizada: 'Realizada', no_asistio: 'No asistió', cancelada: 'Cancelada' };

@Component({
  selector: 'app-mi-agenda',
  imports: [IconComponent, MiCalendarioComponent, CrmPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Asesor</span>
          <h2>Mi agenda</h2>
          <p class="sub">Tus sesiones, tus clientes y tu disponibilidad. Los cambios se reflejan al instante.</p>
        </div>
      </header>

      @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

      <div class="tabs">
        <button type="button" [class.on]="pestana() === 'agenda'" (click)="irA('agenda')">
          <app-icon name="calendar" [size]="16" /> Agenda
          @if (porConfirmar() > 0) { <span class="cnt">{{ porConfirmar() }}</span> }
        </button>
        <button type="button" [class.on]="pestana() === 'clientes'" (click)="irA('clientes')"><app-icon name="users" [size]="16" /> Mis clientes</button>
        <button type="button" [class.on]="pestana() === 'disponibilidad'" (click)="irA('disponibilidad')"><app-icon name="clock" [size]="16" /> Mi disponibilidad</button>
        @if (crm.activo()) {
          <button type="button" [class.on]="pestana() === 'crm'" (click)="irA('crm')"><app-icon name="users" [size]="16" /> CRM</button>
        }
      </div>

      <!-- ================= AGENDA ================= -->
      @if (pestana() === 'agenda') {
        <app-mi-calendario [sesiones]="calendario()" />
        <h3 class="t2">Por atender</h3>
        <ul class="lista">
          @for (s of porAtender(); track s.id) {
            <li class="it" [class.pend]="pasada(s)">
              <div class="it-t">
                <b>{{ fechaHora(s.inicio) }}</b><small>a {{ hora(s.fin) }}</small>
                @if (pasada(s)) { <span class="estado bad">Por confirmar</span> }
              </div>
              <span>{{ s.cliente }} · {{ s.servicio_nombre }}</span>
              <small>{{ s.correo }}@if (s.telefono) { · {{ s.telefono }} }</small>
              <div class="it-acc">
                @if (s.enlace) { <a class="btn" [href]="s.enlace" target="_blank" rel="noopener"><app-icon name="video" [size]="15" /> Abrir sala</a> }
                @if (empezo(s.inicio)) {
                  <button type="button" class="btn primary" (click)="marcar(s, 'realizada')"><app-icon name="circle-check" [size]="15" /> Realizada</button>
                  <button type="button" class="btn" (click)="marcar(s, 'no_asistio')">No asistió</button>
                }
                <button type="button" class="btn" (click)="abrir(s.pedido_id)">Ver cliente</button>
              </div>
            </li>
          } @empty { <li class="vacio">No tienes sesiones pendientes.</li> }
        </ul>
      }

      <!-- ================= CLIENTES ================= -->
      @if (pestana() === 'clientes') {
        <div class="tabla-wrap">
          <table class="tabla">
            <thead><tr><th>Cliente</th><th>Servicio</th><th>Avance</th><th>Sesiones</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              @for (p of pedidos(); track p.id) {
                <tr>
                  <td><b>{{ p.nombre }}</b><small>{{ p.empresa ?? p.correo }}</small></td>
                  <td>{{ p.servicio_nombre }}</td>
                  <td class="avance">
                    <div class="barra"><span [style.width.%]="p.progreso"></span></div>
                    <small>{{ p.hechos }}/{{ p.total_e }} entregables · {{ p.progreso }}%</small>
                  </td>
                  <td>
                    <b>{{ p.realizadas }}/{{ p.sesiones_incluidas }}</b> realizadas
                    @if (p.proxima) { <small>Próxima: {{ fechaHora(p.proxima) }}</small> }
                  </td>
                  <td><span class="estado" [class.ok]="p.estado === 'entregado'" [class.azul]="p.estado === 'en_curso'" [class.bad]="p.estado === 'cancelado'">{{ estadoServicio(p.estado) }}</span></td>
                  <td class="btns"><button type="button" class="btn primary" (click)="abrir(p.id)">Gestionar</button></td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="vacio">Aún no tienes clientes asignados.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ================= CRM ================= -->
      @if (pestana() === 'crm' && crm.activo()) {
        <app-crm-panel [esAdmin]="false" />
      }

      <!-- ================= DISPONIBILIDAD ================= -->
      @if (pestana() === 'disponibilidad' && perfil(); as p) {
        <section class="card">
          <h3>Enlace de mi sala</h3>
          <p class="nota">
            @if (p.modo_enlace === 'api') { Tus sesiones usan un enlace nuevo por cada cita; este es el respaldo si la creación automática falla. }
            @else { Este enlace de {{ p.plataforma === 'zoom' ? 'Zoom' : 'Meet' }} se envía a tus clientes con cada sesión. }
          </p>
          <div class="fila">
            <input class="grande" placeholder="https://meet.google.com/abc-defg-hij" [value]="enlace()" (input)="editarEnlace($any($event.target).value)" />
            <button type="button" class="btn primary" (click)="guardarEnlace()">Guardar enlace</button>
          </div>
        </section>

        <section class="card">
          <h3>Mi horario semanal</h3>
          <p class="nota">Los rangos en los que atiendes. Tus clientes solo ven horarios libres dentro de ellos.</p>
          @for (d of dias; track d.i) {
            <div class="dia">
              <b>{{ d.n }}</b>
              <div class="rangos">
                @for (h of horDe(d.i); track $index) {
                  <span class="rango">
                    <input type="time" [value]="h.inicio" (change)="setHor(h, 'inicio', $any($event.target).value)" />
                    <span>a</span>
                    <input type="time" [value]="h.fin" (change)="setHor(h, 'fin', $any($event.target).value)" />
                    <button type="button" class="x" aria-label="Quitar rango" (click)="quitarHor(h)"><app-icon name="x" [size]="14" /></button>
                  </span>
                } @empty { <small class="nota">No atiendo</small> }
                <button type="button" class="btn" (click)="agregarHor(d.i)"><app-icon name="plus" [size]="14" /> Rango</button>
              </div>
            </div>
          }
          <div class="fila"><button type="button" class="btn primary" (click)="guardarHorarios()">Guardar horario</button></div>
        </section>

        <section class="card">
          <h3>Bloqueos (permisos, vacaciones)</h3>
          <ul class="bloq">
            @for (b of p.bloqueos; track b.id) {
              <li>
                <span>{{ fechaHora(b.desde) }} → {{ fechaHora(b.hasta) }}@if (b.motivo) { · {{ b.motivo }} }</span>
                <button type="button" class="btn ico peligro" aria-label="Quitar bloqueo" (click)="quitarBloqueo(b)"><app-icon name="trash" [size]="14" /></button>
              </li>
            } @empty { <li class="nota">Sin bloqueos próximos.</li> }
          </ul>
          <div class="fila">
            <label>Desde <input type="datetime-local" [value]="blq().desde" (input)="setBlq({ desde: $any($event.target).value })" /></label>
            <label>Hasta <input type="datetime-local" [value]="blq().hasta" (input)="setBlq({ hasta: $any($event.target).value })" /></label>
            <label class="grande">Motivo <input [value]="blq().motivo" (input)="setBlq({ motivo: $any($event.target).value })" /></label>
            <button type="button" class="btn" (click)="agregarBloqueo()"><app-icon name="plus" [size]="15" /> Bloquear</button>
          </div>
        </section>
      }
    </div>

    <!-- ================= DETALLE DE UN CLIENTE ================= -->
    @if (det(); as d) {
      <div class="overlay lado" (click)="cerrarDet()">
        <aside class="panel" role="dialog" aria-modal="true" aria-label="Detalle del cliente" (click)="$event.stopPropagation()">
          <header class="p-cab">
            <div>
              <small>{{ d.servicio_nombre }}</small>
              <h3>{{ d.nombre }}</h3>
              <span class="estado" [class.ok]="d.estado === 'entregado'" [class.azul]="d.estado === 'en_curso'">{{ estadoServicio(d.estado) }}</span>
            </div>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrarDet()"><app-icon name="x" [size]="18" /></button>
          </header>
          <div class="p-cuerpo">
            <div class="contacto">
              <span><app-icon name="mail" [size]="14" /> {{ d.correo }}</span>
              @if (d.telefono) { <span><app-icon name="phone" [size]="14" /> {{ d.telefono }}</span> }
              @if (d.empresa) { <span><app-icon name="building" [size]="14" /> {{ d.empresa }}</span> }
            </div>
            <div>
              <div class="fila-sb"><b>Avance general</b><b>{{ d.progreso }}%</b></div>
              <div class="barra grande-b"><span [style.width.%]="d.progreso"></span></div>
            </div>

            <section>
              <h4>Entregables</h4>
              <ul class="ents">
                @for (e of d.entregables; track e.id) {
                  <li class="ent" [class.hecho]="e.estado === 'hecho'">
                    <b>{{ e.titulo }}</b>
                    <div class="seg3">
                      <button type="button" [class.on]="e.estado === 'pendiente'" (click)="setEnt(e, 'pendiente')">Pendiente</button>
                      <button type="button" class="m" [class.on]="e.estado === 'en_curso'" (click)="setEnt(e, 'en_curso')">En curso</button>
                      <button type="button" class="v" [class.on]="e.estado === 'hecho'" (click)="setEnt(e, 'hecho')"><app-icon name="check" [size]="13" /> Hecho</button>
                    </div>
                    <input class="nota-in" placeholder="Nota para el cliente (opcional)" [value]="e.nota" (change)="notaEnt(e, $any($event.target).value)" />
                  </li>
                } @empty { <li class="nota">Este servicio no tiene entregables definidos.</li> }
              </ul>
            </section>

            <section>
              <h4>Sesiones <small>({{ d.sesiones_incluidas }} incluidas)</small></h4>
              <ul class="ents">
                @for (s of d.sesiones; track s.id) {
                  <li class="ent" [class.cancel]="s.estado === 'cancelada'">
                    <div class="it-t">
                      <b>{{ fechaHora(s.inicio) }}</b><small>a {{ hora(s.fin) }}</small>
                      <span class="estado" [class.ok]="s.estado === 'realizada'" [class.azul]="s.estado === 'programada'" [class.bad]="s.estado === 'no_asistio'">{{ estadoSesion(s.estado) }}</span>
                    </div>
                    <small>Con {{ s.asesor }}</small>
                    @if (esMia(s) && s.estado === 'programada' && empezo(s.inicio)) {
                      <div class="it-acc">
                        <button type="button" class="btn primary" (click)="marcarDet(s, 'realizada')">Realizada</button>
                        <button type="button" class="btn" (click)="marcarDet(s, 'no_asistio')">No asistió</button>
                      </div>
                    }
                  </li>
                } @empty { <li class="nota">Todavía no hay sesiones agendadas.</li> }
              </ul>
            </section>
          </div>
        </aside>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .t2 { margin: 22px 0 10px; font-size: 1rem; }
    .cnt { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: #f59e0b; color: #fff; font-size: .7rem; font-weight: 700; }
    .lista, .ents, .bloq { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .it { display: flex; flex-direction: column; gap: 5px; padding: 14px 16px; background: #fff; border: 1px solid var(--line); border-radius: 14px; } .it.pend { background: #fff8eb; border-color: #fde1a8; }
    .it small { color: var(--muted); } .it-t { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .it-acc { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .estado.azul { background: #dbeafe; color: #1d4ed8; } .avance { min-width: 190px; }
    .barra { height: 7px; border-radius: 999px; background: #e8edf8; overflow: hidden; margin-bottom: 4px; } .barra.grande-b { height: 10px; margin-top: 6px; }
    .barra span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #1d4ed8, #2f6bff); transition: width .4s; }
    .overlay.lado { place-items: stretch end; padding: 0; }
    .panel { width: min(640px, 100%); height: 100vh; overflow-y: auto; display: flex; flex-direction: column; background: #fff; box-shadow: -30px 0 70px -30px rgb(10 26 58 / .55); }
    .p-cab { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 20px 24px; background: linear-gradient(180deg, #f8faff, #fff); border-bottom: 1px solid var(--line); }
    .p-cab small { color: var(--muted); } .p-cab h3 { margin: 2px 0 8px; font-size: 1.25rem; }
    .p-cuerpo { display: flex; flex-direction: column; gap: 20px; padding: 20px 24px 60px; }
    .contacto { display: flex; gap: 8px 18px; flex-wrap: wrap; font-size: .86rem; color: #334155; } .contacto span { display: inline-flex; align-items: center; gap: 6px; }
    .fila-sb { display: flex; justify-content: space-between; align-items: center; } h4 small { font-weight: 400; color: var(--muted); }
    .ent { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: #fff; } .ent.hecho { background: #f3fbf7; border-color: #bfe8d3; } .ent.cancel { opacity: .55; }
    .ent small { color: var(--muted); } .seg3 { display: inline-flex; width: fit-content; padding: 3px; background: #e8edf8; border-radius: 10px; }
    .seg3 button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border: 0; border-radius: 8px; background: none; font: inherit; font-size: .78rem; font-weight: 600; color: var(--muted); cursor: pointer; }
    .seg3 button.on { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgb(10 26 58 / .15); } .seg3 .m.on { color: #1d4ed8; } .seg3 .v.on { color: #047857; }
    .nota-in { height: 34px !important; font-size: .82rem !important; }
    .dia { display: flex; gap: 14px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid #f0f3fa; } .dia > b { width: 92px; flex: none; padding-top: 8px; font-size: .88rem; }
    .rangos { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .rango { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: #f8faff; border: 1px solid var(--line); border-radius: 10px; }
    .rango input { height: 34px; width: 112px; } .rango .x { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--muted); } .rango .x:hover { background: #fef2f2; color: #b91c1c; }
    .bloq li { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 12px; background: #fafbfe; border: 1px solid var(--line); border-radius: 10px; font-size: .86rem; }
    @media (max-width: 800px) { .dia { flex-direction: column; gap: 4px; } .dia > b { padding-top: 0; } }
  `],
})
export class MiAgendaPage implements OnInit {
  private readonly api: AsesorService = inject(AsesorService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly crm: CrmFlagService = inject(CrmFlagService);
  readonly dias = DIAS;

  readonly pestana = signal<Pestana>('agenda');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly ahora = signal<number>(Date.now());
  readonly perfil = signal<PerfilAsesor | null>(null);
  readonly sesiones = signal<SesionAse[]>([]);
  readonly pedidos = signal<PedidoSeg[]>([]);
  readonly det = signal<PedidoDetalle | null>(null);
  readonly hor = signal<Horario[]>([]);
  readonly enlace = signal<string>('');
  readonly blq = signal<{ desde: string; hasta: string; motivo: string }>({ desde: '', hasta: '', motivo: '' });

  readonly calendario = computed<SesionAgenda[]>(() => this.sesiones().map((s) => ({
    id: s.id, inicio: s.inicio, fin: s.fin, estado: s.estado, asesor: s.cliente, enlace: s.estado === 'programada' ? s.enlace : '',
    servicio: s.servicio_nombre,
  })));
  readonly porAtender = computed<SesionAse[]>(() => this.sesiones().filter((s) => s.estado === 'programada'));
  readonly porConfirmar = computed<number>(() => this.porAtender().filter((s) => this.pasada(s)).length);

  constructor() {
    const t = setInterval(() => this.ahora.set(Date.now()), 60_000);
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  ngOnInit(): void {
    this.cargar(true);
    // Tiempo real: cualquier cambio en tus sesiones o clientes se refleja sin recargar
    this.rt.cambios('agenda', 'horarios').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar(false));
  }

  private cargar(primera: boolean): void {
    this.api.yo().subscribe({
      next: (p) => {
        this.perfil.set(p);
        if (primera || !this.horSucio) this.hor.set(p.horarios.map((h) => ({ ...h })));
        if (primera || !this.enlaceSucio) this.enlace.set(p.enlace);
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
    const t = Date.now();
    this.api.sesiones(new Date(t - 60 * 86_400_000).toISOString(), new Date(t + 150 * 86_400_000).toISOString()).subscribe({
      next: (l) => this.sesiones.set(l), error: (e: HttpErrorResponse) => this.fallo(e),
    });
    this.api.pedidos().subscribe({ next: (l) => this.pedidos.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
    const d = this.det();
    if (d) this.recargarDet(d.id);
  }

  // ---------------- Utilidades ----------------
  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  irA(p: Pestana): void { this.pestana.set(p); this.mensaje.set(''); this.error.set(''); }
  estadoServicio(e: EstadoServicio | string): string { return ESTADO_SERVICIO[e] ?? e; }
  estadoSesion(e: EstadoSesion | string): string { return ESTADO_SESION[e] ?? e; }
  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-PE', { timeZone: ZONA, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  hora(iso: string): string { return new Date(iso).toLocaleTimeString('es-PE', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false }); }
  pasada(s: SesionAse): boolean { return new Date(s.fin).getTime() < this.ahora(); }
  empezo(inicio: string): boolean { return new Date(inicio).getTime() <= this.ahora(); }
  esMia(s: SesionFila): boolean { return s.asesor_id === this.perfil()?.id; }

  // ---------------- Sesiones ----------------
  marcar(s: SesionAse, estado: 'realizada' | 'no_asistio'): void {
    this.api.marcarSesion(s.id, { estado }).subscribe({
      next: () => { this.ok(`Sesión marcada como ${this.estadoSesion(estado).toLowerCase()}`); this.cargar(false); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Clientes ----------------
  abrir(id: number): void { this.recargarDet(id); }
  cerrarDet(): void { this.det.set(null); }
  private recargarDet(id: number): void {
    this.api.pedido(id).subscribe({ next: (d) => this.det.set(d), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  setEnt(e: Entregable, estado: EstadoEntregable): void {
    this.api.editarEntregable(e.id, { estado }).subscribe({ next: () => this.cargar(false), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  notaEnt(e: Entregable, nota: string): void {
    if (nota.trim() === e.nota) return;
    this.api.editarEntregable(e.id, { nota }).subscribe({ next: () => this.ok('Nota guardada'), error: (er: HttpErrorResponse) => this.fallo(er) });
  }

  marcarDet(s: SesionFila, estado: 'realizada' | 'no_asistio'): void {
    this.api.marcarSesion(s.id, { estado }).subscribe({
      next: () => { this.ok(`Sesión marcada como ${this.estadoSesion(estado).toLowerCase()}`); this.cargar(false); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  // ---------------- Disponibilidad ----------------
  guardarEnlace(): void {
    this.api.guardarEnlace(this.enlace().trim()).subscribe({
      next: () => { this.enlaceSucio = false; this.ok('Enlace guardado'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  horDe(dia: number): Horario[] { return this.hor().filter((h) => h.dia === dia); }
  private horSucio = false;
  private enlaceSucio = false;
  editarEnlace(v: string): void { this.enlaceSucio = true; this.enlace.set(v); }
  agregarHor(dia: number): void { this.horSucio = true; this.hor.update((l) => [...l, { dia, inicio: '09:00', fin: '13:00' }]); }
  quitarHor(h: Horario): void { this.horSucio = true; this.hor.update((l) => l.filter((x) => x !== h)); }
  setHor(h: Horario, campo: 'inicio' | 'fin', v: string): void {
    this.horSucio = true;
    this.hor.update((l) => l.map((x) => (x === h ? { ...x, [campo]: v } : x)));
  }

  guardarHorarios(): void {
    this.api.fijarHorarios(this.hor()).subscribe({
      next: () => { this.horSucio = false; this.ok('Horario guardado'); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  setBlq(c: Partial<{ desde: string; hasta: string; motivo: string }>): void { this.blq.update((b) => ({ ...b, ...c })); }

  agregarBloqueo(): void {
    const b = this.blq();
    if (!b.desde || !b.hasta) { this.mensaje.set(''); this.error.set('Indica desde y hasta cuándo'); return; }
    this.api.crearBloqueo({ desde: new Date(b.desde).toISOString(), hasta: new Date(b.hasta).toISOString(), motivo: b.motivo.trim() }).subscribe({
      next: () => { this.blq.set({ desde: '', hasta: '', motivo: '' }); this.ok('Bloqueo agregado'); this.cargar(false); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  quitarBloqueo(b: Bloqueo): void {
    this.api.borrarBloqueo(b.id).subscribe({ next: () => this.cargar(false), error: (e: HttpErrorResponse) => this.fallo(e) });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido.';
    return 'No se pudo conectar con el servidor';
  }
}