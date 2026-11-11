import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { IconComponent } from '../../shared/icon.component';
import { MiCalendarioComponent, SesionAgenda } from './mi-calendario.component';
import { MisServicios, MisServiciosService, ServicioCli, SesionCli, SlotCli } from './mis-servicios.service';

const ZONA = 'America/Lima';
interface Agenda { pid: number; sesionId: number | null; slots: SlotCli[]; cargando: boolean; dia: string | null; elegido: SlotCli | null; }

const ESTADO_SERVICIO: Record<string, string> = { nuevo: 'Recibido', en_curso: 'En curso', entregado: 'Completado', cancelado: 'Cancelado' };
const ESTADO_SESION: Record<string, string> = { programada: 'Programada', realizada: 'Realizada', no_asistio: 'No asististe', cancelada: 'Cancelada' };
const ESTADO_ENT: Record<string, string> = { pendiente: 'Pendiente', en_curso: 'En curso', hecho: 'Hecho' };
const PLATAFORMA: Record<string, string> = { meet: 'Google Meet', zoom: 'Zoom', otra: 'Videollamada' };

@Component({
  selector: 'app-mis-servicios',
  imports: [IconComponent, MiCalendarioComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!lista().length && datos() && mostrarVacio()) {
      <section class="vacio-s">
        <span class="vs-ico"><app-icon name="package" [size]="30" /></span>
        <h3>Aún no tienes servicios en este módulo</h3>
        <p>Cuando contrates un servicio personalizado verás aquí su avance, tus sesiones y tu calendario.</p>
        <a class="btn primary" routerLink="/cuenta">Contratar un servicio</a>
      </section>
    }

    @if (lista().length) {
      <section class="bloque">
        <div class="b-cab">
          <h2>Mis servicios</h2>
          <span class="viv" [class.on]="rt.conectado()"><i></i> {{ rt.conectado() ? 'En vivo' : 'Reconectando…' }}</span>
        </div>
        @if (mensaje()) { <p class="banner ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
        @if (error()) { <p class="banner bad"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

        @if (todasSesiones().length) { <app-mi-calendario [sesiones]="todasSesiones()" /> }

        <div class="srvs">
          @for (s of lista(); track s.id) {
            @let prox = proxima(s);
            <article class="srv">
              <div class="s-top">
                <span class="s-ico"><app-icon name="package" [size]="20" /></span>
                <div class="s-tit"><h3>{{ s.servicio_nombre }}</h3><small>Contratado el {{ fechaCorta(s.creado_en) }}</small></div>
                <span class="estado" [class.ok]="s.estado === 'entregado'" [class.azul]="s.estado === 'en_curso'">{{ estadoServicio(s.estado) }}</span>
              </div>

              <div class="avance">
                <div class="barra"><span [style.width.%]="s.progreso"></span></div>
                <small><b>{{ s.progreso }}%</b> completado
                  @if (s.sesiones_incluidas > 0) { · {{ realizadas(s) }} de {{ s.sesiones_incluidas }} sesiones realizadas }
                </small>
              </div>

              @if (prox) {
                <div class="prox">
                  <span class="p-ico"><app-icon name="calendar" [size]="20" /></span>
                  <div><b>Tu próxima sesión</b><span>{{ fechaHora(prox.inicio) }} · con {{ prox.asesor }}</span></div>
                  @if (puedeUnirse(prox)) {
                    <a class="btn primary" [href]="prox.enlace" target="_blank" rel="noopener"><app-icon name="video" [size]="16" /> Unirme ahora</a>
                  }
                </div>
              }

              @if (s.pendientes_agendar > 0) {
                <div class="cta">
                  <p>Te {{ s.pendientes_agendar === 1 ? 'queda' : 'quedan' }} <b>{{ s.pendientes_agendar }}</b>
                    {{ s.pendientes_agendar === 1 ? 'sesión' : 'sesiones' }} por agendar ({{ s.duracion_min }} min cada una).</p>
                  <button type="button" class="btn primary" (click)="abrirAg(s.id, null)"><app-icon name="calendar" [size]="16" /> Agendar sesión</button>
                </div>
              }

              @if (visibles(s).length) {
                <h4>Sesiones</h4>
                <ul class="sess">
                  @for (x of visibles(s); track x.id) {
                    <li class="ses">
                      <div class="x-top">
                        <b>{{ fechaHora(x.inicio) }}</b><small>a {{ hora(x.fin) }}</small>
                        <span class="estado" [class.ok]="x.estado === 'realizada'" [class.azul]="x.estado === 'programada'" [class.bad]="x.estado === 'no_asistio'">{{ estadoSesion(x.estado) }}</span>
                      </div>
                      <small>Con {{ x.asesor }} · {{ plataforma(x.plataforma) }}</small>
                      @if (x.estado === 'programada') {
                        <div class="x-acc">
                          @if (puedeUnirse(x)) {
                            <a class="btn primary" [href]="x.enlace" target="_blank" rel="noopener"><app-icon name="video" [size]="15" /> Unirme</a>
                          } @else if (x.enlace) {
                            <a class="btn" [href]="x.enlace" target="_blank" rel="noopener"><app-icon name="link" [size]="15" /> Ver enlace</a>
                          }
                          @if (x.puede_cambiar) {
                            <button type="button" class="btn" (click)="abrirAg(s.id, x.id)">Reprogramar</button>
                            <button type="button" class="btn peligro" (click)="cancelar(x)">Cancelar</button>
                          } @else {
                            <small class="limite">Cambios hasta {{ reglas().cancelacion_horas }} h antes de la sesión</small>
                          }
                        </div>
                      }
                    </li>
                  }
                </ul>
              }

              <h4>Qué incluye tu servicio</h4>
              <ul class="ents">
                @for (e of s.entregables; track e.id) {
                  <li [class.hecho]="e.estado === 'hecho'">
                    <span class="chk" [class.ok]="e.estado === 'hecho'" [class.cur]="e.estado === 'en_curso'">
                      @if (e.estado === 'hecho') { <app-icon name="check" [size]="13" /> }
                    </span>
                    <div><b>{{ e.titulo }}</b>@if (e.nota) { <small>{{ e.nota }}</small> }</div>
                    <span class="et" [class.ok]="e.estado === 'hecho'" [class.azul]="e.estado === 'en_curso'">{{ estadoEnt(e.estado) }}</span>
                  </li>
                } @empty { <li class="vacio-e">Tu asesor irá registrando aquí lo que se te entrega.</li> }
              </ul>
            </article>
          }
        </div>
      </section>
    }

    @if (ag(); as g) {
      <div class="overlay" (click)="cerrarAg()">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Agendar sesión" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>{{ g.sesionId ? 'Reprogramar sesión' : 'Agendar sesión' }}</h3>
            <button type="button" class="x" aria-label="Cerrar" (click)="cerrarAg()"><app-icon name="x" [size]="18" /></button>
          </header>

          @if (g.cargando) {
            <p class="nota">Buscando horarios disponibles…</p>
          } @else if (!dias().length) {
            <p class="nota">Por ahora no hay horarios libres. Vuelve a intentarlo pronto o escríbenos.</p>
          } @else {
            @if (error()) { <p class="m-err">{{ error() }}</p> }
            <p class="nota">Elige el día y la hora (hora de Lima).</p>
            <div class="dias">
              @for (d of dias(); track d.clave) {
                <button type="button" class="dia" [class.on]="g.dia === d.clave" (click)="elegirDia(d.clave)">
                  {{ d.etiqueta }}<small>{{ d.slots.length }} {{ d.slots.length === 1 ? 'horario' : 'horarios' }}</small>
                </button>
              }
            </div>
            @if (g.dia) {
              <div class="slots">
                @for (s of slotsDia(); track s.inicio) {
                  <button type="button" class="slot" [class.on]="g.elegido?.inicio === s.inicio" (click)="elegirSlot(s)">{{ hora(s.inicio) }}</button>
                }
              </div>
            }
          }

          @if (g.elegido; as e) {
            <div class="conf">
              <p><app-icon name="calendar" [size]="16" /> {{ fechaHora(e.inicio) }} a {{ hora(e.fin) }}</p>
              <button type="button" class="btn primary" [disabled]="guardando()" (click)="confirmar()">
                {{ guardando() ? 'Guardando…' : (g.sesionId ? 'Confirmar nuevo horario' : 'Confirmar sesión') }}
              </button>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; color: #0f172a; --brand: #1d4ed8; --line: #e2e8f4; --muted: #5a6784; --soft: #eef2ff; }
    * { box-sizing: border-box; }
    .bloque { margin-top: 30px; } .b-cab { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; } h2 { margin: 0; font-size: 1.15rem; }
    .viv { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; border-radius: 999px; background: #fef3c7; color: #b45309; font-size: .75rem; font-weight: 600; }
    .viv i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; } .viv.on { background: #d1fae5; color: #047857; }
    .banner { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 12px 16px; border-radius: 12px; font-size: .9rem; } .banner.ok { background: #d1fae5; color: #047857; } .banner.bad { background: #fef2f2; color: #b91c1c; }
    .srvs { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }
    .srv { display: flex; flex-direction: column; gap: 14px; padding: 20px; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
    .s-top { display: flex; align-items: flex-start; gap: 12px; } .s-ico { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; color: var(--brand); background: var(--soft); flex: none; }
    .s-tit { flex: 1; min-width: 0; } .s-tit h3 { margin: 0; font-size: 1rem; line-height: 1.35; } .s-tit small { color: var(--muted); }
    .estado { padding: 3px 10px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: .72rem; font-weight: 700; white-space: nowrap; }
    .estado.ok { background: #d1fae5; color: #047857; } .estado.azul { background: #dbeafe; color: #1d4ed8; } .estado.bad { background: #fee2e2; color: #b91c1c; }
    .barra { height: 8px; border-radius: 999px; background: #e8edf8; overflow: hidden; margin-bottom: 6px; } .barra span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #1d4ed8, #2f6bff); transition: width .5s; }
    .avance small { color: var(--muted); font-size: .82rem; }
    .prox { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; background: linear-gradient(135deg, #eef3ff, #f7f9ff); border: 1px solid #c7d6fb; border-radius: 14px; }
    .p-ico { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; color: #fff; background: var(--brand); flex: none; } .prox div { flex: 1; min-width: 160px; display: flex; flex-direction: column; } .prox span:not(.p-ico) { color: #334155; font-size: .86rem; }
    .cta { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; background: #fff8eb; border: 1px solid #fde1a8; border-radius: 14px; } .cta p { margin: 0; font-size: .88rem; color: #7c4a03; }
    h4 { margin: 4px 0 0; font-size: .78rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
    .sess, .ents { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .ses { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; } .ses small { color: var(--muted); }
    .x-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .x-acc { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .limite { font-size: .76rem; }
    .ents li { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border-radius: 12px; background: #fafbfe; } .ents li.hecho { background: #f3fbf7; }
    .ents li div { flex: 1; min-width: 0; display: flex; flex-direction: column; } .ents b { font-size: .88rem; line-height: 1.4; font-weight: 600; } .ents small { color: var(--muted); }
    .chk { display: grid; place-items: center; width: 20px; height: 20px; margin-top: 1px; border: 1.5px solid #b5c2e0; border-radius: 50%; color: #fff; flex: none; } .chk.ok { background: #059669; border-color: #059669; } .chk.cur { border-color: var(--brand); box-shadow: inset 0 0 0 4px #dbe6ff; }
    .et { padding: 2px 9px; border-radius: 999px; background: #eef1f6; color: #64748b; font-size: .7rem; font-weight: 700; white-space: nowrap; } .et.ok { background: #d1fae5; color: #047857; } .et.azul { background: #dbeafe; color: #1d4ed8; }
    .vacio-e { color: var(--muted); font-size: .86rem; background: none !important; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #0f172a; font: inherit; font-size: .84rem; font-weight: 600; text-decoration: none; cursor: pointer; transition: .15s; }
    .btn:hover:not(:disabled) { border-color: #b5c2e0; } .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #1d4ed8, #2f6bff); box-shadow: 0 10px 22px -12px rgb(29 78 216 / .8); } .btn.peligro { color: #b91c1c; } .btn.peligro:hover { background: #fef2f2; border-color: #fecaca; }
    .overlay { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; padding: 16px; background: rgb(10 26 58 / .55); overflow-y: auto; }
    .modal { width: min(560px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 22px; background: #fff; border-radius: 20px; box-shadow: 0 40px 90px -30px rgb(0 0 0 / .6); }
    .m-cab { display: flex; justify-content: space-between; align-items: center; } .m-cab h3 { margin: 0; font-size: 1.15rem; }
    .x { display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 10px; background: none; color: var(--muted); cursor: pointer; } .x:hover { background: #f1f2f8; color: #0f172a; }
    .m-err { margin: 0; padding: 10px 14px; border-radius: 10px; background: #fef3c7; color: #92400e; font-size: .88rem; font-weight: 600; }
    .nota { margin: 0; color: var(--muted); font-size: .88rem; }
    .dias { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; }
    .dia { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 96px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: #fff; font: inherit; font-size: .84rem; font-weight: 700; text-transform: capitalize; cursor: pointer; flex: none; }
    .dia small { font-weight: 500; color: var(--muted); text-transform: none; font-size: .72rem; } .dia.on { background: var(--soft); border-color: var(--brand); color: var(--brand); }
    .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 8px; }
    .slot { padding: 11px 6px; border: 1px solid var(--line); border-radius: 12px; background: #fff; font: inherit; font-weight: 700; cursor: pointer; transition: .15s; } .slot:hover { border-color: var(--brand); } .slot.on { background: var(--brand); border-color: var(--brand); color: #fff; }
    .conf { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--line); } .conf p { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-weight: 600; }
    .vacio-s { display: grid; justify-items: center; gap: 10px; padding: 60px 20px; text-align: center; background: #fff; border: 1px dashed #c3cde6; border-radius: 18px; }
    .vacio-s h3 { margin: 0; } .vacio-s p { margin: 0; max-width: 420px; color: var(--muted); }
    .vs-ico { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 18px; color: var(--brand); background: var(--soft); }
    @media (max-width: 560px) { .srvs { grid-template-columns: 1fr; } }
  `],
})
export class MisServiciosComponent implements OnInit {
  private readonly api: MisServiciosService = inject(MisServiciosService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);
  readonly rt: TiempoRealService = inject(TiempoRealService);
  /** perucompras, menor o mayor; "general" = servicios que no están asignados a ningún módulo. */
  readonly modulo = input<string>('general');
  readonly mostrarVacio = input<boolean>(false);

  readonly datos = signal<MisServicios | null>(null);
  readonly ahora = signal<number>(Date.now());
  readonly ag = signal<Agenda | null>(null);
  readonly guardando = signal<boolean>(false);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');

  readonly lista = computed<ServicioCli[]>(() => this.datos()?.servicios ?? []);
  readonly reglas = computed(() => this.datos()?.reglas ?? { cancelacion_horas: 24, antelacion_horas: 12 });
  readonly todasSesiones = computed<SesionAgenda[]>(() => this.lista().flatMap((s) => s.sesiones
    .filter((x) => x.estado !== 'cancelada')
    .map((x) => ({ id: x.id, inicio: x.inicio, fin: x.fin, estado: x.estado, asesor: x.asesor, enlace: x.enlace, servicio: s.servicio_nombre }))));

  readonly dias = computed(() => {
    const g = this.ag();
    if (!g) return [];
    const mapa = new Map<string, SlotCli[]>();
    for (const s of g.slots) {
      const k = this.claveDia(s.inicio);
      mapa.set(k, [...(mapa.get(k) ?? []), s]);
    }
    return [...mapa].map(([clave, slots]) => ({ clave, etiqueta: this.etiquetaDia(slots[0].inicio), slots }));
  });
  readonly slotsDia = computed<SlotCli[]>(() => this.dias().find((d) => d.clave === this.ag()?.dia)?.slots ?? []);

  constructor() {
    const t = setInterval(() => this.ahora.set(Date.now()), 30_000);  // habilita "Unirme" justo a tiempo
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: lo que el asesor marque o mueva aparece al instante
    this.rt.cambios('servicio', 'horarios').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.alCambiar());
  }

  /** Cambió un servicio, un horario de asesor o alguien agendó: se actualiza todo, incluida la ventana abierta. */
  private alCambiar(): void {
    this.cargar();
    const g = this.ag();
    if (g && !this.guardando()) this.refrescarAg(g.pid);
  }

  /** Vuelve a pedir los horarios libres sin cerrar la ventana que el cliente tiene abierta. */
  private refrescarAg(pid: number): void {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
    this.api.horarios(pid, hoy, 21).subscribe({
      next: (sl) => {
        const g = this.ag();
        if (!g || g.pid !== pid) return;
        const dias = new Set(sl.map((s) => this.claveDia(s.inicio)));
        const dia = g.dia && dias.has(g.dia) ? g.dia : (sl.length ? this.claveDia(sl[0].inicio) : null);
        const sigue = !g.elegido || sl.some((s) => s.inicio === g.elegido?.inicio);
        if (!sigue) { this.mensaje.set(''); this.error.set('El horario que elegiste se acaba de ocupar. Elige otro.'); }
        this.ag.set({ ...g, slots: sl, cargando: false, dia, elegido: sigue ? g.elegido : null });
      },
      error: () => undefined,
    });
  }

  private cargar(): void {
    this.api.lista(this.modulo()).subscribe({ next: (d) => this.datos.set(d), error: () => undefined });
  }

  // ---------------- Formato ----------------
  estadoServicio(e: string): string { return ESTADO_SERVICIO[e] ?? e; }
  estadoSesion(e: string): string { return ESTADO_SESION[e] ?? e; }
  estadoEnt(e: string): string { return ESTADO_ENT[e] ?? e; }
  plataforma(p: string): string { return PLATAFORMA[p] ?? 'Videollamada'; }
  fechaCorta(iso: string): string { return new Date(iso).toLocaleDateString('es-PE', { timeZone: ZONA, day: '2-digit', month: 'short', year: 'numeric' }); }
  fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-PE', { timeZone: ZONA, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  hora(iso: string): string { return new Date(iso).toLocaleTimeString('es-PE', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false }); }
  private claveDia(iso: string): string { return new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONA }); }
  private etiquetaDia(iso: string): string {
    return new Date(iso).toLocaleDateString('es-PE', { timeZone: ZONA, weekday: 'short', day: '2-digit', month: 'short' });
  }

  // ---------------- Estado de cada servicio ----------------
  realizadas(s: ServicioCli): number { return s.sesiones.filter((x) => x.estado === 'realizada').length; }
  visibles(s: ServicioCli): SesionCli[] { return s.sesiones.filter((x) => x.estado !== 'cancelada'); }

  proxima(s: ServicioCli): SesionCli | null {
    const t = this.ahora();
    return s.sesiones
      .filter((x) => x.estado === 'programada' && new Date(x.fin).getTime() > t)
      .sort((a, b) => a.inicio.localeCompare(b.inicio))[0] ?? null;
  }

  /** "Unirme" se habilita 15 minutos antes y hasta 30 minutos después del final. */
  puedeUnirse(x: SesionCli): boolean {
    const t = this.ahora();
    return x.estado === 'programada' && !!x.enlace
      && t >= new Date(x.inicio).getTime() - 15 * 60_000 && t <= new Date(x.fin).getTime() + 30 * 60_000;
  }

  // ---------------- Agendar, reprogramar y cancelar ----------------
  abrirAg(pid: number, sesionId: number | null): void {
    this.mensaje.set(''); this.error.set('');
    this.ag.set({ pid, sesionId, slots: [], cargando: true, dia: null, elegido: null });
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
    this.api.horarios(pid, hoy, 21).subscribe({
      next: (sl) => this.ag.update((g) => (g ? { ...g, slots: sl, cargando: false, dia: sl.length ? this.claveDia(sl[0].inicio) : null } : g)),
      error: (e: HttpErrorResponse) => { this.ag.update((g) => (g ? { ...g, cargando: false } : g)); this.error.set(this.msg(e)); },
    });
  }

  cerrarAg(): void { this.ag.set(null); }
  elegirDia(clave: string): void { this.ag.update((g) => (g ? { ...g, dia: clave, elegido: null } : g)); }
  elegirSlot(s: SlotCli): void { this.error.set(''); this.ag.update((g) => (g ? { ...g, elegido: s } : g)); }

  confirmar(): void {
    const g = this.ag();
    if (!g || !g.elegido || this.guardando()) return;
    this.guardando.set(true);
    const obs = g.sesionId === null
      ? this.api.agendar(g.pid, g.elegido.inicio)
      : this.api.cambiar(g.sesionId, { accion: 'reprogramar', inicio: g.elegido.inicio });
    obs.subscribe({
      next: () => {
        this.guardando.set(false);
        this.ag.set(null);
        this.mensaje.set('Listo. Te enviamos un correo con la fecha, la hora y el enlace de tu sesión.');
        this.cargar();
      },
      error: (e: HttpErrorResponse) => {
        this.guardando.set(false);
        this.error.set(this.msg(e));
        this.abrirAg(g.pid, g.sesionId);  // el horario pudo ocuparse: se vuelve a mostrar la lista
      },
    });
  }

  cancelar(x: SesionCli): void {
    if (!confirm('¿Cancelar esta sesión? Podrás agendar otra mientras te queden sesiones incluidas.')) return;
    this.api.cambiar(x.id, { accion: 'cancelar' }).subscribe({
      next: () => { this.error.set(''); this.mensaje.set('Sesión cancelada.'); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.mensaje.set(''); this.error.set(this.msg(e)); },
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : 'No se pudo conectar con el servidor';
  }
}