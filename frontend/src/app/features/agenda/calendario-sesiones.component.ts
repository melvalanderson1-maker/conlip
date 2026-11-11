import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { TiempoRealService } from '../../core/tiempo-real.service';
import { IconComponent } from '../../shared/icon.component';
import { AgendaAdminService, Asesor, SesionCal } from './agenda-admin.service';

const ZONA = 'America/Lima';
const H_INI = 6;
const H_FIN = 22;
const PX_HORA = 56;
const PX_MIN = PX_HORA / 60;
const NOMBRES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function hoyISO(): string { return new Date().toLocaleDateString('en-CA', { timeZone: ZONA }); }
function sumar(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lunesDe(iso: string): string { return sumar(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7)); }
function minutosDe(iso: string): number {
  const [h, m] = new Date(iso).toLocaleTimeString('en-GB', { timeZone: ZONA, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return h * 60 + m;
}
function diaDe(iso: string): string { return new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONA }); }
const aMin = (h: string): number => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));

@Component({
  selector: 'app-calendario-sesiones',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cal">
      <div class="top">
        <div class="nav">
          <button type="button" class="btn ico" aria-label="Semana anterior" (click)="semana(-1)"><app-icon name="left" [size]="16" /></button>
          <button type="button" class="btn" (click)="hoySemana()">Hoy</button>
          <button type="button" class="btn ico" aria-label="Semana siguiente" (click)="semana(1)"><app-icon name="right" [size]="16" /></button>
          <b class="rango">{{ rango() }}</b>
        </div>
        <select aria-label="Asesor" (change)="setFiltro($any($event.target).value)">
          <option value="" [selected]="filtro() === null">Todos los asesores</option>
          @for (a of asesores(); track a.id) { <option [value]="'' + a.id" [selected]="filtro() === a.id">{{ a.nombre }}</option> }
        </select>
      </div>

      <div class="chips-res">
        <span class="res"><app-icon name="calendar" [size]="15" /> {{ programadas() }} programadas esta semana</span>
        @if (porConfirmar() > 0) { <span class="res aviso"><app-icon name="alert" [size]="15" /> {{ porConfirmar() }} por confirmar (ya pasaron)</span> }
        <span class="ley"><i class="l-libre"></i> Horario de atención</span>
        <span class="ley"><i class="l-pend"></i> Por confirmar</span>
        <span class="ley hint">Arrastra una sesión para reprogramarla</span>
      </div>

      @if (mensaje()) { <p class="msg ok"><app-icon name="circle-check" [size]="16" /> {{ mensaje() }}</p> }
      @if (error()) { <p class="msg bad"><app-icon name="alert" [size]="16" /> {{ error() }}</p> }

      <div class="grilla">
        <div class="cabeza">
          <span></span>
          @for (d of dias(); track d.clave) {
            <div class="dh" [class.hoy]="d.clave === hoy()"><small>{{ d.nombre }}</small><b>{{ d.num }}</b></div>
          }
        </div>
        <div class="cuerpo">
          <div class="gutter" [style.height.px]="alto">
            @for (h of horas; track h) { <span [style.top.px]="(h - horaIni) * pxHora">{{ h }}:00</span> }
          </div>
          @for (d of dias(); track d.clave) {
            <div class="col" [class.hoy]="d.clave === hoy()" [style.height.px]="alto"
                 (dragover)="$event.preventDefault()" (drop)="alSoltar($event, d.clave)">
              @for (s of sombras(d.indice); track $index) {
                <div class="libre" [style.top.px]="s.top" [style.height.px]="s.alto"></div>
              }
              @for (s of delDia(d.clave); track s.id) {
                <button type="button" class="ses" [style.top.px]="top(s)" [style.height.px]="altoSes(s)" [style.--c]="s.color"
                        [class.hecha]="s.estado === 'realizada'" [class.falta]="s.estado === 'no_asistio'" [class.pend]="sinConfirmar(s)"
                        [attr.draggable]="s.estado === 'programada'" (dragstart)="alArrastrar($event, s)" (click)="abrirPedido.emit(s.pedido_id)"
                        [attr.title]="s.cliente + ' · ' + s.servicio_nombre + ' · ' + s.asesor">
                  <b>{{ hora(s.inicio) }}</b> {{ s.cliente }}
                  <small>{{ s.servicio_nombre }}</small>
                </button>
              }
              @if (d.clave === hoy() && enRango()) { <div class="ahora" [style.top.px]="topAhora()"></div> }
            </div>
          }
        </div>
      </div>
      @if (cargando()) { <small class="cargando">Actualizando…</small> }
    </div>
  `,
  styles: [`
    :host { display: block; --brand: #1d4ed8; --line: #e2e8f4; --muted: #5a6784; }
    * { box-sizing: border-box; }
    .cal { display: flex; flex-direction: column; gap: 12px; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; } .nav { display: flex; align-items: center; gap: 8px; } .rango { margin-left: 8px; font-size: 1.05rem; text-transform: capitalize; }
    .btn { display: inline-flex; align-items: center; justify-content: center; height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #0f172a; font: inherit; font-size: .86rem; font-weight: 600; cursor: pointer; } .btn.ico { width: 38px; padding: 0; } .btn:hover { border-color: #b5c2e0; }
    select { height: 40px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 10px; font: inherit; background: #fff; }
    .chips-res { display: flex; align-items: center; gap: 10px 18px; flex-wrap: wrap; font-size: .82rem; color: var(--muted); }
    .res { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: #eef2ff; color: var(--brand); font-weight: 600; } .res.aviso { background: #fef3c7; color: #b45309; }
    .ley { display: inline-flex; align-items: center; gap: 6px; } .ley i { width: 14px; height: 14px; border-radius: 4px; display: inline-block; } .l-libre { background: rgb(16 185 129 / .25); } .l-pend { background: #fef3c7; border: 2px solid #f59e0b; } .hint { margin-left: auto; font-style: italic; }
    .msg { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border-radius: 10px; font-size: .88rem; } .msg.ok { background: #d1fae5; color: #047857; } .msg.bad { background: #fef2f2; color: #b91c1c; }
    .grilla { background: #fff; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
    .cabeza, .cuerpo { display: grid; grid-template-columns: 56px repeat(7, minmax(0, 1fr)); }
    .cabeza { border-bottom: 1px solid var(--line); background: #f8faff; } .dh { padding: 10px 6px; text-align: center; border-left: 1px solid #eef1f8; } .dh small { display: block; color: var(--muted); font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; }
    .dh b { display: grid; place-items: center; width: 34px; height: 34px; margin: 2px auto 0; border-radius: 50%; font-size: 1.05rem; } .dh.hoy b { color: #fff; background: var(--brand); }
    .cuerpo { max-height: 70vh; overflow-y: auto; }
    .gutter { position: relative; } .gutter span { position: absolute; right: 8px; transform: translateY(-50%); font-size: .7rem; color: var(--muted); } .gutter span:first-child { transform: translateY(2px); }
    .col { position: relative; border-left: 1px solid #eef1f8; background-image: repeating-linear-gradient(to bottom, transparent 0 55px, #eef1f8 55px 56px); } .col.hoy { background-color: #fbfcff; }
    .libre { position: absolute; left: 0; right: 0; background: rgb(16 185 129 / .1); pointer-events: none; }
    .ses { position: absolute; left: 3px; right: 3px; z-index: 2; display: block; overflow: hidden; padding: 3px 6px; text-align: left; border: 0; border-left: 4px solid var(--c, #1d4ed8); border-radius: 8px;
      background: color-mix(in srgb, var(--c, #1d4ed8) 15%, white); color: #0f172a; font: inherit; font-size: .74rem; line-height: 1.3; cursor: pointer; box-shadow: 0 2px 6px -3px rgb(10 26 58 / .4); }
    .ses[draggable='true'] { cursor: grab; } .ses[draggable='true']:active { cursor: grabbing; opacity: .7; } .ses:hover { z-index: 3; box-shadow: 0 8px 18px -8px rgb(10 26 58 / .5); }
    .ses small { display: block; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ses.hecha { background: #e6f7ee; border-left-color: #059669; } .ses.falta { background: #fde8e8; border-left-color: #dc2626; }
    .ses.pend { background: #fff6dc; outline: 2px solid #f59e0b; outline-offset: -2px; }
    .ahora { position: absolute; left: 0; right: 0; z-index: 4; height: 2px; background: #ef4444; pointer-events: none; } .ahora::before { content: ''; position: absolute; left: -4px; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: #ef4444; }
    .cargando { color: var(--muted); }
  `],
})
export class CalendarioSesionesComponent implements OnInit {
  private readonly api: AgendaAdminService = inject(AgendaAdminService);
  private readonly rt: TiempoRealService = inject(TiempoRealService);
  private readonly destroyRef: DestroyRef = inject(DestroyRef);

  readonly asesores = input<Asesor[]>([]);
  readonly abrirPedido = output<number>();

  readonly horaIni = H_INI;
  readonly pxHora = PX_HORA;
  readonly horas = Array.from({ length: H_FIN - H_INI }, (_, i) => H_INI + i);
  readonly alto = (H_FIN - H_INI) * PX_HORA;

  readonly lunes = signal<string>(lunesDe(hoyISO()));
  readonly filtro = signal<number | null>(null);
  readonly sesiones = signal<SesionCal[]>([]);
  readonly cargando = signal<boolean>(false);
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');
  readonly hoy = signal<string>(hoyISO());
  readonly ahoraMin = signal<number>(minutosDe(new Date().toISOString()));
  private arrastrando: { id: number; offsetY: number } | null = null;

  readonly dias = computed(() => Array.from({ length: 7 }, (_, i) => {
    const clave = sumar(this.lunes(), i);
    return { clave, nombre: NOMBRES[i], num: Number(clave.slice(8)), indice: i };
  }));

  readonly rango = computed<string>(() => {
    const d = this.dias();
    const f = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-PE', { timeZone: 'UTC', day: '2-digit', month: 'short' });
    return `${f(d[0].clave)} – ${f(d[6].clave)} ${d[6].clave.slice(0, 4)}`;
  });

  readonly porDia = computed(() => {
    const m = new Map<string, SesionCal[]>();
    for (const s of this.sesiones()) { const k = diaDe(s.inicio); m.set(k, [...(m.get(k) ?? []), s]); }
    return m;
  });
  readonly programadas = computed<number>(() => this.sesiones().filter((s) => s.estado === 'programada').length);
  readonly porConfirmar = computed<number>(() => this.sesiones().filter((s) => this.sinConfirmar(s)).length);
  readonly enRango = computed<boolean>(() => this.ahoraMin() >= H_INI * 60 && this.ahoraMin() <= H_FIN * 60);

  constructor() {
    const t = setInterval(() => { this.ahoraMin.set(minutosDe(new Date().toISOString())); this.hoy.set(hoyISO()); }, 60_000);
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  ngOnInit(): void {
    this.cargar();
    // Tiempo real: cualquier cambio de agenda actualiza el calendario
    this.rt.cambios('agenda', 'horarios').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.cargar());
  }

  private cargar(): void {
    const desde = new Date(`${this.lunes()}T00:00:00-05:00`).toISOString();
    const hasta = new Date(`${sumar(this.lunes(), 7)}T00:00:00-05:00`).toISOString();
    this.cargando.set(true);
    this.api.sesiones(desde, hasta, this.filtro()).subscribe({
      next: (l) => { this.sesiones.set(l); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.cargando.set(false); this.error.set(this.msg(e)); },
    });
  }

  semana(n: number): void { this.lunes.set(sumar(this.lunes(), 7 * n)); this.cargar(); }
  hoySemana(): void { this.lunes.set(lunesDe(hoyISO())); this.cargar(); }
  setFiltro(v: string): void { this.filtro.set(v ? Number(v) : null); this.cargar(); }

  // ---------------- Posiciones ----------------
  hora(iso: string): string { return new Date(iso).toLocaleTimeString('es-PE', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false }); }
  delDia(clave: string): SesionCal[] { return this.porDia().get(clave) ?? []; }
  top(s: SesionCal): number { return Math.max(0, (minutosDe(s.inicio) - H_INI * 60) * PX_MIN); }
  altoSes(s: SesionCal): number { return Math.max(24, ((new Date(s.fin).getTime() - new Date(s.inicio).getTime()) / 60_000) * PX_MIN - 2); }
  topAhora(): number { return (this.ahoraMin() - H_INI * 60) * PX_MIN; }
  sinConfirmar(s: SesionCal): boolean { return s.estado === 'programada' && new Date(s.fin).getTime() < Date.now(); }

  /** Franjas de atención de los asesores (o del asesor filtrado) para ese día de la semana. */
  sombras(indice: number): { top: number; alto: number }[] {
    const f = this.filtro();
    return this.asesores()
      .filter((a) => a.activo && (f === null || a.id === f))
      .flatMap((a) => a.horarios.filter((h) => h.dia === indice).map((h) => ({
        top: (aMin(h.inicio) - H_INI * 60) * PX_MIN, alto: (aMin(h.fin) - aMin(h.inicio)) * PX_MIN,
      })));
  }

  // ---------------- Arrastrar para reprogramar ----------------
  alArrastrar(ev: DragEvent, s: SesionCal): void {
    if (s.estado !== 'programada') { ev.preventDefault(); return; }
    this.arrastrando = { id: s.id, offsetY: ev.offsetY };
    ev.dataTransfer?.setData('text/plain', String(s.id));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }

  alSoltar(ev: DragEvent, dia: string): void {
    ev.preventDefault();
    const a = this.arrastrando;
    this.arrastrando = null;
    if (!a) return;
    const s = this.sesiones().find((x) => x.id === a.id);
    if (!s) return;
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    let min = H_INI * 60 + (ev.clientY - rect.top - a.offsetY) / PX_MIN;
    min = Math.min(Math.max(Math.round(min / 15) * 15, H_INI * 60), H_FIN * 60 - 15);
    const hh = String(Math.floor(min / 60)).padStart(2, '0');
    const mm = String(min % 60).padStart(2, '0');
    const nuevo = new Date(`${dia}T${hh}:${mm}:00-05:00`);  // Lima no usa horario de verano
    if (nuevo.getTime() === new Date(s.inicio).getTime()) return;
    if (!confirm(`¿Mover la sesión de ${s.cliente} al ${dia} a las ${hh}:${mm}? Se avisará al cliente y al asesor por correo.`)) return;
    this.mensaje.set(''); this.error.set('');
    this.api.editarSesion(s.id, { inicio: nuevo.toISOString() }).subscribe({
      next: () => { this.mensaje.set('Sesión reprogramada. Se envió el aviso por correo.'); this.cargar(); },
      error: (e: HttpErrorResponse) => { this.error.set(this.msg(e)); this.cargar(); },
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    return typeof d === 'string' ? d : 'No se pudo conectar con el servidor';
  }
}